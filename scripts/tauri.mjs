/* global process */
// Give development windows an isolated desktop identity, data folder, and runtime defaults.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEV_TAURI_CONFIG = "src-tauri/tauri.dev.conf.json";

/** @param {readonly string[]} args */
function hasConfigArg(args) {
  for (const arg of args) {
    if (arg === "--") return false;
    if (arg === "-c" || arg === "--config" || arg.startsWith("--config=")) return true;
  }
  return false;
}

/**
 * Plan CLI arguments and environment for a Tauri invocation without mutating inputs.
 * @param {{ args: readonly string[], env: NodeJS.ProcessEnv, root: string, platform: string }} options
 * @returns {{ args: string[], env: NodeJS.ProcessEnv, registerLinuxDev: boolean }}
 */
export function prepareTauriInvocation({ args, env, root, platform }) {
  const nextArgs = [...args];
  const nextEnv = { ...env };
  if (nextArgs[0] !== "dev") {
    return { args: nextArgs, env: nextEnv, registerLinuxDev: false };
  }
  if (!hasConfigArg(nextArgs)) {
    nextArgs.splice(1, 0, "--config", DEV_TAURI_CONFIG);
  }
  if (!nextEnv.AIOLM_HOME?.trim()) {
    nextEnv.AIOLM_HOME = resolve(root, "tmp", "dev-home");
  }
  if (!nextEnv.AIOLM_SKIP_LEGACY_MIGRATION?.trim()) {
    nextEnv.AIOLM_SKIP_LEGACY_MIGRATION = "1";
  }
  if (!nextEnv.AIOLM_BENCHMARK_API_URL?.trim()) {
    nextEnv.AIOLM_BENCHMARK_API_URL = "off";
  }
  return { args: nextArgs, env: nextEnv, registerLinuxDev: platform === "linux" };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const invocation = prepareTauriInvocation({
    args: process.argv.slice(2),
    env: process.env,
    root,
    platform: process.platform,
  });
  if (invocation.registerLinuxDev) {
    const registration = spawnSync("python3", [fileURLToPath(new URL("./register-linux-desktop.py", import.meta.url)), "--dev"], { stdio: "inherit" });
    if (registration.error) throw registration.error;
    if (registration.status !== 0) process.exit(registration.status ?? 1);
  }
  const cli = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
  const result = spawnSync(process.execPath, [cli, ...invocation.args], { env: invocation.env, stdio: "inherit" });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
