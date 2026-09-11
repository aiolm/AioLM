import { vi } from "vitest";
import type { AppConfig } from "../shared/api/types";
import type { AppStore } from "../shared/state/store";

export const testConfig: AppConfig = {
  config_version: 7, models_dir: "models", port: 8080,
  active_model: "model.gguf", active_backend: "cpu", active_build: "b123",
  ctx_size: 4096, ngl: 0, batch_size: 2048, ubatch_size: 512, keep: 0,
  cache_type_k: "f16", cache_type_v: "f16", flash_attn: "auto", n_cpu_moe: 0, threads: 0,
  parallel: 0, request_timeout_seconds: 3600, sleep_idle_seconds: -1,
  temperature: 0.8, top_p: 0.95, top_k: 40,
  spec_type: "none", spec_draft_n_max: 3, spec_draft_n_min: 0, spec_draft_p_min: 0, spec_draft_p_split: 0.1,
  spec_draft_ngl: "auto", spec_draft_device: "", spec_draft_model: "",
  reasoning: "auto", reasoning_format: "auto", reasoning_effort: "default", reasoning_budget: -1,
  reasoning_budget_message: "", reasoning_preserve: "auto", server_args: [], chat_options: {}, mmproj: "", iters: 5, lora_adapters: [],
};

export function createTestStore(overrides: Partial<AppConfig> = {}): AppStore {
  const cfg = { ...structuredClone(testConfig), ...overrides };
  return {
    cfg, status: { state: "stopped" }, busy: false, bootState: "ready",
    bootError: null, actionError: null, statusPollError: null,
    getConfig: () => cfg, getConfigRevision: () => 1,
    loadConfig: vi.fn(async () => undefined), refreshStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async (patch) => Object.assign(cfg, typeof patch === "function" ? patch(cfg) : patch)),
    start: vi.fn(async () => "http://127.0.0.1:8080/v1"), stop: vi.fn(async () => undefined),
    clearActionError: vi.fn(), clearErrors: vi.fn(),
  };
}
