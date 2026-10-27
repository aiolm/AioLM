export interface RuntimeVersionLabelInput {
  /** Engine name. Only `llama.cpp` gets llama.cpp banner and `bNNNN` parsing. */
  name?: string | null;
  /** What the runtime reported: a semantic version, a llama.cpp banner or a legacy build tag. */
  version?: string | null;
  /** The caller's build identity: a build number, a `bNNNN` tag or an opaque local/PR id. */
  build?: string | number | null;
  variant?: string | null;
  plugin_version?: string | null;
}

const UNKNOWN = '?';
const SEMVER = /(?:^|\bversion:\s*)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)/i;
const BANNER_BUILD = /\(\s*build\s+(\d+)\b/i;
// Before llama.cpp printed a semantic version its banner read `version: 4589 (1a2b3c4)`.
const LEGACY_BANNER_BUILD = /\bversion:\s*(\d+)\s*\(/i;
const LEGACY_TAG = /^b?(\d+)(?:-[\da-f]+)?$/i;

function text(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed && trimmed !== UNKNOWN && trimmed.toLowerCase() !== 'unknown' ? trimmed : null;
}

function isLlamaCpp(name: string | null | undefined): boolean {
  return /^llama[.\-_]?cpp$/i.test(name?.trim() ?? '');
}

// llama.cpp reports build 0 when it was compiled without git history: no build number at all.
function buildNumber(digits: string | undefined): string | null {
  return digits && /[1-9]/.test(digits) ? digits.replace(/^0+/, '') : null;
}

function llamaBuild(build: string | number | null | undefined): string | null {
  if (typeof build === 'number') return Number.isSafeInteger(build) && build > 0 ? String(build) : null;
  const value = text(build);
  if (!value) return null;
  // A release tag names its build number; PR and local ids stay opaque.
  const tag = value.match(/^b?(\d+)$/i);
  return tag ? buildNumber(tag[1]) : value;
}

function llamaVersion(version: string | null): { version: string | null; build: string | null } {
  if (!version) return { version: null, build: null };
  const legacy = version.match(LEGACY_TAG);
  if (legacy) return { version: null, build: buildNumber(legacy[1]) };
  const banner = version.match(BANNER_BUILD)?.[1] ?? version.match(LEGACY_BANNER_BUILD)?.[1];
  const release = version.match(SEMVER)?.[1] ?? null;
  if (release || banner !== undefined) return { version: release, build: buildNumber(banner) };
  return { version, build: null };
}

/**
 * The human-facing runtime label, `version(build)`: `0.3.0-dev(10638)`.
 *
 * For llama.cpp, a semantic version, a `version: ... (build N, commit ...)`
 * banner, a legacy `version: N (commit)` banner and a legacy `bN` tag are
 * understood. A build number read from the reported version names the runtime
 * that actually ran, so it wins over the caller's `build`; the caller's
 * `bNNNN` tag gives its number, and a PR or local id is shown as it is. Build
 * 0 is llama.cpp's "compiled without git" value and counts as no number. A
 * missing semantic version leaves the build tag: `b10638`; a missing build
 * leaves the reported version: `0.3.0-dev`. Nothing known gives `null`,
 * so the caller can show its own localized "unavailable".
 *
 * Other engines keep their own version strings untouched: no banner parsing and
 * no build-tag rewriting. Their label is the reported version, followed by the
 * caller's build in parentheses only when one was given.
 *
 * Display only: stored records, identifiers and wire values are never changed.
 */
export function formatRuntimeVersionLabel(input: RuntimeVersionLabelInput): string | null {
  const reported = text(input.version);
  if (input.name === 'vllm' && input.variant === 'vllm-metal') {
    return `vllm-metal ${text(input.plugin_version) ?? UNKNOWN} · vLLM ${reported ?? UNKNOWN}`;
  }
  if (!isLlamaCpp(input.name)) {
    const build = text(input.build);
    if (!reported) return build;
    return build ? `${reported}(${build})` : reported;
  }
  const parsed = llamaVersion(reported);
  const build = parsed.build ?? llamaBuild(input.build);
  if (!parsed.version && !build) return null;
  if (!parsed.version) return /^\d+$/.test(build!) ? `b${build}` : build;
  return build ? `${parsed.version}(${build})` : parsed.version;
}
