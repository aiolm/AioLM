// Apply at presentation boundaries (including tooltips, diagnostics and copied paths).
// Keep stored paths and command arguments intact: Windows file access can need the prefix.
export function normalizeDisplayPath(value: string): string {
  const path = value.trim();
  const lower = path.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return `\\\\${path.slice(8)}`;
  if (lower.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** A model label groups GGUF shards; file access and API requests must use the original value. */
export function modelDisplayName(value: string): string {
  const path = normalizeDisplayPath(value);
  const name = path.split(/[\\/]/).pop() || path;
  const shard = /^(.+)-(\d{5})-of-(\d{5})(\.gguf)?$/i.exec(name);
  if (!shard) return name;
  const index = Number(shard[2]);
  const total = Number(shard[3]);
  return total > 1 && index > 0 && index <= total ? `${shard[1]}${shard[4] ?? ""}` : name;
}

/** Removes Windows verbatim path prefixes from arbitrary displayed text. */
export function normalizeDisplayText(value: string): string {
  return value
    // JSON and Rust debug output escape each backslash a second time.
    .replace(/\\{4}\?\\{2}UNC\\{2}/gi, "\\\\\\\\")
    .replace(/\\{4}\?\\{2}/g, "")
    .replace(/\\\\\?\\UNC\\/gi, "\\\\")
    .replace(/\\\\\?\\/g, "");
}

/** Keeps multiline argument/path editors readable without changing their stored values. */
export function normalizeDisplayPathLines(value: string): string {
  return value.split(/\r?\n/).map(normalizeDisplayText).join("\n");
}
