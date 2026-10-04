/* global process, console */
// Install only on a disposable hosted Mac. Preserve the synthetic user's data
// across a real DMG copy/replacement and remove only the app this run installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true", "installer acceptance requires GitHub Actions");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "use a disposable hosted Mac");
assert.ok(process.env.RUNNER_TEMP);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "aiolm-macos-install-"));
const mount = join(root, "mounted image");
const systemApp = "/Applications/AioLM.app";
let app = systemApp;
let mounted = false, installed = false;
assert.ok(!existsSync(app), "refuse to replace an existing app");

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 180_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
function removeInstalledApp() {
  if (app === systemApp) run("sudo", ["rm", "-rf", app]);
  else rmSync(app, { recursive: true, force: true });
  installed = false;
}
async function launchInstalledGui(env, probe) {
  const child = spawn(join(app, "Contents/MacOS/aiolm"), [], { env, stdio: "ignore" });
  let error;
  child.on("error", cause => { error = cause; });
  try {
    const deadline = Date.now() + 30_000;
    while (run(probe, [String(child.pid)]).trim() !== "visible") {
      assert.ok(!error && child.exitCode === null && Date.now() < deadline, `installed GUI did not show its window: ${error ?? child.exitCode}`);
      await delay(200);
    }
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise(resolve => child.once("exit", resolve));
      }
    }
  }
}

try {
  const directory = resolve(".codex-target/release/bundle/dmg");
  const files = readdirSync(directory).filter(name => name.endsWith(".dmg"));
  assert.equal(files.length, 1, "expected one host-architecture DMG");
  mkdirSync(mount);
  run("/usr/bin/hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", mount, join(directory, files[0])]);
  mounted = true;
  const source = join(mount, "AioLM.app");
  assert.ok(existsSync(source));
  const metadata = JSON.parse(run("/usr/bin/plutil", ["-convert", "json", "-o", "-", join(source, "Contents/Info.plist")]));
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const minimum = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).bundle.macOS.minimumSystemVersion;
  assert.equal(metadata.CFBundleIdentifier, "com.aiolm.desktop");
  assert.equal(metadata.CFBundleShortVersionString, version);
  assert.equal(metadata.LSMinimumSystemVersion, minimum);
  for (const name of ["aiolm", "aiolm-cli"]) {
    const binary = join(source, "Contents/MacOS", name);
    assert.ok(existsSync(binary), `missing ${name}`);
    const arch = process.arch === "arm64" ? "arm64" : "x86_64";
    assert.equal(run("/usr/bin/lipo", ["-archs", binary]).trim(), arch);
  }
  assert.ok(!existsSync(join(source, "Contents/MacOS/fake-llama-server")));

  const home = join(root, "synthetic home 한글");
  mkdirSync(home);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (/^(AIOLM_|LLAMA_BOARD_)/i.test(name)) delete env[name];
  Object.assign(env, {
    HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
    XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
    XDG_CACHE_HOME: join(home, "cache"), AIOLM_HOME: join(home, "aiolm"),
  });
  const probe = join(root, "window-probe");
  run("swiftc", ["scripts/macos-window-probe.swift", "-o", probe]);
  const userApplications = join(home, "Applications");
  mkdirSync(userApplications);
  const cli = (...args) => JSON.parse(run(join(app, "Contents/MacOS/aiolm-cli"), args, { env }));
  let initialized = false;
  for (app of [systemApp, join(userApplications, "AioLM.app")]) {
    assert.ok(!existsSync(app), "refuse to replace an existing app");
    for (const replacing of [false, true]) {
      if (replacing) removeInstalledApp();
      // Ownership is established only after the existing-app check above; no
      // personal machine or pre-existing installation can reach this operation.
      installed = true;
      if (app === systemApp) run("sudo", ["/usr/bin/ditto", source, app]);
      else run("/usr/bin/ditto", [source, app]);
      run(process.execPath, ["scripts/smoke-native-cli.mjs", join(app, "Contents/MacOS/aiolm-cli")]);
      if (!initialized) {
        assert.equal(cli("config", "get").active_build, "");
        cli("config", "set", "ctx_size", "8192");
        initialized = true;
      } else {
        assert.equal(cli("config", "get").ctx_size, 8192, "app replacement must retain user settings");
      }
      assert.equal(cli("server", "status").state, "stopped");
      await launchInstalledGui(env, probe);
    }
    removeInstalledApp();
    assert.ok(!existsSync(app));
  }
  assert.equal(JSON.parse(readFileSync(join(env.AIOLM_HOME, "config.json"), "utf8")).ctx_size, 8192);
  console.log(`macOS ${process.arch}: DMG metadata, GUI/CLI architecture, system/user Applications install, real installed GUI launch, replacement, settings persistence and removal passed.`);
} finally {
  if (installed) removeInstalledApp();
  if (mounted) run("/usr/bin/hdiutil", ["detach", mount]);
  rmSync(root, { recursive: true, force: true });
}
