import type { HfInstalledFile } from "../../shared/api/models.ts";
import type { HfFile, HfSnapshotFile } from "../../shared/api/types.ts";
import type { ModelArtifact } from "../../shared/api/providers.ts";

const SAFE_HF_COMPONENT = /^[^<>:"|?*\u0000-\u001f]+$/;

export function validateHfRepoId(value: string): boolean {
  const repo = value.trim();
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((part) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(part));
}

export function validateHfPath(value: string): boolean {
  const path = value.trim();
  if (!path || path.startsWith("/") || path.includes("\\")) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && SAFE_HF_COMPONENT.test(part) && !part.endsWith(".") && !part.endsWith(" "));
}

export function isGgufPath(path: string): boolean {
  return path.toLowerCase().endsWith(".gguf");
}

export function isMmprojPath(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return name.startsWith("mmproj") && isGgufPath(name);
}

export function quantLabel(path: string): string {
  const name = path.split("/").pop() ?? path;
  const match = name.match(/(?:^|[-_])(Q\d+(?:_[A-Z0-9]+)*|IQ\d+(?:_[A-Z0-9]+)*|BF16|F16|F32)(?=[-_.]|$)/i);
  return match?.[1]?.toUpperCase() ?? "unknown";
}

/**
 * How many parts a multi-part GGUF has, read from its standard
 * `-00001-of-00033.gguf` suffix. Null for a single-file model.
 */
export function shardTotal(path: string): number | null {
  const name = path.split("/").pop() ?? path;
  const match = name.match(/^.+-(\d{5})-of-(\d{5})\.gguf$/i);
  const index = match ? Number(match[1]) : 0;
  const total = match ? Number(match[2]) : 0;
  return total > 1 && index > 0 && index <= total ? total : null;
}

export function firstShard(path: string): string {
  return shardTotal(path) ? path.replace(/-\d{5}-of-(\d{5})\.gguf$/i, '-00001-of-$1.gguf') : path;
}

export interface HfFileGroup {
  file: HfFile;
  files: HfFile[];
  displayPath: string;
  sizeBytes: number;
}

/** One download choice per model, keeping directories and quantizations separate. */
export function groupHfFiles(files: readonly HfFile[]): HfFileGroup[] {
  const groups = new Map<string, HfFileGroup>();
  for (const file of files) {
    const key = firstShard(file.path);
    const group = groups.get(key);
    if (group) {
      if (group.files.some(part => part.path === file.path)) continue;
      group.files.push(file);
      group.sizeBytes += file.size_bytes;
      if (file.path === key) group.file = file;
    } else {
      groups.set(key, { file: { ...file, path: key }, files: [file], sizeBytes: file.size_bytes,
        displayPath: shardTotal(file.path) ? file.path.replace(/-\d{5}-of-\d{5}(\.gguf)$/i, '$1') : file.path });
    }
  }
  return [...groups.values()].map(group => ({ ...group, files: group.files.sort((a, b) => a.path.localeCompare(b.path)) }));
}

export interface HfSafetensorsGroup {
  file: HfSnapshotFile;
  files: HfSnapshotFile[];
  displayPath: string;
  sizeBytes: number;
  shardCount: number;
  missingParts: number;
}

type SelectedBundle = Pick<ModelArtifact, 'selected_file' | 'selected_weight_files'>;

/** Whole snapshots never claim selected choices; selected metadata owns only its listed members. */
export function selectedBundleContains(bundle: SelectedBundle, path: string): boolean {
  return bundle.selected_file !== undefined
    && (bundle.selected_weight_files?.includes(path) ?? bundle.selected_file === path);
}

/** Standard splits group before installation; resolved index metadata groups exact original members. */
export function groupSafetensorsFiles(files: readonly HfSnapshotFile[], bundles: readonly SelectedBundle[] = []): HfSafetensorsGroup[] {
  const membership = new Map<string, { canonical: string; count: number }>();
  for (const bundle of bundles) {
    if (!bundle.selected_file || !bundle.selected_weight_files?.length) continue;
    const members = bundle.selected_weight_files;
    const canonical = members.reduce((first, path) => path < first ? path : first);
    for (const path of members) membership.set(path, { canonical, count: members.length });
  }
  const groups = new Map<string, HfSafetensorsGroup>();
  for (const file of files) {
    const match = file.path.match(/^(.+)-(\d{5})-of-(\d{5})\.safetensors$/);
    const index = match ? Number(match[2]) : 0;
    const total = match ? Number(match[3]) : 0;
    const split = total > 1 && index > 0 && index <= total;
    const resolved = membership.get(file.path);
    const key = resolved?.canonical ?? (split ? file.path.replace(/-\d{5}-of-(\d{5})\.safetensors$/, '-00001-of-$1.safetensors') : file.path);
    const group = groups.get(key);
    if (group) {
      if (group.files.some(part => part.path === file.path)) continue;
      group.files.push(file);
      group.sizeBytes += file.size_bytes;
      group.missingParts = group.shardCount - group.files.length;
      if (file.path === key) group.file = file;
    } else {
      groups.set(key, {
        file: { ...file, path: key }, files: [file], sizeBytes: file.size_bytes,
        displayPath: split ? file.path.replace(/-\d{5}-of-\d{5}(\.safetensors)$/, '$1') : key,
        shardCount: resolved?.count ?? (split ? total : 1), missingParts: (resolved?.count ?? (split ? total : 1)) - 1,
      });
    }
  }
  return [...groups.values()].map(group => ({ ...group, files: group.files.sort((a, b) => a.path.localeCompare(b.path)) }));
}

/**
 * Record a finished download in the installed-file map without waiting for a
 * fresh lookup, so the row that was just downloaded stops offering a download
 * the moment it completes.
 *
 * A multi-part GGUF is also one part closer to complete: the new file is
 * struck from every sibling's missing list, and inherits what is left, so the
 * immediate answer matches what the next lookup will report.
 */
export function markInstalled(
  current: Readonly<Record<string, HfInstalledFile>>,
  path: string,
  localPath: string,
  sizeBytes: number,
): Record<string, HfInstalledFile> {
  const name = path.split("/").pop() ?? path;
  const total = shardTotal(path);
  const group = firstShard(path);
  const next: Record<string, HfInstalledFile> = {};
  for (const [key, entry] of Object.entries(current)) {
    next[key] = firstShard(key) === group
      ? { ...entry, missing_shards: entry.missing_shards.filter((part) => part !== name) }
      : entry;
  }
  next[path] = {
    path,
    local_path: localPath,
    size_bytes: sizeBytes,
    missing_shards: total ? Array.from({ length: total }, (_, index) => path.replace(/-\d{5}-of-(\d{5})\.gguf$/i, `-${String(index + 1).padStart(5, '0')}-of-$1.gguf`))
      .filter(part => part !== path && !current[part]).map(part => part.split('/').pop()!) : [],
  };
  return next;
}

export { estimateDownloadSpeed, type DownloadSample } from "../../shared/lib/transfer.ts";
export { formatBytes, formatSpeedBps } from "../../shared/lib/units.ts";
