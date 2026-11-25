// Relative paths written as text use `/`; platform paths use the platform separator.
// `Path::join("lib/x64")` keeps the `/` on Windows (`C:\sdk\lib/x64`), which then shows
// up in errors and the UI and differs from the same path read back from the disk.
// Production Rust joins such strings with `crate::relative_path::join_relative`.
// A literal that is not a file path (a URL join) or only runs on POSIX can be kept with
// a `// path-separator: allow (<reason>)` comment on the same or the previous line.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ALLOW = /\/\/\s*path-separator:\s*allow\b/;
// `.join("a/b")`, `.push("a/b")`, `Path::new("a/b")` and `PathBuf::from("a/b")` with a
// relative literal; absolute POSIX literals (`"/usr/bin"`) are platform paths already.
const SLASH_LITERAL = /(?:\.(?:join|push)|\bPath::new|\bPathBuf::from)\(\s*"([^"/\\][^"\\]*\/[^"\\]*)"\s*,?\s*\)/g;
// Inline test modules come last (clippy `items_after_test_module`), so the rest is test code.
const TEST_MODULE = /^\s*#\[cfg\(test\)\]\s*(?:#\[[^\]]*\]\s*)*mod\s+\w+\s*\{/m;

/** @param {string} source */
export function slashLiteralJoins(source) {
  const cut = source.search(TEST_MODULE);
  const production = cut < 0 ? source : source.slice(0, cut);
  const lines = production.split(/\r?\n/);
  /** @type {{ line: number, literal: string }[]} */
  const found = [];
  for (const match of production.matchAll(SLASH_LITERAL)) {
    const line = production.slice(0, match.index).split("\n").length;
    if (ALLOW.test(lines[line - 1] ?? "") || ALLOW.test(lines[line - 2] ?? "")) continue;
    found.push({ line, literal: match[1] ?? "" });
  }
  return found;
}

/** @param {string} directory @returns {string[]} */
function rustSources(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "tests" ? [] : rustSources(path);
    return entry.name.endsWith(".rs") && !/(?:^|_)tests?\.rs$/.test(entry.name) ? [path] : [];
  });
}

test("finds relative slash literals passed to path joins in production code", () => {
  const source = [
    'fn a(root: &Path) { root.join("lib/x64"); }',
    'fn b(root: &Path) { let p = root.join(',
    '    "hf/owner/model",',
    '); }',
    'fn c() { Path::new("runtime/llama-server"); PathBuf::from("a/b"); }',
    'fn d(path: &mut PathBuf) { path.push("share/doc"); }',
  ].join("\n");
  assert.deepEqual(slashLiteralJoins(source).map(item => item.literal), [
    "lib/x64", "hf/owner/model", "runtime/llama-server", "a/b", "share/doc",
  ]);
});

test("accepts segment joins, absolute POSIX paths, marked literals and test modules", () => {
  const source = [
    'fn a(root: &Path) { root.join("lib").join("x64"); join_relative(root, "lib/x64"); }',
    'fn b() { Path::new("/usr/bin/xdg-open"); }',
    '// path-separator: allow (URL path, not a file path)',
    'fn c(base: &Url) { base.join("chat/completions"); }',
    'fn d(base: &Url) { base.join("v1/models"); } // path-separator: allow (URL)',
    '#[cfg(test)]',
    'mod tests {',
    '    fn e(root: &Path) { root.join("hf/owner/model"); }',
    '}',
  ].join("\n");
  assert.deepEqual(slashLiteralJoins(source), []);
});

test("production Rust joins relative paths segment by segment", () => {
  const sourceRoot = join(ROOT, "src-tauri", "src");
  const offenders = rustSources(sourceRoot).flatMap(path =>
    slashLiteralJoins(readFileSync(path, "utf8")).map(({ line, literal }) =>
      `${relative(ROOT, path).replaceAll("\\", "/")}:${line} "${literal}"`));
  assert.deepEqual(offenders, [], [
    "Use crate::relative_path::join_relative (or one `join` per segment) for `/`-separated relative paths,",
    "or mark a URL / POSIX-only literal with `// path-separator: allow (<reason>)`:",
    ...offenders,
  ].join("\n"));
});
