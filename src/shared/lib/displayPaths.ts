export function normalizeDisplayPath(value: string): string {
  const path = value.trim();
  const lower = path.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return `\\\\${path.slice(8)}`;
  if (lower.startsWith("\\\\?\\")) return path.slice(4);
  return path;
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
