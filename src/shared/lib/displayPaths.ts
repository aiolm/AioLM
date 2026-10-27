// Apply at presentation boundaries (including tooltips, diagnostics and copied paths).
// Keep stored paths and command arguments intact: Windows file access can need the prefix.
export function normalizeDisplayPath(value: string): string {
  const path = value.trim();
  const lower = path.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return `\\\\${path.slice(8)}`;
  if (lower.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** POSIX absolute paths are case sensitive; retain existing Windows and legacy relative keys. */
export function modelPathIdentity(value: string): string {
  const path = normalizeDisplayPath(value);
  return path.startsWith('/') && !path.startsWith('//') ? path : path.replace(/\\/g, '/').toLowerCase();
}

/** Immutable snapshot paths retain their repository name separately from the revision. */
export function snapshotModelName(value: string): string | undefined {
  const parts = normalizeDisplayPath(value).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.at(-2) !== 'snapshots' || !/^[a-f0-9]{40}$/i.test(parts.at(-1) ?? '')) return undefined;
  const repository = parts.at(-3) ?? '';
  if (repository.startsWith('models--')) {
    const encoded = repository.slice('models--'.length);
    const ownerEnd = encoded.indexOf('--');
    return ownerEnd > 0 && ownerEnd + 2 < encoded.length ? encoded.slice(ownerEnd + 2) : undefined;
  }
  // App downloads use hf/<publisher>/<model>/snapshots/<revision>.
  return parts.at(-5) === 'hf' && parts.at(-4) && repository ? repository : undefined;
}

/** Model labels group GGUF shards and name snapshots; access and requests keep the original value. */
export function modelDisplayName(value: string): string {
  const path = normalizeDisplayPath(value);
  const name = snapshotModelName(path) ?? path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const shard = /^(.+)-(\d{5})-of-(\d{5})(\.gguf)?$/i.exec(name);
  if (!shard) return name;
  const index = Number(shard[2]);
  const total = Number(shard[3]);
  return total > 1 && index > 0 && index <= total ? `${shard[1]}${shard[4] ?? ""}` : name;
}

/** Recognises explicit path syntax for display only. Bare relative strings and
 * model IDs remain intact; a file extension does not establish a local path. */
export function isModelFilePath(value: string): boolean {
  const path = normalizeDisplayPath(value);
  if (!path) return false;
  if (/^[A-Za-z]:[\\/]/.test(path) || /^(?:[\\/]|~[\\/]|\.\.?[\\/])/.test(path)) return true;
  if (/^file:\/\//i.test(path)) return true;
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) && path.includes('\\');
}

/** Removes Windows verbatim path prefixes from arbitrary displayed text. */
export function normalizeDisplayText(value: string): string {
  return value
    // Strip ANSI color/control sequences emitted by native server logs.
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
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

/**
 * The value to store when a normalized path was shown in an editable field.
 *
 * Fields bound straight to the stored path displayed the verbatim `\?\` prefix
 * Windows hands back. Showing the normalized form instead would drop that prefix
 * the moment anything wrote the field back, so the original is kept while the
 * text is untouched, and only a real edit replaces it.
 */
export function restoreDisplayPath(original: string, edited: string): string {
  return edited === normalizeDisplayPath(original) ? original : edited;
}
