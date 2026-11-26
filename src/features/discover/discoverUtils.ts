import type { HfInstalledFile } from "../../shared/api/models.ts";
import type { HfFile, HfSnapshotFile } from "../../shared/api/types.ts";
import type { ModelArtifact } from "../../shared/api/providers.ts";
import { formatModelShardPart, parseModelShardSuffix, type ParseModelShardOptions } from "../../shared/lib/displayPaths.ts";

const SAFE_HF_COMPONENT = /^[^<>:"|?*\u0000-\u001f]+$/;

/** Repository GGUF names accept any extension case; the other rules match the Rust parser. */
const GGUF_SHARD: ParseModelShardOptions = { extensions: ['gguf'], allowExtensionless: false };
/** Safetensors repository paths are exact: only the lowercase extension names a split group. */
const SAFETENSORS_SHARD: ParseModelShardOptions = { extensions: ['safetensors'], allowExtensionless: false, exactExtensionCase: true };

/** Split a repository path into its folder prefix and the parsed part of its file name. */
function splitShardFile(path: string, options: ParseModelShardOptions) {
  const name = path.split("/").pop() ?? path;
  return { folder: path.slice(0, path.length - name.length), shard: parseModelShardSuffix(name, options) };
}

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
 * `-00001-of-00033.gguf` (or four-digit `-0001-of-0033.gguf`) suffix. Null for
 * a single-file model.
 */
export function shardTotal(path: string): number | null {
  return splitShardFile(path, GGUF_SHARD).shard?.total ?? null;
}

export function firstShard(path: string): string {
  const { folder, shard } = splitShardFile(path, GGUF_SHARD);
  return shard ? `${folder}${formatModelShardPart(shard, 1)}` : path;
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
      const { folder, shard } = splitShardFile(file.path, GGUF_SHARD);
      groups.set(key, { file: { ...file, path: key }, files: [file], sizeBytes: file.size_bytes,
        displayPath: shard ? `${folder}${shard.base}.${shard.extension ?? 'gguf'}` : file.path });
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
    const { folder, shard } = splitShardFile(file.path, SAFETENSORS_SHARD);
    const resolved = membership.get(file.path);
    const key = resolved?.canonical ?? (shard ? `${folder}${formatModelShardPart(shard, 1)}` : file.path);
    const group = groups.get(key);
    if (group) {
      if (group.files.some(part => part.path === file.path)) continue;
      group.files.push(file);
      group.sizeBytes += file.size_bytes;
      group.missingParts = group.shardCount - group.files.length;
      if (file.path === key) group.file = file;
    } else {
      const shardCount = resolved?.count ?? (shard ? shard.total : 1);
      groups.set(key, {
        file: { ...file, path: key }, files: [file], sizeBytes: file.size_bytes,
        displayPath: shard ? `${folder}${shard.base}.safetensors` : key,
        shardCount, missingParts: shardCount - 1,
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
  const { folder, shard } = splitShardFile(path, GGUF_SHARD);
  const total = shard?.total ?? null;
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
    missing_shards: shard && total ? Array.from({ length: total }, (_, index) => `${folder}${formatModelShardPart(shard, index + 1)}`)
      .filter(part => part !== path && !current[part]).map(part => part.split('/').pop()!) : [],
  };
  return next;
}

export { estimateDownloadSpeed, type DownloadSample } from "../../shared/lib/transfer.ts";
export { formatBytes, formatSpeedBps } from "../../shared/lib/units.ts";
