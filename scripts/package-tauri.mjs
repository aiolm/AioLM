/* global process */
// Packaging entry point for the Windows installers.
//
// `tauri build` shells out to cargo, so it has to run under the same remapped
// path environment as `build:cli`. Sharing one environment keeps the two
// binaries inside an installer consistent with each other and lets them share a
// single cargo build cache instead of rebuilding every dependency twice.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseBuildEnv } from "./build-path-remap.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  "npx",
  ["tauri", "build", "--config", "src-tauri/tauri-package.conf.json", "--bundles", "nsis,msi"],
  {
    cwd: root,
    env: releaseBuildEnv(),
    stdio: "inherit",
    // npx is a shell script on POSIX and a .cmd shim on Windows, neither of
    // which Node can execute directly.
    shell: true,
  },
);
if (result.error) throw result.error;
process.exit(result.status ?? 1);
