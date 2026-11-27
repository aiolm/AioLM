import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { DEV_TAURI_CONFIG, prepareTauriInvocation } from "./tauri.mjs";

const ROOT = resolve(import.meta.dirname, "..");

test("tauri dev defaults to isolated dev config, AIOLM_HOME, legacy skip and disabled benchmark API", () => {
  const inputArgs = ["dev", "--", "--features", "custom"];
  const inputEnv = { PATH: "/usr/bin" };
  const result = prepareTauriInvocation({
    args: inputArgs,
    env: inputEnv,
    root: ROOT,
    platform: "win32",
  });

  assert.deepEqual(inputArgs, ["dev", "--", "--features", "custom"]);
  assert.deepEqual(inputEnv, { PATH: "/usr/bin" });
  assert.deepEqual(result.args, ["dev", "--config", DEV_TAURI_CONFIG, "--", "--features", "custom"]);
  assert.equal(result.env.AIOLM_HOME, resolve(ROOT, "tmp", "dev-home"));
  assert.equal(result.env.AIOLM_SKIP_LEGACY_MIGRATION, "1");
  assert.equal(result.env.AIOLM_BENCHMARK_API_URL, "off");
  assert.equal(result.registerLinuxDev, false);

  const linux = prepareTauriInvocation({
    args: ["dev"],
    env: {},
    root: ROOT,
    platform: "linux",
  });
  assert.equal(linux.registerLinuxDev, true);
});

test("explicit Tauri config flags suppress default dev config injection while Cargo flags after -- do not", () => {
  for (const args of [
    ["dev", "--config", "tmp/custom.conf.json"],
    ["dev", "-c", "tmp/custom.conf.json"],
    ["dev", "--config=tmp/custom.conf.json"],
  ]) {
    const result = prepareTauriInvocation({ args, env: {}, root: ROOT, platform: "darwin" });
    assert.deepEqual(result.args, args);
  }

  const withCargoConfig = prepareTauriInvocation({
    args: ["dev", "--", "--config", "net.offline=true"],
    env: {},
    root: ROOT,
    platform: "win32",
  });
  assert.deepEqual(withCargoConfig.args, [
    "dev", "--config", DEV_TAURI_CONFIG, "--", "--config", "net.offline=true",
  ]);
});

test("explicit environment overrides for AIOLM_HOME, legacy migration and benchmark URL are preserved", () => {
  const customHome = resolve(ROOT, "tmp", "custom-home");
  const result = prepareTauriInvocation({
    args: ["dev"],
    env: {
      AIOLM_HOME: customHome,
      AIOLM_SKIP_LEGACY_MIGRATION: "0",
      AIOLM_BENCHMARK_API_URL: "http://127.0.0.1:4317",
    },
    root: ROOT,
    platform: "win32",
  });

  assert.equal(result.env.AIOLM_HOME, customHome);
  assert.equal(result.env.AIOLM_SKIP_LEGACY_MIGRATION, "0");
  assert.equal(result.env.AIOLM_BENCHMARK_API_URL, "http://127.0.0.1:4317");
});

test("non-dev Tauri commands pass arguments and environment through unchanged", () => {
  for (const args of [["build"], ["bundle", "--bundles", "nsis"], ["info"], []]) {
    const env = { PATH: "/usr/bin" };
    const result = prepareTauriInvocation({ args, env, root: ROOT, platform: "linux" });
    assert.deepEqual(result.args, args);
    assert.deepEqual(result.env, env);
    assert.equal(result.registerLinuxDev, false);
  }
});

test("dev Tauri override config isolates identifier and productName while matching window chrome settings", () => {
  const prod = /** @type {{ identifier: string, productName: string, app: { windows: Record<string, unknown>[] } }} */ (
    JSON.parse(readFileSync(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8"))
  );
  const dev = /** @type {{ identifier: string, productName: string, app: { windows: Record<string, unknown>[] } }} */ (
    JSON.parse(readFileSync(resolve(ROOT, DEV_TAURI_CONFIG), "utf8"))
  );

  assert.notEqual(dev.identifier, prod.identifier);
  assert.notEqual(dev.productName, prod.productName);
  assert.equal(dev.app.windows.length, 1);
  assert.equal(prod.app.windows.length, 1);

  const prodWindow = /** @type {Record<string, unknown>} */ (prod.app.windows[0]);
  const devWindow = /** @type {Record<string, unknown>} */ (dev.app.windows[0]);
  assert.notEqual(devWindow.title, prodWindow.title);

  const prodRest = { ...prodWindow };
  const devRest = { ...devWindow };
  delete prodRest.title;
  delete devRest.title;
  assert.deepEqual(devRest, prodRest);
});
