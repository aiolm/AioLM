/* global process */
// Packaging entry point for the current host's desktop installers.
//
// `tauri build` shells out to cargo, so it has to run under the same remapped
// path environment as `build:cli`. Sharing one environment keeps the two
// binaries inside an installer consistent with each other and lets them share a
// single cargo build cache instead of rebuilding every dependency twice.

import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { provisionAppImageRuntime, readVerifiedRuntime, verifyBundledAppImages } from "./appimage-runtime/runtime.mjs";
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

/**
 * The packaging environment. Linux AppImages embed the pinned, repaired type2
 * runtime (scripts/appimage-runtime) through linuxdeploy-plugin-appimage's
 * LDAI_RUNTIME_FILE; other hosts build no AppImage and are left unchanged.
 */
export function packagingEnv(platform, env, provisionRuntime) {
  return platform === "linux" ? { ...env, LDAI_RUNTIME_FILE: provisionRuntime(env) } : env;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const targetDirectory = resolve(root, process.env.CARGO_TARGET_DIR ?? ".codex-target");
  const env = packagingEnv(process.platform, releaseBuildEnv(), (base) =>
    provisionAppImageRuntime({ env: base, cacheRoot: join(targetDirectory, "appimage-runtime") }));
  const started = Date.now();
  // Invoke the installed CLI through Node so paths with spaces work on every
  // host without shell interpolation or downloading another CLI through npx.
  const cli = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
  const result = spawnSync(process.execPath, [cli, ...packagingArgs(process.platform)], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (process.platform === "linux" && result.status === 0 && env.LDAI_RUNTIME_FILE) {
    // Re-read and re-hash after the build: a file swapped between provisioning
    // and bundling must not be accepted just because it was valid earlier.
    verifyBundledAppImages(
      join(targetDirectory, "release", "bundle", "appimage"),
      readVerifiedRuntime(env.LDAI_RUNTIME_FILE),
      started,
    );
  }
  process.exit(result.status ?? 1);
}
