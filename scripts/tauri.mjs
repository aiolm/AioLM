/* global process */
// Give development windows a desktop identity without changing Windows/macOS.
import { spawnSync } from "node:child_process";
import { fileURLToPath, URL } from "node:url";

if (process.platform === "linux" && process.argv[2] === "dev") {
  const registration = spawnSync("python3", [fileURLToPath(new URL("./register-linux-desktop.py", import.meta.url)), "--dev"], { stdio: "inherit" });
  if (registration.error) throw registration.error;
  if (registration.status !== 0) process.exit(registration.status ?? 1);
}
const cli = fileURLToPath(import.meta.resolve("@tauri-apps/cli/tauri.js"));
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
