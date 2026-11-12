/* global process, console, fetch, AbortSignal */
// Drive the real WKWebView through the opt-in debug WebDriver, using only a
// disposable home. Distribution apps never enable this automation endpoint.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "darwin");
assert.equal(process.env.GITHUB_ACTIONS, "true");
assert.equal(process.env.RUNNER_ENVIRONMENT, "github-hosted");
assert.ok(process.env.RUNNER_TEMP);
const root = mkdtempSync(join(process.env.RUNNER_TEMP, "aiolm-wkwebview-"));
const home = join(root, "synthetic home 한글");
mkdirSync(home);
const env = { ...process.env };
for (const key of Object.keys(env)) if (/^(AIOLM_|LLAMA_BOARD_)/i.test(key)) delete env[key];
Object.assign(env, {
  HOME: home, USERPROFILE: home, APPDATA: join(home, "roaming"), LOCALAPPDATA: join(home, "local"),
  XDG_CONFIG_HOME: join(home, "config"), XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"), AIOLM_HOME: join(home, "aiolm"),
});
const reservation = createServer();
await new Promise((resolve, reject) => { reservation.once("error", reject); reservation.listen(0, "127.0.0.1", () => resolve(undefined)); });
const port = /** @type {import("node:net").AddressInfo} */ (reservation.address()).port;
await new Promise(resolve => reservation.close(resolve));
env.TAURI_WEBDRIVER_PORT = String(port);
const executable = resolve(".codex-target/debug/aiolm");
const probe = resolve("tmp/macos-window-probe");
/** @type {import("node:child_process").ChildProcessByStdio<null, import("node:stream").Readable, import("node:stream").Readable> | undefined} */
let app;
/** @type {string | undefined} */
let session;
let log = "";
/** @param {import("node:child_process").ChildProcess} child */
const exited = child => child.exitCode !== null || child.signalCode !== null;

/** @param {() => unknown | Promise<unknown>} check @param {string} description */
async function waitFor(check, description) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(200);
  }
  throw new Error(`${description}: ${lastError ?? "timed out"}\n${log.slice(-4000)}`);
}
/** @param {string} method @param {string} path @param {unknown} [data] */
async function request(method, path, data) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "content-type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  assert.ok(response.ok && !result.value?.error, JSON.stringify(result));
  return result.value;
}
/** @param {string} code @param {unknown[]} [args] */
const script = (code, args = []) => request("POST", `/session/${session}/execute/sync`, { script: code, args });
/** @param {string} selector */
async function click(selector) {
  await waitFor(() => script("const e = document.querySelector(arguments[0]); return !!e && !e.disabled && !e.closest('[inert], [hidden]') && getComputedStyle(e).visibility === 'visible' && e.getBoundingClientRect().width > 0;", [selector]), selector);
  const found = await request("POST", `/session/${session}/element`, { using: "css selector", value: selector });
  await request("POST", `/session/${session}/element/${found["element-6066-11e4-a52e-4f735466cecf"]}/click`, {});
}
function visible() {
  const result = spawnSync(probe, [String(/** @type {NonNullable<typeof app>} */ (app).pid)], { encoding: "utf8", timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim() === "visible";
}
async function launch() {
  log = "";
  app = spawn(executable, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  app.on("error", error => { log += String(error); });
  app.stdout.on("data", chunk => { log += chunk.toString(); });
  app.stderr.on("data", chunk => { log += chunk.toString(); });
  await waitFor(() => request("GET", "/status"), "embedded WebDriver startup");
  const created = await request("POST", "/session", { capabilities: { alwaysMatch: { "wdio:tauriServiceOptions": { windowLabel: "main" } } } });
  assert.equal(created.capabilities.platformName, "macos");
  assert.equal(created.capabilities.browserName, "webkit");
  session = created.sessionId;
  await waitFor(() => visible(), "native app window");
  return app;
}
// Invoke the app's ordinary CloseRequested path. WebDriver's window DELETE
// destroys the window directly and would bypass close-to-tray behavior.
async function closeWindow() {
  await script("setTimeout(() => window.__TAURI_INTERNALS__.invoke('plugin:window|close', { label: 'main' }), 100); return true;");
}

try {
  let runningApp = await launch();
  await waitFor(() => script("return !!document.querySelector('.setup-form');"), "fresh onboarding");
  assert.equal(await script("return document.documentElement.lang;"), "en");
  assert.equal(await request("POST", `/session/${session}/execute/async`, {
    script: "const done = arguments[arguments.length - 1]; window.__TAURI_INTERNALS__.invoke('plugin:window|is_decorated', { label: 'main' }).then(done);", args: [],
  }), true, "macOS retains its native window controls");
  assert.equal(await script("return !!document.querySelector('.app-titlebar button');"), false, "native controls are not duplicated in the webview");
  await click(".setup-form button[type=submit]");
  await click("label:has(input[name=setup-theme][value=dark])");
  await click(".setup-form button[type=submit]");
  await click(".setup-form button[type=submit]");
  await waitFor(() => script("return !!document.querySelector('.aiolm-sidebar nav');"), "workspace after native onboarding save");
  assert.equal(JSON.parse(readFileSync(join(/** @type {string} */ (env.AIOLM_HOME), "config.json"), "utf8")).onboarding_completed, true);
  const settings = '.aiolm-sidebar button[data-view-target="settings"]';
  await click(settings);
  await click("#settings-tab-server");
  const trayState = () => script("return document.querySelector('#settings-close-to-tray')?.getAttribute('aria-checked');");
  await waitFor(async () => ["true", "false"].includes(await trayState()), "tray preference control");
  if (await trayState() !== "true") await click("#settings-close-to-tray");
  await waitFor(() => JSON.parse(readFileSync(join(/** @type {string} */ (env.AIOLM_HOME), "config.json"), "utf8")).close_to_tray === true, "enable tray close");
  // Snapshot only after fonts and paint boundaries settle. DOM geometry alone
  // exists while InitialSurface still keeps the actual settings view hidden.
  await request("POST", `/session/${session}/execute/async`, {
    script: "const done = arguments[arguments.length - 1]; document.fonts.ready.then(() => requestAnimationFrame(() => requestAnimationFrame(() => done(true))));", args: [],
  });
  const screenshot = Buffer.from(await request("GET", `/session/${session}/screenshot`), "base64");
  mkdirSync("tmp", { recursive: true });
  writeFileSync("tmp/macos-ui.png", screenshot);
  await closeWindow();
  await waitFor(() => !visible(), "close hides the window to its tray");
  assert.ok(!exited(runningApp), `tray close must keep the app alive: ${runningApp.signalCode}\n${log}`);
  const second = spawn(executable, [], { env, stdio: "ignore" });
  await new Promise((resolve, reject) => { second.once("error", reject); second.once("exit", code => code === 0 ? resolve(undefined) : reject(new Error(`secondary launch: ${code}`))); });
  await waitFor(() => visible(), "secondary launch restores the existing window");
  await waitFor(async () => ["true", "false"].includes(await trayState()), "restored tray preference control");
  if (await trayState() !== "false") await click("#settings-close-to-tray");
  await waitFor(() => JSON.parse(readFileSync(join(/** @type {string} */ (env.AIOLM_HOME), "config.json"), "utf8")).close_to_tray === false, "disable tray close");
  await closeWindow();
  await waitFor(() => exited(runningApp), "ordinary window close exits");
  assert.equal(runningApp.exitCode, 0, `${runningApp.signalCode}\n${log}`);
  runningApp = await launch();
  await waitFor(() => script("return !!document.querySelector('.aiolm-sidebar nav');"), "saved onboarding on relaunch");
  assert.equal(await script("return !!document.querySelector('.setup-form');"), false);
  assert.equal(await script("return JSON.parse(localStorage.getItem('aiolm-preferences')).values.theme;"), "dark");
  await closeWindow();
  await waitFor(() => exited(runningApp), "relaunch closes cleanly");
  assert.equal(runningApp.exitCode, 0, `${runningApp.signalCode}\n${log}`);
  console.log(`macOS ${process.arch}: real WKWebView onboarding, native settings, native frame, tray close, single-instance restore and preference persistence passed.`);
} catch (error) {
  console.error(`WKWebView failure: exit=${app?.exitCode}, signal=${app?.signalCode}\n${log.slice(-8000)}`);
  throw error;
} finally {
  if (app && !exited(app)) {
    const child = app;
    child.kill("SIGKILL");
    await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  }
  rmSync(root, { recursive: true, force: true });
}
