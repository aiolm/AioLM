/* global process */
// Release binaries must not carry absolute paths from the machine that built
// them. rustc bakes a `file!()` string into every panic location, so a plain
// release build of `aiolm.exe` and `aiolm-cli.exe` embeds the builder's home
// directory and Cargo registry directory hundreds of times over.
//
// Cargo's `trim-paths` profile option would express this declaratively, but it
// is still nightly-only: the pinned stable toolchain (rust-toolchain.toml,
// 1.98.0) rejects it with "feature `trim-paths` is required ... not stabilized
// in this version of Cargo". The stable equivalent is rustc's
// `--remap-path-prefix`, which this module computes from the current machine's
// directories so that no developer path is ever hardcoded in the repository.

import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Cargo splits RUSTFLAGS on whitespace and offers no quoting, so a build
// directory containing a space can only be passed through the encoded form.
const FLAG_SEPARATOR = "\u001f";

// `--remap-path-prefix` is a rustc flag and cannot reach the C sources that
// crates such as `lzma-sys` build through `cc`. MSVC expands `assert()` to
// `_wassert(..., __FILEW__, ...)`, so those sources embed the builder's
// absolute path as a wide string. Cargo's `trim-paths` would not fix it
// either: `cc` only translates remap rules into `-fmacro-prefix-map` /
// `-fdebug-prefix-map`, which `cl.exe` does not support, and it then warns
// that "paths embedded by macros will not be remapped". Defining `NDEBUG` is
// the standard release configuration for C code and compiles those asserts,
// and the file paths they carry, out of the binary altogether.
//
// Spelled with a dash rather than `/D` because `cl.exe` and `clang-cl` accept
// either prefix while `gcc` and `clang` accept only the dash, so one spelling
// stays correct for every host and target this repository builds for.
const C_RELEASE_DEFINE = "-DNDEBUG";

// The compiler flag variables `cc` reads. It uses the most specific variable
// that is set and ignores the rest, so a define has to be appended to every
// variant present rather than to the plain name alone.
const C_FLAG_VARIABLES = ["CFLAGS", "CXXFLAGS"];

function remappedDirectories(env) {
  const home = homedir();
  return [
    // Catch-all for anything else under the user profile.
    [home, "/home"],
    [env.CARGO_HOME ? resolve(env.CARGO_HOME) : resolve(home, ".cargo"), "/cargo"],
    [env.RUSTUP_HOME ? resolve(env.RUSTUP_HOME) : resolve(home, ".rustup"), "/rustup"],
    [repositoryRoot, "/aiolm"],
  ];
}

/**
 * `--remap-path-prefix` flags for every build directory of this machine.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function remapFlags(env = process.env) {
  const unique = new Map();
  for (const [from, to] of remappedDirectories(env)) {
    if (from && !unique.has(from)) unique.set(from, to);
  }
  return (
    [...unique]
      // rustc applies the *last* matching prefix, so a nested directory such as
      // the Cargo home has to be listed after the home directory that contains
      // it. Sorting by length puts every containing directory first.
      .sort(([left], [right]) => left.length - right.length)
      .map(([from, to]) => `--remap-path-prefix=${from}=${to}`)
  );
}

function appendFlag(value, flag) {
  return value && value.trim() !== "" ? `${value} ${flag}` : flag;
}

/**
 * Adds the release C define to every `cc` flag variable already in the
 * environment, and to the plain name when no variant is set. Existing flags are
 * kept; nothing is replaced.
 *
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
function withReleaseCDefine(env) {
  const next = { ...env };
  for (const base of C_FLAG_VARIABLES) {
    // `CFLAGS`, `CFLAGS_<target>`, `CFLAGS_<target_with_underscores>` and
    // `HOST_CFLAGS` / `TARGET_CFLAGS` are all consulted by `cc`.
    const variants = Object.keys(next).filter(
      (name) => name === base || name.startsWith(`${base}_`) || name.endsWith(`_${base}`),
    );
    for (const name of variants) next[name] = appendFlag(next[name], C_RELEASE_DEFINE);
    if (!variants.includes(base)) next[base] = C_RELEASE_DEFINE;
  }
  return next;
}

/**
 * The environment a release cargo invocation runs under: the caller's own
 * rustflags and C flags, if any, plus this machine's path remapping and the
 * release C define.
 *
 * Rustflags already present in the environment are preserved. Rustflags coming
 * from a `build.rustflags` table in a Cargo configuration file are not, because
 * Cargo reads only the highest-precedence source and the environment outranks
 * the configuration file; this repository's `.cargo/config.toml` sets none.
 *
 * Only the packaging scripts use this, so `cargo test`, `cargo clippy` and
 * every development build keep their assertions.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {NodeJS.ProcessEnv}
 */
export function releaseBuildEnv(env = process.env) {
  const inherited =
    env.CARGO_ENCODED_RUSTFLAGS !== undefined
      ? env.CARGO_ENCODED_RUSTFLAGS.split(FLAG_SEPARATOR)
      : (env.RUSTFLAGS ?? "").split(/\s+/);
  const flags = [...inherited.filter((flag) => flag !== ""), ...remapFlags(env)];
  const next = withReleaseCDefine(env);
  next.CARGO_ENCODED_RUSTFLAGS = flags.join(FLAG_SEPARATOR);
  // Cargo ignores RUSTFLAGS once the encoded form is set, and its contents are
  // already merged above; dropping it keeps the two from disagreeing.
  delete next.RUSTFLAGS;
  return next;
}
