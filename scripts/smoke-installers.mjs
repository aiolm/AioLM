/* global process, console */
// Real package installation is restricted to disposable GitHub-hosted runners.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

assert.equal(process.env.GITHUB_ACTIONS, "true", "installer smoke requires GitHub Actions");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "never install on a personal or self-hosted machine");
assert.ok(process.env.RUNNER_TEMP);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "aiolm-install-"));
const bundle = resolve(".codex-target/release/bundle");
function run(executable, args, accepted = [0]) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 180_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.ok(accepted.includes(result.status), `${executable}: ${result.status}\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
function packageFile(directory, suffix) {
  const files = readdirSync(join(bundle, directory)).filter(name => name.endsWith(suffix));
  assert.equal(files.length, 1, `expected one ${suffix} package`);
  return join(bundle, directory, files[0]);
}
function installedCli(directory) {
  const extension = process.platform === "win32" ? ".exe" : "";
  assert.ok(existsSync(join(directory, `aiolm${extension}`)), `installed desktop binary is missing in ${directory}`);
  assert.ok(!existsSync(join(directory, `fake-llama-server${extension}`)), "test fixture was installed");
  run(process.execPath, ["scripts/smoke-native-cli.mjs", join(directory, `aiolm-cli${extension}`)]);
}

try {
  if (process.platform === "linux") {
    assert.ok(!existsSync("/usr/bin/aiolm"), "refuse to replace an existing installation");
    const deb = packageFile("deb", ".deb");
    const name = run("dpkg-deb", ["-f", deb, "Package"]).trim();
    assert.equal(name, "aio-lm");
    try {
      run("sudo", ["apt-get", "install", "-y", deb]);
      installedCli("/usr/bin");
      run("sudo", ["dpkg", "-i", deb]);
      installedCli("/usr/bin");
    } catch (error) {
      console.error(error);
      throw error;
    } finally {
      const installed = spawnSync("dpkg-query", ["-W", "-f=${db:Status-Status}", name], { encoding: "utf8" });
      if (installed.status === 0 && installed.stdout.trim() !== "not-installed") {
        run("sudo", ["apt-get", "remove", "-y", name]);
      }
    }
    assert.ok(!existsSync("/usr/bin/aiolm") && !existsSync("/usr/bin/aiolm-cli"));
    console.log("DEB install, same-version reinstall, installed CLI and removal passed.");
  } else if (process.platform === "win32") {
    const install = join(root, "nsis");
    const installer = packageFile("nsis", "-setup.exe");
    try {
      run(installer, ["/S", `/D=${install}`]);
      installedCli(install);
      run(installer, ["/S", "/UPDATE", `/D=${install}`]);
      installedCli(install);
    } finally {
      const uninstaller = join(install, "uninstall.exe");
      if (existsSync(uninstaller)) run(uninstaller, ["/S", `_?=${install}`]);
    }
    assert.ok(!existsSync(join(install, "aiolm.exe")) && !existsSync(join(install, "aiolm-cli.exe")));
    console.log("NSIS install, same-version update, installed CLI and uninstall passed.");

    const msi = packageFile("msi", ".msi");
    // Tauri preserves the previous NSIS location in HKCU after uninstall and
    // MSI deliberately reuses it. Exercise switching formats at that location.
    const msiInstall = install;
    const msiLog = join(root, "msi-install.log");
    try {
      run("msiexec.exe", ["/i", msi, "/qn", "/norestart", "/L*v", msiLog, `INSTALLDIR=${msiInstall}`], [0, 3010]);
      installedCli(msiInstall);
      run("msiexec.exe", ["/fa", msi, "/qn", "/norestart"], [0, 3010]);
      installedCli(msiInstall);
    } catch (error) {
      if (existsSync(msiLog)) console.error(readFileSync(msiLog, "utf16le"));
      throw error;
    } finally {
      run("msiexec.exe", ["/x", msi, "/qn", "/norestart"], [0, 3010, 1605]);
    }
    assert.ok(!existsSync(join(msiInstall, "aiolm.exe")) && !existsSync(join(msiInstall, "aiolm-cli.exe")));
    console.log("MSI install, repair, installed CLI and uninstall passed.");
  } else {
    throw new Error("installer smoke supports Windows and Linux");
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
