/* global process, console, fetch, AbortSignal */
// Open the opt-in WebDriver app through LaunchServices, as Finder and the Dock
// do, using only a disposable home. launchd then supplies its own minimal
// environment instead of this runner's shell PATH.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "aiolm-launchservices-"));
const home = join(root, "synthetic home 한글");
mkdirSync(home);
const bundle = join(root, "AioLM.app");
const executable = join(bundle, "Contents/MacOS/aiolm");
const log = join(root, "app.log");
const probe = resolve("tmp/macos-window-probe");
const terminate = resolve("tmp/macos-terminate-app");
const fixture = join(root, "mcp-fixture.mjs");
// A directory from /etc/paths that launchd does not put on an app's PATH.
const launcher = `/usr/local/bin/aiolm-launch-mcp-${process.pid}`;
const appEnv = {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), AIOLM_HOME: join(home, "aiolm"),
};
let pid, session, port, installedLauncher = false;

function run(program, args, options = {}) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout: 60_000, ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${program} ${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return result.stdout;
}
const alive = () => spawnSync("/bin/kill", ["-0", String(pid)]).status === 0;
const appLog = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
async function waitFor(check, description, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`${description}: ${lastError ?? "timed out"}\n${appLog().slice(-4000)}`);
}
async function request(method, path, data) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  assert.ok(response.ok && !result.value?.error, JSON.stringify(result));
  return result.value;
}
const script = (code, args = []) => request("POST", `/session/${session}/execute/sync`, { script: code, args });
// IPC failures are returned as data so the assertion can show the app's message.
const invoke = (command, args) => request("POST", `/session/${session}/execute/async`, {
  script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(value => done({ result: value }), error => done({ failure: String(error) }));",
  args: [command, args],
});
async function click(selector) {
  await waitFor(() => script("const e = document.querySelector(arguments[0]); return !!e && !e.disabled && !e.closest('[inert], [hidden]') && getComputedStyle(e).visibility === 'visible' && e.getBoundingClientRect().width > 0;", [selector]), selector);
  const found = await request("POST", `/session/${session}/element`, { using: "css selector", value: selector });
  await request("POST", `/session/${session}/element/${found["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
}
const visible = () => run(probe, [String(pid)], { timeout: 5000 }).trim() === "visible";
const executablePattern = "^" + executable.replace(/[.*+?^$(){}|[\]\\]/g, "\\$&");
function appPids() {
  const result = spawnSync("/usr/bin/pgrep", ["-f", executablePattern], { encoding: "utf8" });
  return result.stdout.split("\n").filter(Boolean).map(Number);
}
// `open` hands its own environment to the app. Use launchd's defaults, which
// are what Finder, the Dock and Login Items provide, not this runner's shell.
const launchdEnv = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
for (const key of ["HOME", "USER", "LOGNAME", "SHELL", "TMPDIR"]) if (process.env[key]) launchdEnv[key] = process.env[key];
const openApp = (args = []) => run("/usr/bin/open", ["-a", bundle, ...args], { env: launchdEnv });

try {
  // The test bundle wraps the debug WebDriver binary with the product's identity.
  mkdirSync(join(bundle, "Contents/MacOS"), { recursive: true });
  copyFileSync(resolve(".codex-target/debug/aiolm"), executable);
  chmodSync(executable, 0o755);
  const version = JSON.parse(readFileSync("package.json", "utf8")).version;
  const minimum = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).bundle.macOS.minimumSystemVersion;
  writeFileSync(join(bundle, "Contents/Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>aiolm</string>
<key>CFBundleIdentifier</key><string>com.aiolm.desktop</string>
<key>CFBundleName</key><string>AioLM</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>${minimum}</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`);
  run("/usr/bin/codesign", ["--force", "--sign", "-", bundle]);

  // Report the PATH an MCP server receives as its only tool's description.
  writeFileSync(fixture, `import { createInterface } from "node:readline";
createInterface({ input: process.stdin }).on("line", line => {
  const message = JSON.parse(line);
  const result = message.method === "initialize" ? {}
    : message.method === "tools/list" ? { tools: [{ name: "launch_path", description: process.env.PATH ?? "", inputSchema: { type: "object" } }] }
    : undefined;
  if (result !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
});
`);
  for (const path of [process.execPath, fixture]) assert.ok(!path.includes("'"), path);
  writeFileSync(join(root, "launcher"), `#!/bin/sh\nexec '${process.execPath}' '${fixture}'\n`);
  assert.ok(!existsSync(launcher), "refuse to replace an existing command");
  installedLauncher = true;
  run("sudo", ["/bin/mkdir", "-p", "/usr/local/bin"]);
  run("sudo", ["/usr/bin/install", "-m", "0755", join(root, "launcher"), launcher]);
  console.log(`launchd user PATH override: ${spawnSync("/bin/launchctl", ["getenv", "PATH"], { encoding: "utf8" }).stdout.trim() || "(none)"}`);

  const reservation = createServer();
  await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", resolve); });
  port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  assert.deepEqual(appPids(), [], "no test app may already run");
  openApp(["--stdout", log, "--stderr", log,
    ...Object.entries({ ...appEnv, TAURI_WEBDRIVER_PORT: String(port) }).flatMap(([key, value]) => ["--env", `${key}=${value}`])]);
  await waitFor(() => appPids().length === 1, "LaunchServices started the app");
  [pid] = appPids();
  await waitFor(() => request("GET", "/status"), "embedded WebDriver startup");
  const created = await request("POST", "/session", { capabilities: { alwaysMatch: { "wdio:tauriServiceOptions": { windowLabel: "main" } } } });
  session = created.sessionId;
  await waitFor(() => visible(), "native app window");

  await waitFor(() => script("return !!document.querySelector('.setup-form');"), "fresh onboarding");
  await click(".setup-form button[type=submit]");
  await click(".setup-form button[type=submit]");
  await click(".setup-form button[type=submit]");
  await waitFor(() => script("return !!document.querySelector('.aiolm-sidebar nav');"), "workspace after onboarding");
  await click(".aiolm-sidebar .aiolm-nav-group:last-child button:last-child");
  await click("#settings-tab-server");
  await click("#settings-close-to-tray");
  const configPath = join(appEnv.AIOLM_HOME, "config.json");
  await waitFor(() => JSON.parse(readFileSync(configPath, "utf8")).close_to_tray, "close-to-tray saved");
  await script("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }), 100); return true;");
  await waitFor(() => !visible(), "close hides the window");
  assert.ok(alive(), "tray close must keep the app running");
  // Finder and the Dock reopen the running copy instead of starting another.
  openApp();
  await waitFor(() => visible(), "LaunchServices reopen restores the hidden window");
  assert.deepEqual(appPids(), [pid], "reopen must not start a second instance");

  const server = { id: "launch-path", name: "Launch PATH", command: launcher.split("/").pop(), args: [], enabled: true };
  const saved = await invoke("mcp_save_server", { server });
  assert.equal(saved.failure, undefined, saved.failure);
  const listed = await invoke("mcp_list_tools", { id: server.id });
  assert.equal(listed.failure, undefined, `MCP command lookup from a LaunchServices start: ${listed.failure}`);
  const searchPath = listed.result[0].description.split(":");
  console.log(`LaunchServices app PATH: ${searchPath.join(":")}`);
  assert.equal(searchPath.slice(0, 4).join(":"), launchdEnv.PATH, "the app must start from launchd's PATH");
  for (const directory of ["/usr/bin", "/usr/local/bin", ...(existsSync("/opt/homebrew/bin") ? ["/opt/homebrew/bin"] : [])]) {
    assert.ok(searchPath.includes(directory), `${directory} is missing from ${searchPath.join(":")}`);
  }

  // The standard quit request is what the Dock menu and Command-Q send.
  run(terminate, [String(pid)]);
  await waitFor(() => !alive(), "quit request exits the app");
  assert.ok(!appLog().includes("panicked"), appLog());
  assert.deepEqual(appPids(), []);
  assert.equal(spawnSync("/usr/bin/pgrep", ["-f", fixture]).status, 1, "MCP server must not outlive the app");
  console.log(`macOS ${process.arch}: LaunchServices launch, tray close, reopen, MCP command lookup and quit passed.`);
} catch (error) {
  console.error(`LaunchServices failure: pid=${pid}, alive=${pid !== undefined && alive()}\n${appLog().slice(-8000)}`);
  throw error;
} finally {
  if (pid !== undefined && alive()) {
    spawnSync("/bin/kill", ["-KILL", String(pid)]);
    await delay(1000);
  }
  if (installedLauncher) spawnSync("sudo", ["/bin/rm", "-f", launcher]);
  rmSync(root, { recursive: true, force: true });
}
