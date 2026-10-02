/* global process */
// Packaging entry point for the current host's desktop installers.
//
// `tauri build` shells out to cargo, so it has to run under the same remapped
// path environment as `build:cli`. Sharing one environment keeps the two
// binaries inside an installer consistent with each other and lets them share a
// single cargo build cache instead of rebuilding every dependency twice.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseBuildEnv } from "./build-path-remap.mjs";

export function bundleTargets(platform) {
  switch (platform) {
    case "win32": return "nsis,msi";
    case "linux": return "deb,appimage";
    case "darwin": return "app,dmg";
    default: throw new Error(`Desktop packaging is not supported on ${platform}`);
  }
}

export function packagingArgs(platform) {
  // Tauri builds every enabled Cargo binary. Keep the default-on smoke fixture
  // available to cargo test while excluding it from distribution builds.
  return ["build", "--config", "src-tauri/tauri-package.conf.json", "--bundles", bundleTargets(platform), "--", "--no-default-features"];
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  // Invoke the installed CLI through Node so paths with spaces work on every
  // host without shell interpolation or downloading another CLI through npx.
  const cli = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
  const result = spawnSync(process.execPath, [cli, ...packagingArgs(process.platform)], {
    cwd: root,
    env: releaseBuildEnv(),
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 1);
}
