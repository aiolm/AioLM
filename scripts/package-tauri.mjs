/* global process, console */
// Packaging entry point for the current host's desktop installers.
//
// Tauri builds both desktop executables with one production configuration.
// Its frontend hook runs once, then the bundle command packages the verified
// outputs without invoking Cargo again. Both commands keep the path remapping
// and pinned AppImage runtime required by distribution builds.

import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
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

export function packagingArgs(platform, stage = "build") {
  const targets = bundleTargets(platform);
  const common = ["--config", "src-tauri/tauri-package.conf.json", "--features", "tauri/custom-protocol"];
  // Tauri adds --bins, so aiolm and aiolm-cli share the production context.
  // Keep test-fixtures disabled in Cargo and absent from bundle's feature list:
  // bundle uses this list to exclude binaries with required-features.
  if (stage === "build") return ["build", ...common, "--no-bundle", "--", "--locked", "--no-default-features", "--timings"];
  if (stage === "bundle") return ["bundle", ...common, "--bundles", targets];
  throw new Error(`Unknown packaging stage: ${stage}`);
}

/**
 * The packaging environment. Linux AppImages embed the pinned, repaired type2
 * runtime (scripts/appimage-runtime) through linuxdeploy-plugin-appimage's
 * LDAI_RUNTIME_FILE; other hosts build no AppImage and are left unchanged.
 */
export function packagingEnv(platform, env, provisionRuntime) {
  return platform === "linux" ? { ...env, LDAI_RUNTIME_FILE: provisionRuntime(env) } : env;
}

export function preparePackagingEnv({ root, platform, env, provisionRuntime = provisionAppImageRuntime }) {
  bundleTargets(platform);
  const targetDirectory = resolve(root, env.CARGO_TARGET_DIR ?? ".codex-target");
  return packagingEnv(platform, env, (base) => provisionRuntime({ env: base, cacheRoot: join(targetDirectory, "appimage-runtime") }));
}

function verifyExecutables(root, platform, env) {
  const directory = resolve(root, env.CARGO_TARGET_DIR ?? ".codex-target", "release");
  for (const name of ["aiolm", "aiolm-cli"]) {
    const path = join(directory, name + (platform === "win32" ? ".exe" : ""));
    let metadata;
    try { metadata = statSync(path); } catch { throw new Error(`Production build did not create ${name}: ${path}`); }
    if (!metadata.isFile() || metadata.size === 0) throw new Error(`Production executable is missing or empty: ${path}`);
  }
}

export function runPackaging({
  root,
  platform = process.platform,
  env = releaseBuildEnv(),
  spawn = spawnSync,
  provisionRuntime = provisionAppImageRuntime,
  readRuntime = readVerifiedRuntime,
  verifyImages = verifyBundledAppImages,
  cli = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js")),
}) {
  const prepared = preparePackagingEnv({ root, platform, env, provisionRuntime });
  const targetDirectory = resolve(root, prepared.CARGO_TARGET_DIR ?? ".codex-target");
  const started = Date.now();
  // Invoke the installed CLI through Node so paths with spaces work on every
  // host without shell interpolation or downloading another CLI through npx.
  for (const stage of ["build", "bundle"]) {
    const result = spawn(process.execPath, [cli, ...packagingArgs(platform, stage)], { cwd: root, env: prepared, stdio: "inherit" });
    if (result.error) throw result.error;
    if (result.status !== 0) return result.status ?? 1;
    if (stage === "build") verifyExecutables(root, platform, prepared);
  }
  if (platform === "linux" && prepared.LDAI_RUNTIME_FILE) {
    // Re-read and re-hash after the build: a file swapped between provisioning
    // and bundling must not be accepted just because it was valid earlier.
    verifyImages(
      join(targetDirectory, "release", "bundle", "appimage"),
      readRuntime(prepared.LDAI_RUNTIME_FILE),
      started,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--prepare-runtime") {
    const env = preparePackagingEnv({ root, platform: process.platform, env: releaseBuildEnv() });
    console.log(env.LDAI_RUNTIME_FILE ? `Pinned AppImage runtime ready: ${env.LDAI_RUNTIME_FILE}` : "This platform does not need an AppImage runtime.");
  } else if (args.length === 0) {
    process.exit(runPackaging({ root }));
  } else {
    throw new Error("Usage: node scripts/package-tauri.mjs [--prepare-runtime]");
  }
}
