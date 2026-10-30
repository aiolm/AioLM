import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { installedRustToolchains, isolateCiRustToolchain, pinnedRustRelease, rustCompilerIdentity } from "./ci-rust-toolchain.mjs";

const PIN = "1.2.3";
const HOST = "x86_64-unknown-linux-gnu";
const selected = host => `${PIN}-${host}`;
const verbose = (host = HOST, pin = PIN, hash = "a".repeat(40)) => [
  `rustc ${pin} (${hash.slice(0, 9)} 2026-01-01)`, "binary: rustc", `commit-hash: ${hash}`,
  "commit-date: 2026-01-01", `host: ${host}`, `release: ${pin}`, "LLVM version: 21.0.0", "",
].join("\n");

function fixture(t, { host = HOST, installed, ...overrides } = {}) {
  const root = mkdtempSync(join(tmpdir(), "aiolm-ci-rust-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "rust-toolchain.toml"), `[toolchain]\nchannel = "${PIN}"\ncomponents = ["rustfmt", "clippy"]\n`);
  const state = {
    installed: installed ?? [selected(host), `stable-${host}`, `1.3.0-${host}`],
    active: selected(host), identity: verbose(host), calls: [], removed: [], ...overrides,
  };
  const env = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Linux", RUNNER_ARCH: "X64" };
  const spawn = (program, args, options) => {
    state.calls.push([program, args, options]);
    assert.equal(options.shell, false);
    assert.equal(options.cwd, root);
    assert.equal(options.stdio[0], "ignore");
    if (state.commandFailure?.(program, args)) return { status: 1, stdout: "", stderr: "synthetic-private-output" };
    let stdout;
    if (program === "rustc" && args.join(" ") === "-vV") stdout = state.identity;
    else if (program === "rustup" && args.join(" ") === "show active-toolchain") stdout = state.activeOutput ?? `${state.active} (overridden by synthetic manifest)\n`;
    else if (program === "rustup" && args.join(" ") === "toolchain list --quiet") stdout = state.listOverride ?? state.installed.join("\n") + "\n";
    else if (program === "rustup" && args[0] === "toolchain" && args[1] === "uninstall" && args.length === 3) {
      assert.notEqual(args[2], selected(host), "the selected compiler must never be removed");
      state.removed.push(args[2]);
      if (!state.keepUninstalled) state.installed = state.installed.filter(name => name !== args[2]);
      state.afterRemoval?.(state);
      stdout = "";
    } else assert.fail("unexpected toolchain command");
    return { status: 0, stdout };
  };
  return { root, env, spawn, state };
}

test("only hosted CI removes unused compiler names while preserving the pinned compiler", t => {
  const f = fixture(t);
  assert.deepEqual(isolateCiRustToolchain(f), { release: PIN, host: HOST, removed: 2 });
  assert.deepEqual(f.state.installed, [selected(HOST)]);
  assert.deepEqual(f.state.removed, [`1.3.0-${HOST}`, `stable-${HOST}`]);
  assert.equal(f.state.calls.filter(([program]) => program === "rustc").length, 2);
  assert.deepEqual(isolateCiRustToolchain(f), { release: PIN, host: HOST, removed: 0 });
  assert.equal(f.state.removed.length, 2, "an already isolated compiler is left intact");
});

test("local, self-hosted, and ambiguous runner contexts fail before commands", t => {
  for (const patch of [
    { GITHUB_ACTIONS: undefined }, { GITHUB_ACTIONS: "false" }, { RUNNER_ENVIRONMENT: undefined },
    { RUNNER_ENVIRONMENT: "self-hosted" }, { RUNNER_ENVIRONMENT: "GitHub-hosted" },
  ]) {
    const f = fixture(t);
    assert.throws(() => isolateCiRustToolchain({ ...f, env: { ...f.env, ...patch } }), /ephemeral GitHub-hosted/);
    assert.equal(f.state.calls.length, 0);
  }
});

test("all four native verification targets validate the actual compiler host", t => {
  for (const [os, arch, host] of [
    ["Linux", "X64", HOST], ["Windows", "X64", "x86_64-pc-windows-msvc"],
    ["macOS", "X64", "x86_64-apple-darwin"], ["macOS", "ARM64", "aarch64-apple-darwin"],
  ]) {
    const f = fixture(t, { host });
    assert.equal(isolateCiRustToolchain({ ...f, env: { ...f.env, RUNNER_OS: os, RUNNER_ARCH: arch } }).host, host);
  }
  const f = fixture(t);
  assert.throws(() => isolateCiRustToolchain({ ...f, env: { ...f.env, RUNNER_ARCH: "ARM64" } }), /Unsupported/);
  assert.equal(f.state.calls.length, 0);
});

test("the manifest requires one exact stable channel before any compiler command", t => {
  for (const manifest of [
    "", '[toolchain]\nchannel = "stable"\n', '[toolchain]\nchannel = "1.2"\n',
    '[toolchain]\nchannel = "01.2.3"\n', '[toolchain]\nchannel = "1.2.3-beta.1"\n',
    '[toolchain]\nchannel = "1.2.3"\nchannel = "1.2.4"\n',
    '[toolchain]\nchannel = "1.2.3" trailing\n', '[toolchain]\nchannel = "1.2.3"\n[toolchain]\n',
  ]) {
    const f = fixture(t);
    writeFileSync(join(f.root, "rust-toolchain.toml"), manifest);
    assert.throws(() => isolateCiRustToolchain(f), /toolchain/);
    assert.equal(f.state.calls.length, 0);
  }
  assert.equal(pinnedRustRelease('[toolchain]\r\nchannel = "1.2.3" # exact pin\r\n'), PIN);
});

test("wrong compiler release, host, commit, or malformed identity prevents removal", t => {
  for (const identity of [
    verbose(HOST, "1.3.0"), verbose("x86_64-apple-darwin"), verbose(HOST, PIN, "unknown"),
    verbose().replace("release: 1.2.3", "release: 1.2.3\nrelease: 1.2.3"),
    verbose().replace("binary: rustc", "binary: other"), "unrecognized compiler\n",
  ]) {
    const f = fixture(t, { identity });
    assert.throws(() => isolateCiRustToolchain(f), /compiler/);
    assert.equal(f.state.removed.length, 0);
  }
  assert.equal(rustCompilerIdentity(verbose().replace(/\n/g, "\r\n"), PIN, HOST).release, PIN);
});

test("the active canonical toolchain and complete installed list are checked before removal", t => {
  for (const active of [`stable-${HOST}`, `1.3.0-${HOST}`, `${selected(HOST)}\nmalformed`]) {
    const f = fixture(t, { active });
    assert.throws(() => isolateCiRustToolchain(f), /Active Rust toolchain/);
    assert.equal(f.state.removed.length, 0);
  }
  for (const activeOutput of ["", `${selected(HOST)} (unterminated`]) {
    const f = fixture(t, { activeOutput });
    assert.throws(() => isolateCiRustToolchain(f), /Active Rust toolchain/);
    assert.equal(f.state.removed.length, 0);
  }
  const missing = fixture(t, { installed: [`stable-${HOST}`] });
  assert.throws(() => isolateCiRustToolchain(missing), /missing/);
  assert.equal(missing.state.removed.length, 0);
  for (const listOverride of ["", `${selected(HOST)}\n${selected(HOST)}\n`,
    `${selected(HOST)}\n--default\n`, `${selected(HOST)}\n../custom\n`,
    `${selected(HOST)} (active, default)\n`, `${selected(HOST)}\ncustom-toolchain\n`]) {
    const f = fixture(t, { listOverride });
    assert.throws(() => isolateCiRustToolchain(f), /quiet Rust toolchain list/);
    assert.equal(f.state.removed.length, 0);
  }
  assert.deepEqual(installedRustToolchains(`${selected(HOST)}\r\nnightly-2026-01-01-${HOST}\r\n`),
    [selected(HOST), `nightly-2026-01-01-${HOST}`]);
});

test("failed commands stop without reporting raw private output", t => {
  for (const failOn of ["-vV", "show active-toolchain", "toolchain list --quiet", `toolchain uninstall 1.3.0-${HOST}`]) {
    const f = fixture(t, { commandFailure: (_, args) => args.join(" ") === failOn });
    assert.throws(() => isolateCiRustToolchain(f), error => {
      assert.equal(error.message, "Rust toolchain command failed");
      assert.ok(!error.message.includes("synthetic-private-output"));
      return true;
    });
    assert.equal(f.state.removed.length, 0);
  }
  const f = fixture(t);
  assert.throws(() => isolateCiRustToolchain({ ...f, spawn: () => { throw new Error("synthetic-private-path"); } }),
    { message: "Rust toolchain command failed" });
  rmSync(join(f.root, "rust-toolchain.toml"));
  assert.throws(() => isolateCiRustToolchain(f), { message: "Cannot read Rust toolchain manifest" });
  assert.equal(f.state.calls.length, 0);
});

test("post-isolation list, active selection and full compiler identity must stay exact", t => {
  const remaining = fixture(t, { keepUninstalled: true });
  assert.throws(() => isolateCiRustToolchain(remaining), /remain after isolation/);
  for (const afterRemoval of [
    state => { state.active = `stable-${HOST}`; },
    state => { state.identity = verbose(HOST, PIN, "b".repeat(40)); },
    state => { state.identity = verbose().replace("LLVM version: 21.0.0", "LLVM version: 22.0.0"); },
  ]) {
    const f = fixture(t, { afterRemoval });
    assert.throws(() => isolateCiRustToolchain(f), /Active Rust toolchain|compiler changed/);
    assert.ok(!f.state.removed.includes(selected(HOST)));
  }
});
