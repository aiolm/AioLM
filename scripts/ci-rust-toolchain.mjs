/* global process, console */
// rust-cache fingerprints every installed compiler, including unused image
// toolchains. Isolate the pinned compiler only on disposable hosted runners;
// keep the action's compiler, environment and dependency hashing unchanged.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOSTS = {
  "Linux/X64": "x86_64-unknown-linux-gnu",
  "Windows/X64": "x86_64-pc-windows-msvc",
  "macOS/ARM64": "aarch64-apple-darwin",
  "macOS/X64": "x86_64-apple-darwin",
};
const RELEASE = "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const TOOLCHAIN = new RegExp(`^(?:${RELEASE}|(?:stable|beta|nightly)(?:-[0-9]{4}-[0-9]{2}-[0-9]{2})?)-[a-z0-9_]+(?:-[a-z0-9_]+){2,4}$`);
const requireThat = (condition, message) => { if (!condition) throw new Error(message); };

export function pinnedRustRelease(manifest) {
  requireThat(typeof manifest === "string" && manifest.length <= 65536, "Invalid Rust toolchain manifest");
  const sections = [...manifest.matchAll(/^\s*\[toolchain\]\s*(?:#.*)?$/gm)];
  requireThat(sections.length === 1, "Expected one Rust toolchain section");
  const body = manifest.slice(sections[0].index + sections[0][0].length).split(/^\s*\[/m)[0];
  const channels = body.split(/\r?\n/).filter(line => /^\s*channel\s*=/.test(line));
  const match = channels.length === 1 && channels[0].match(new RegExp(`^\\s*channel\\s*=\\s*"(${RELEASE})"\\s*(?:#.*)?$`));
  requireThat(match, "Rust toolchain channel must be one exact stable release");
  return match[1];
}

export function rustCompilerIdentity(output, pin, expectedHost) {
  requireThat(typeof output === "string" && output.length <= 65536, "Invalid Rust compiler identity");
  const verbose = output.trim().replace(/\r\n/g, "\n");
  const lines = verbose.split("\n");
  const header = lines[0].match(/^rustc ([0-9]+\.[0-9]+\.[0-9]+) \(([a-f0-9]{7,40}) ([0-9]{4}-[0-9]{2}-[0-9]{2})\)$/);
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9 -]*): ([^\r\n]+)$/);
    requireThat(match && !fields.has(match[1]), "Malformed Rust compiler identity fields");
    fields.set(match[1], match[2]);
  }
  requireThat(header && header[1] === pin && fields.get("binary") === "rustc"
    && fields.get("release") === pin, "Active Rust compiler does not match the pinned release");
  requireThat(fields.get("host") === expectedHost && /^[a-f0-9]{40}$/.test(fields.get("commit-hash") ?? ""),
    "Active Rust compiler host or commit identity is invalid");
  requireThat(fields.get("commit-hash").startsWith(header[2]) && fields.get("commit-date") === header[3],
    "Rust compiler header and verbose commit identity differ");
  return { release: pin, host: expectedHost, verbose };
}

export function installedRustToolchains(output) {
  requireThat(typeof output === "string" && output.length <= 65536, "Invalid installed Rust toolchain list");
  const names = output.trim().split(/\r?\n/).map(line => line.trim());
  requireThat(names.length > 0 && names.every(name => TOOLCHAIN.test(name)) && new Set(names).size === names.length,
    "Expected unique canonical names from the quiet Rust toolchain list");
  return names;
}

export function isolateCiRustToolchain({ root = ROOT, env = process.env, spawn = spawnSync } = {}) {
  // Check these before reading local configuration or executing any command.
  requireThat(env.GITHUB_ACTIONS === "true" && env.RUNNER_ENVIRONMENT === "github-hosted",
    "Rust toolchain isolation requires an ephemeral GitHub-hosted Actions runner");
  const host = HOSTS[`${env.RUNNER_OS}/${env.RUNNER_ARCH}`];
  requireThat(host, "Unsupported hosted Rust verification target");
  let manifest;
  try { manifest = readFileSync(join(root, "rust-toolchain.toml"), "utf8"); }
  catch { throw new Error("Cannot read Rust toolchain manifest"); }
  const pin = pinnedRustRelease(manifest);
  const run = (program, args) => {
    let result;
    try {
      result = spawn(program, args, {
        cwd: root, env, encoding: "utf8", shell: false, windowsHide: true,
        timeout: 120000, maxBuffer: 65536, stdio: ["ignore", "pipe", "pipe"],
      });
    } catch { throw new Error("Rust toolchain command failed"); }
    // Keep raw command output/errors out of logs: they may contain paths or
    // environment values. Only validated version and host are reported.
    requireThat(result && !result.error && result.status === 0 && typeof result.stdout === "string", "Rust toolchain command failed");
    return result.stdout;
  };
  const compiler = () => rustCompilerIdentity(run("rustc", ["-vV"]), pin, host);
  const expected = `${pin}-${host}`;
  const active = () => {
    const output = run("rustup", ["show", "active-toolchain"]).trim();
    const suffix = output.slice(expected.length);
    requireThat(output.startsWith(expected) && (suffix === "" || /^ \([^\r\n]+\)$/.test(suffix)),
      "Active Rust toolchain does not match the pinned compiler");
    return expected;
  };
  // Check installation before invoking a compiler proxy: a missing manifest
  // pin must fail rather than making rustup install it during validation.
  const installed = installedRustToolchains(run("rustup", ["toolchain", "list", "--quiet"]));
  requireThat(installed.includes(expected), "Pinned active Rust toolchain is missing from the installed list");
  const before = compiler();
  active();
  const removed = installed.filter(name => name !== expected).sort();
  // Every name and the selected compiler have been checked before mutation.
  for (const name of removed) run("rustup", ["toolchain", "uninstall", name]);
  const after = installedRustToolchains(run("rustup", ["toolchain", "list", "--quiet"]));
  requireThat(after.length === 1 && after[0] === expected, "Unused Rust toolchains remain after isolation");
  active();
  requireThat(compiler().verbose === before.verbose, "Pinned Rust compiler changed during isolation");
  return { release: pin, host, removed: removed.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    requireThat(process.argv.length === 2, "Usage: node scripts/ci-rust-toolchain.mjs");
    const result = isolateCiRustToolchain();
    console.log(`Pinned CI Rust toolchain ready: ${result.release} (${result.host}); removed ${result.removed} unused toolchains.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
