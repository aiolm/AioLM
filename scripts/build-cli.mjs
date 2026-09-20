import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseBuildEnv } from "./build-path-remap.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const config = resolve(root, "src-tauri", "tauri-cli-build.conf.json");
const result = spawnSync("cargo", ["build", "--locked", "--manifest-path", "src-tauri/Cargo.toml", "--release", "--bin", "aiolm-cli"], {
  cwd: root,
  env: { ...releaseBuildEnv(), TAURI_CONFIG: readFileSync(config, "utf8") },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
