/* global process, console */
// Install only on a disposable hosted Mac. Preserve the synthetic user's data
// across a real DMG copy/replacement and remove only the app this run installed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true", "installer acceptance requires GitHub Actions");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted", "use a disposable hosted Mac");
assert.ok(process.env.RUNNER_TEMP);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "aiolm-macos-install-"));
const mount = join(root, "mounted image");
const app = "/Applications/AioLM.app";
const executable = join(app, "Contents/MacOS/aiolm-cli");
let mounted = false, installed = false;
assert.ok(!existsSync(app), "refuse to replace an existing app");

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 180_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
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
  const cli = (...args) => JSON.parse(run(executable, args, { env }));
  for (const replacing of [false, true]) {
    if (replacing) run("sudo", ["rm", "-rf", app]);
    // Ownership is established only after the existing-app check above; no
    // personal machine or pre-existing installation can reach this operation.
    installed = true;
    run("sudo", ["/usr/bin/ditto", source, app]);
    run(process.execPath, ["scripts/smoke-native-cli.mjs", executable]);
    if (!replacing) {
      assert.equal(cli("config", "get").active_build, "");
      cli("config", "set", "ctx_size", "8192");
    } else {
      assert.equal(cli("config", "get").ctx_size, 8192, "app replacement must retain user settings");
    }
    assert.equal(cli("server", "status").state, "stopped");
  }
  run("sudo", ["rm", "-rf", app]);
  installed = false;
  assert.ok(!existsSync(app));
  assert.equal(JSON.parse(readFileSync(join(env.AIOLM_HOME, "config.json"), "utf8")).ctx_size, 8192);
  console.log(`macOS ${process.arch}: DMG metadata, GUI/CLI architecture, Applications install, replacement, settings persistence and removal passed.`);
} finally {
  if (installed) run("sudo", ["rm", "-rf", app]);
  if (mounted) run("/usr/bin/hdiutil", ["detach", mount]);
  rmSync(root, { recursive: true, force: true });
}
