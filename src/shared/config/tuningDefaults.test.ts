import { describe, expect, it } from "vitest";
import { buildChatRequestBody, type AppConfig } from "../api/index";
import { hasChatOverride, removeArgs, resetAllTuning, resetTuningField, RUNTIME_DEFAULT_KEYS, withManualOverrides } from "./tuningDefaults";

const cfg = {
  runtime_defaults: ["threads"], temperature: 1.2, top_p: 0.8, top_k: 20,
  reasoning: "off", reasoning_effort: "high", ngl: 99, ctx_size: 8192,
  active_model: "model.gguf", spec_draft_model: "draft.gguf", mmproj: "vision.gguf",
  active_backend: "vulkan", active_build: "local", port: 8080,
  gpu: { gpu_ids: ["gpu-1"], split_mode: "none" }, sessions: [{ id: "other" }],
  server_args: ["--temp", "1.5", "--seed=-1", "--mirostat-lr", "0.7", "--no-mmap"],
  chat_options: { temperature: 1.7, mirostat_eta: 0.4, min_p: 0.2, seed: 17 },
} as unknown as AppConfig;

describe("runtime-owned tuning defaults", () => {
  it("resets all overrides without touching model files, placement, runtime or sessions", () => {
    const reset = resetAllTuning();
    expect(Object.keys(reset).sort()).toEqual([...RUNTIME_DEFAULT_KEYS, "chat_options", "runtime_defaults", "server_args"].sort());
    const next = { ...cfg, ...reset };
    expect(next.runtime_defaults).toEqual(RUNTIME_DEFAULT_KEYS);
    expect(next.server_args).toEqual([]);
    expect(next.chat_options).toEqual({});
    expect(next).toMatchObject({ ngl: 99, ctx_size: 4096, temperature: 0.8, top_p: 0.95, top_k: 40, reasoning: 'auto', reasoning_effort: 'default' });
    for (const key of ["active_model", "spec_draft_model", "mmproj", "active_backend", "active_build", "port", "gpu", "sessions"] as const) expect(next[key]).toEqual(cfg[key]);
    expect(cfg.server_args).toHaveLength(6);
  });

  it("resets one core value and its raw aliases, preserving other overrides", () => {
    const next = { ...cfg, ...resetTuningField(cfg, "temperature") };
    expect(next.runtime_defaults).toEqual(["threads", "temperature"]);
    expect(next.server_args).toEqual(["--seed=-1", "--mirostat-lr", "0.7", "--no-mmap"]);
    expect(next.chat_options).toEqual({ mirostat_eta: 0.4, min_p: 0.2, seed: 17 });
    expect(next.top_k).toBe(20);
    expect(next.temperature).toBe(0.8);
  });

  it("removes request aliases and CLI equivalents of an advanced sampler", () => {
    expect(hasChatOverride(cfg, "mirostat_lr")).toBe(true);
    const next = { ...cfg, ...resetTuningField(cfg, "mirostat_lr") };
    expect(hasChatOverride(next, "mirostat_lr")).toBe(false);
    expect(next.chat_options.min_p).toBe(0.2);
    expect(next.server_args).toContain("--seed=-1");
  });

  it('forgets typed mirrors when a raw CLI or JSON alias is reset', () => {
    for (const key of ['raw-server:--temp', 'raw-chat:temperature', 'raw-chat:temp']) {
      const next = { ...cfg, ...resetTuningField(cfg, key) };
      expect(next.temperature).toBe(0.8);
      expect(next.runtime_defaults).toContain('temperature');
      expect(next.server_args).not.toContain('--temp');
      expect(next.chat_options).not.toHaveProperty('temperature');
    }
  });

  it("removes equals, negative and repeated values without eating the next flag", () => {
    expect(removeArgs(["--seed", "-1", "--seed=2", "--seed", "--no-mmap"], ["--seed"])).toEqual(["--no-mmap"]);
    expect(removeArgs(["--reasoning-preserve", "--seed", "4"], ["--reasoning-preserve"], true)).toEqual(["--seed", "4"]);
    expect(resetTuningField(cfg, "raw-server:--no-mmap")).toMatchObject({ server_args: cfg.server_args.slice(0, -1) });
    expect(resetTuningField(cfg, "raw-chat:min_p").chat_options).not.toHaveProperty("min_p");
    expect(withManualOverrides(cfg, resetTuningField(cfg, "raw-chat:min_p"))).not.toHaveProperty("temperature");
  });

  it("omits default sampling and reasoning overrides on the wire", () => {
    const next = { ...cfg, ...resetAllTuning() };
    const body = buildChatRequestBody("model", [], { ...next, options: next.chat_options });
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      model: "model", messages: [], stream: true,
      timings_per_token: true, stream_options: { include_usage: true },
    });
    expect(next.chat_options).toEqual({});
  });

  it("single reset does not remove the other sampling request values", () => {
    const next = { ...cfg, ...resetTuningField(cfg, "temperature") };
    const body = buildChatRequestBody("model", [], { ...next, options: next.chat_options });
    expect(body).not.toHaveProperty("temperature");
    expect(body).toMatchObject({ top_p: 0.8, top_k: 20, min_p: 0.2 });
  });

  it("clears inheritance only for explicitly edited fields, including queued edits", () => {
    const inherited = { ...cfg, ...resetAllTuning() };
    const first = { ...inherited, ...withManualOverrides(inherited, { temperature: 0.3 }) };
    const second = withManualOverrides(first, { threads: 4 });
    expect(second.runtime_defaults).not.toContain("temperature");
    expect(second.runtime_defaults).not.toContain("threads");
    expect(second.runtime_defaults).toContain("ngl");
    expect(withManualOverrides(cfg, resetAllTuning())).toEqual(resetAllTuning());
  });

  it("reactivates a reset sampler when edited through raw JSON or arguments", () => {
    const inherited = { ...cfg, ...resetAllTuning() };
    const json = withManualOverrides(inherited, { chat_options: { temperature: 0.25 } });
    expect(json.temperature).toBe(0.25);
    expect(json.runtime_defaults).not.toContain("temperature");
    const cli = withManualOverrides(inherited, { server_args: ["--temp=0.4", "--top-k", "10"] });
    expect(cli).toMatchObject({ temperature: 0.4, top_k: 10 });
    expect(cli.runtime_defaults).not.toContain("temperature");
    expect(cli.runtime_defaults).toContain("top_p");
  });

  it("clears token-count, probability and sampler-sequence aliases", () => {
    const aliased = { ...cfg, server_args: ["-s", "-1", "--sampler-seq", "kpt"], chat_options: { max_completion_tokens: 123, n_predict: 500, logprobs: true, top_logprobs: 10 } };
    expect(resetTuningField(aliased, "seed").server_args).toEqual(["--sampler-seq", "kpt"]);
    expect(resetTuningField(aliased, "samplers").server_args).toEqual(["-s", "-1"]);
    expect(resetTuningField(aliased, "max_tokens").chat_options).toEqual({ logprobs: true, top_logprobs: 10 });
    expect(resetTuningField(aliased, "n_probs").chat_options).toEqual({ max_completion_tokens: 123, n_predict: 500 });
  });
});
