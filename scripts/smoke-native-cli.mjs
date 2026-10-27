/* global process, console */
// Runs the built CLI with a disposable home, including every migration source.
// No model, GPU, credentials, desktop session or network is needed.
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executable = resolve(process.argv[2] ?? `.codex-target/debug/aiolm-cli${process.platform === "win32" ? ".exe" : ""}`);
const temporary = mkdtempSync(join(tmpdir(), "aiolm-cli-smoke-"));
const home = join(temporary, "home with spaces");
mkdirSync(home);
const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (/^(AIOLM_|LLAMA_BOARD_)/i.test(key)) delete env[key];
}
Object.assign(env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: join(home, "roaming"),
  LOCALAPPDATA: join(home, "local"),
  XDG_CONFIG_HOME: join(home, "config"),
  XDG_DATA_HOME: join(home, "data"),
  XDG_CACHE_HOME: join(home, "cache"),
  AIOLM_HOME: join(home, "aiolm"),
});
const fail = (...args) => {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 1, `${args.join(" ")} should fail: ${result.stdout}`);
  return JSON.parse(result.stdout).error;
};
const run = (...args) => {
  const result = spawnSync(executable, args, { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}\n${result.stdout}`);
  return JSON.parse(result.stdout);
};
try {
  assert.match(run("--help").usage, /aiolm-cli/);
  const initial = run("config", "get");
  assert.equal(initial.active_model, "");
  assert.equal(initial.active_build, "");
  assert.deepEqual(run("runtime", "list"), []);
  assert.equal(run("config", "set", "ctx_size", "8192").ok, true);
  assert.equal(run("config", "get").ctx_size, 8192);
  // Engine options are validated by schema, not by an installed engine, so
  // they can be edited on a host that cannot run vLLM or mlx-vlm.
  const providerOptions = {
    vllm: { max_model_len: 4096, enable_prefix_caching: false, trust_remote_code: false },
    "mlx-vlm": { kv_bits: 4, embedding_model: join(home, "synthetic-embedder") },
  };
  assert.equal(run("config", "set", "provider_options", JSON.stringify(providerOptions)).ok, true);
  const withOptions = run("config", "get");
  assert.deepEqual(withOptions.provider_options, providerOptions);
  for (const invalid of [{ sglang: {} }, { vllm: { max_model_len: "long" } }, { vllm: { trust_remote_code: true } }, { "mlx-vlm": { unknown_option: 1 } }]) {
    assert.match(fail("config", "set", "provider_options", JSON.stringify(invalid)), /provider options cannot be saved|invalid (vllm|mlx-vlm) options/);
  }
  assert.match(fail("config", "set", "provider_options", "{not json"), /JSON object/);
  assert.deepEqual(run("config", "get"), withOptions, "rejected provider options must preserve saved settings");
  const selected = run("runtime", "select", "cpu", "b1234");
  assert.equal(selected.ok, true);
  assert.equal(selected.config.active_backend, "cpu");
  assert.equal(selected.config.active_build, "b1234");
  assert.equal(selected.config.ctx_size, 8192);
  assert.equal(run("config", "get").active_build, "b1234");
  for (const args of [
    ["runtime", "select", "cpu"],
    ["runtime", "select", "../cpu", "b1234"],
    ["runtime", "select", "cpu", "../b1234"],
  ]) {
    const failed = spawnSync(executable, args, { env, encoding: "utf8", timeout: 30_000, windowsHide: true });
    if (failed.error) throw failed.error;
    assert.equal(failed.status, 1, failed.stdout);
    assert.deepEqual(run("config", "get"), selected.config, "invalid selection must preserve saved settings");
  }
  const doctor = run("doctor");
  assert.equal(doctor.config_loaded, true);
  assert.equal(doctor.provider, "llama.cpp");
  assert.equal(doctor.runtime, "b1234-cpu");
  assert.equal(doctor.runtime_ready, false, "a selected but uninstalled runtime is not ready");
  assert.equal(doctor.readiness_source, "executable-presence");
  assert.deepEqual(doctor.runtime_counts, { "llama.cpp": 0, vllm: 0, "mlx-vlm": 0 });
  // Seed only disposable settings: alternate diagnostics must not fall back
  // to the saved llama.cpp build when their selected environment is absent.
  for (const provider of ["vllm", "mlx-vlm"]) {
    for (const activeModel of ["", join(home, "synthetic-model")]) {
      const alternateConfig = { ...selected.config, active_provider: provider, active_runtime: "synthetic-missing", active_model: activeModel };
      delete alternateConfig.settings_profiles;
      writeFileSync(join(home, "aiolm", "config.json"), JSON.stringify(alternateConfig));
      const loaded = run("config", "get");
      assert.equal(loaded.active_provider, provider);
      assert.equal(loaded.active_model, activeModel, "a runtime can be selected before a model");
      const alternate = run("doctor");
      assert.equal(alternate.config_loaded, true);
      assert.equal(alternate.provider, provider);
      assert.equal(alternate.runtime, "synthetic-missing");
      assert.equal(alternate.runtime_ready, false);
      assert.equal(alternate.readiness_source, "live-python-probe");
      assert.ok(alternate.runtime_problem, "missing or unsupported Python environment is diagnosed");
    }
  }
  writeFileSync(join(home, "aiolm", "config.json"), JSON.stringify(selected.config));
  assert.match(fail("runtime", "install", "unknown-engine"), /vllm or mlx-vlm/);
  assert.equal(run("server", "status").state, "stopped");

  // Synthetic library: one app-owned snapshot, one folder without a manifest
  // and one GGUF file. Nothing is downloaded and no engine is started.
  const models = join(home, "models");
  const snapshot = join(models, "hf", "example", "model", "snapshots", "0".repeat(40));
  mkdirSync(join(snapshot, "nested"), { recursive: true });
  writeFileSync(join(snapshot, "config.json"), JSON.stringify({ architectures: ["LlamaForCausalLM"], model_type: "llama" }));
  writeFileSync(join(snapshot, "model.safetensors"), Buffer.alloc(16));
  writeFileSync(join(snapshot, "nested", "tokenizer.json"), "{}");
  writeFileSync(join(snapshot, "user-notes.txt"), "kept");
  writeFileSync(join(snapshot, ".aiolm-snapshot.json"), JSON.stringify({
    format: 1, repository: "example/model", revision: "0".repeat(40), complete: true,
    files: [["config.json", 59], ["model.safetensors", 16], ["nested/tokenizer.json", 2]].map(([path, size]) => ({ path, size })),
  }));
  const external = join(models, "external-snapshot");
  mkdirSync(external);
  writeFileSync(join(external, "config.json"), "{}");
  writeFileSync(join(external, "model.safetensors"), Buffer.alloc(16));
  writeFileSync(join(models, "synthetic.gguf"), Buffer.from("GGUF"));
  assert.equal(run("config", "set", "models_dir", models).ok, true);
  assert.ok(run("models", "list").models.some((model) => model.path.includes("snapshots")), "snapshot is listed");
  assert.equal(run("config", "set", "active_model", snapshot).ok, true);
  assert.match(fail("models", "delete", snapshot), /select another/);
  assert.ok(existsSync(join(snapshot, "model.safetensors")), "a selected snapshot is preserved");
  assert.equal(run("config", "set", "active_model", "").ok, true);
  assert.match(fail("models", "delete", external), /app-owned/);
  assert.ok(existsSync(join(external, "model.safetensors")), "folders without a manifest are never deleted");
  const deleted = run("models", "delete", snapshot);
  assert.equal(deleted.kind, "snapshot");
  assert.equal(deleted.unlisted_files_preserved, true);
  assert.ok(!existsSync(join(snapshot, "model.safetensors")) && !existsSync(join(snapshot, "nested")));
  assert.ok(existsSync(join(snapshot, "user-notes.txt")), "unlisted user files are preserved");
  assert.equal(run("models", "delete", "synthetic.gguf").ok, true, "relative GGUF deletion keeps its syntax");
  assert.ok(!existsSync(join(models, "synthetic.gguf")));
  console.log("Native CLI smoke passed: clean initialization, configuration roundtrip, validated provider options, atomic runtime selection, invalid-selection rollback, provider diagnostics, empty runtimes, stopped server and manifest-owned snapshot deletion.");
} finally {
  // Only this invocation's mkdtemp directory is removed.
  rmSync(temporary, { recursive: true, force: true });
}
