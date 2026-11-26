// Apply at presentation boundaries (including tooltips, diagnostics and copied paths).
// Keep stored paths and command arguments intact: Windows file access can need the prefix.
export function normalizeDisplayPath(value: string): string {
  const path = stripVerbatimPrefix(value.trim());
  // Windows accepts either separator, so a folder joined with a relative path such as
  // `hf/owner/model` reads `C:\models\hf/owner/model`. Drive and UNC paths show `\` only;
  // POSIX paths, URLs and model IDs keep their `/`.
  return isWindowsAbsolutePath(path) ? path.replace(/\//g, "\\") : path;
}

function stripRecognizedVerbatim(value: string): string {
  if (!value.startsWith("\\\\?\\")) return value;
  const rest = value.slice(4);
  if (rest.slice(0, 4).toLowerCase() === "unc\\") {
    const suffix = rest.slice(4);
    return suffix ? `\\\\${suffix}` : value;
  }
  if (/^[A-Za-z]:[\\/]/.test(rest)) return rest;
  return value;
}

/** Strips Windows verbatim path prefixes (`\\?\X:\...`, `\\?\UNC\...`) from an argv token, including `--flag=\\?\...`. */
export function stripWindowsVerbatimPrefixArg(arg: string): string {
  const direct = stripRecognizedVerbatim(arg);
  if (direct.length !== arg.length) return direct;
  const eq = arg.indexOf("=");
  if (eq > 0 && arg.startsWith("-")) {
    const value = arg.slice(eq + 1);
    const stripped = stripRecognizedVerbatim(value);
    if (stripped.length !== value.length) return `${arg.slice(0, eq + 1)}${stripped}`;
  }
  return arg;
}

function stripVerbatimPrefix(path: string): string {
  const lower = path.toLowerCase();
  if (lower.startsWith("\\\\?\\unc\\")) return `\\\\${path.slice(8)}`;
  if (lower.startsWith("\\\\?\\")) return path.slice(4);
  return path;
}

/** Drive-letter (`C:\`, `C:/`) and UNC (`\\server\share`) paths. `//host` stays POSIX/URL. */
function isWindowsAbsolutePath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\/?.]/.test(path);
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

/** Model labels group split-file parts and name snapshots; access and requests keep the original value.
 * The Rust twin is `model_names::display_name` in `src-tauri/src/model_names.rs`. */
export function modelDisplayName(value: string): string {
  const path = normalizeDisplayPath(value);
  const snapshot = snapshotModelName(path);
  if (snapshot) return stripModelShardSuffix(snapshot);
  // A selected snapshot label (`repo · variant/model.safetensors`) is already a
  // label: its `/` belongs to the variant, not to a directory.
  if (!isModelFilePath(path) && !path.includes('\\') && path.includes(' · ')) return stripModelShardSuffix(path);
  const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  return stripModelShardSuffix(name);
}

export interface ParsedModelShard {
  base: string;
  index: number;
  total: number;
  /** Digits of the part number, so sibling parts keep the width the repository used. */
  width: number;
  extension?: string;
}

export interface ParseModelShardOptions {
  extensions?: readonly ('gguf' | 'safetensors')[];
  allowExtensionless?: boolean;
  exactExtensionCase?: boolean;
}

/**
 * Recognises `-00001-of-00004` and `-0001-of-0004` (equal-width, lowercase `-of-`)
 * with a valid part number. Mirrors `model_names::parse_shard` in Rust.
 */
export function parseModelShardSuffix(value: string, options: ParseModelShardOptions = {}): ParsedModelShard | null {
  const { extensions = ['gguf', 'safetensors'], allowExtensionless = true, exactExtensionCase = false } = options;
  let stem = value;
  let extension: string | undefined;
  const dot = value.lastIndexOf('.');
  if (dot >= 0) {
    const candidate = value.slice(dot + 1);
    const lower = candidate.toLowerCase();
    if (lower === 'gguf' || lower === 'safetensors') {
      if (!extensions.includes(lower) || (exactExtensionCase && candidate !== lower)) return null;
      stem = value.slice(0, dot);
      extension = candidate;
    }
  }
  if (extension === undefined && !allowExtensionless) return null;
  const match = /^(.+)-(\d{4,5})-of-(\d{4,5})$/.exec(stem);
  if (!match) return null;
  const [, base = '', indexText = '', totalText = ''] = match;
  if (base.endsWith('/') || base.endsWith('\\') || indexText.length !== totalText.length) return null;
  const index = Number(indexText);
  const total = Number(totalText);
  if (!(total > 1 && index > 0 && index <= total)) return null;
  return { base, index, total, width: indexText.length, ...(extension === undefined ? {} : { extension }) };
}

/** The file name of one part of a split set, keeping the original digit width. */
export function formatModelShardPart(shard: ParsedModelShard, part: number): string {
  const pad = (value: number) => String(value).padStart(shard.width, '0');
  return `${shard.base}-${pad(part)}-of-${pad(shard.total)}${shard.extension === undefined ? '' : `.${shard.extension}`}`;
}

/** Groups shard labels without treating namespaced model IDs as file paths. */
export function stripModelShardSuffix(value: string): string {
  const shard = parseModelShardSuffix(value);
  return shard ? `${shard.base}${shard.extension === undefined ? '' : `.${shard.extension}`}` : value;
}

/**
 * The label for any model name shown on screen: explicit local paths and
 * snapshots shrink to their model name, split parts are grouped, and everything
 * else (repository paths, namespaced IDs, selected-variant labels, non-model
 * titles) passes through untouched.
 */
export function formatModelLabel(value: string): string {
  const text = normalizeDisplayText(value);
  return isModelFilePath(text) || snapshotModelName(text) !== undefined ? modelDisplayName(text) : stripModelShardSuffix(text);
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
