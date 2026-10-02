/* global process, console */
// Runs the built CLI with a disposable home, including every migration source.
// No model, GPU, credentials, desktop session or network is needed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? `.codex-target/debug/aiolm-cli${process.platform === "win32" ? ".exe" : ""}`);
const temporary = mkdtempSync(join(tmpdir(), "aiolm-cli-smoke-"));
const home = join(temporary, "home with spaces");
mkdirSync(home);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AIOLM_|LLAMA_BOARD_)/i.test(key)) delete env[key];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "roaming"),
  LOCALAPPDATA: join(home, "local"),
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  AIOLM_HOME: join(home, "aiolm"),
});
const run = (...args) => {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
};
try {
  assert.match(run("--help").usage, /aiolm-cli/);
  const initial = run("config", "get");
  assert.equal(initial.active_model, "");
  assert.equal(initial.active_build, "");
  assert.deepEqual(run("runtime", "list"), []);
  assert.equal(run("config", "set", "ctx_size", "8192").ok, true);
  assert.equal(run("config", "get").ctx_size, 8192);
  assert.equal(run("doctor").config_loaded, true);
  assert.equal(run("server", "status").state, "stopped");
  console.log("Native CLI smoke passed: clean initialization, configuration roundtrip, empty runtimes and stopped server.");
} finally {
  // Only this invocation's mkdtemp directory is removed.
  rmSync(temporary, { recursive: true, force: true });
}
