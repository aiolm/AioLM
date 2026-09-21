import type { HfInstalledFile } from "../../shared/api/models.ts";

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
  const match = name.match(/-\d{5}-of-(\d{5})\.gguf$/i);
  const total = match ? Number.parseInt(match[1], 10) : Number.NaN;
  return Number.isInteger(total) && total > 1 ? total : null;
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
  const sibling = Object.values(current).find((entry) => entry.missing_shards.includes(name));
  const next: Record<string, HfInstalledFile> = {};
  for (const [key, entry] of Object.entries(current)) {
    next[key] = { ...entry, missing_shards: entry.missing_shards.filter((part) => part !== name) };
  }
  next[path] = {
    path,
    local_path: localPath,
    size_bytes: sizeBytes,
    missing_shards: sibling ? sibling.missing_shards.filter((part) => part !== name) : [],
  };
  return next;
}

export { estimateDownloadSpeed, type DownloadSample } from "../../shared/lib/transfer.ts";
export { formatBytes, formatSpeedBps } from "../../shared/lib/units.ts";
