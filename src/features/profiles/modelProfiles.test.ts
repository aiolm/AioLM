import { beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../../shared/api/types";
import { activeProfilesPatch, createModelProfile, createServerProfile, defaultModelProfile, defaultServerProfile, deleteModelProfile, duplicateModelProfile, getActiveModelProfile, loadProfiles, modelProfilePatch, profileDirtyFields, saveModelProfile, saveProfileSelection, serverProfilePatch, MODEL_PROFILES_STORAGE_KEY } from "./modelProfiles";

const cfg = {
  active_backend: "", ctx_size: 4096, batch_size: 2048, ubatch_size: 512, keep: 0,
  cache_type_k: "f16", cache_type_v: "f16", ngl: 10, n_cpu_moe: 0, threads: 8, parallel: 1,
  request_timeout_seconds: 60, sleep_idle_seconds: -1, flash_attn: "auto", spec_type: "none", spec_draft_n_max: 16,
  spec_draft_n_min: 0, spec_draft_p_min: 0, spec_draft_p_split: 0, spec_draft_ngl: "auto", spec_draft_device: "",
  spec_draft_model: "", reasoning: "on", reasoning_format: "deepseek", reasoning_effort: "default", reasoning_budget: -1,
  reasoning_budget_message: "", reasoning_preserve: "", mmproj: "", server_args: [], chat_options: { max_tokens: 512 },
  temperature: 0.7, top_p: 0.9, top_k: 40, models_dir: "models", port: 8080, active_model: "", active_build: "",
  iters: 1, lora_adapters: [], config_version: 1,
} as AppConfig;

describe("model profiles", () => {
  beforeEach(() => localStorage.clear());

  it.each(["", undefined])("preserves the current runtime for an incomplete saved backend profile (build: %s)", (build) => {
    const profile = { ...defaultServerProfile(cfg), backend: "vulkan", build, ctx_size: 8192 };
    localStorage.setItem(MODEL_PROFILES_STORAGE_KEY, JSON.stringify({ version: 4, server: [profile], model: [], activeServerIds: {} }));
    const current = { ...cfg, active_backend: "rocm", active_build: "local_b10840_nop2p" };
    expect({ ...current, ...activeProfilesPatch(current, "model.gguf") }).toMatchObject({
      active_backend: "rocm", active_build: "local_b10840_nop2p", ctx_size: 8192,
    });
  });

  it("applies the default system runtime as an empty backend and build pair", () => {
    expect(defaultServerProfile(cfg).backend).toBe("PATH");
    expect(activeProfilesPatch(cfg, "model.gguf")).toMatchObject({ active_backend: "", active_build: "" });
    expect(profileDirtyFields(defaultServerProfile(cfg), cfg)).toEqual([]);
  });

  it("clears a managed build when applying a saved PATH profile", () => {
    const profile = { ...defaultServerProfile(cfg), build: undefined };
    localStorage.setItem(MODEL_PROFILES_STORAGE_KEY, JSON.stringify({ version: 4, server: [profile], model: [], activeServerIds: {} }));
    const managed = { ...cfg, active_backend: "vulkan", active_build: "b100" };
    expect({ ...managed, ...activeProfilesPatch(managed, "model.gguf") }).toMatchObject({ active_backend: "", active_build: "" });
    expect(serverProfilePatch({ ...profile, build: "b100" })).toMatchObject({ active_backend: "", active_build: "" });
  });

  it("restores the runtime build and explicit or automatic GPU placement", () => {
    const automatic = defaultServerProfile({ ...cfg, active_backend: "vulkan", active_build: "b100" });
    expect(serverProfilePatch(automatic)).toMatchObject({ active_backend: "vulkan", active_build: "b100", gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null } });
    const explicit = defaultServerProfile({ ...cfg, gpu: { gpu_ids: ["runtime:vulkan:Vulkan0"], split_mode: "none", tensor_split: [] } });
    expect(serverProfilePatch(explicit).gpu?.gpu_ids).toEqual(["runtime:vulkan:Vulkan0"]);
  });

  it("round trips runtime defaults across both profile groups", () => {
    const inherited = { ...cfg, runtime_defaults: ["ctx_size", "ngl", "temperature", "reasoning_effort"] };
    const server = defaultServerProfile(inherited);
    const model = defaultModelProfile(inherited);
    expect(server.runtime_defaults).toEqual(["ctx_size", "ngl"]);
    expect(model.runtime_defaults).toEqual(["temperature", "reasoning_effort"]);
    expect(profileDirtyFields(server, inherited)).toEqual([]);
    expect(profileDirtyFields(model, inherited)).toEqual([]);
    expect(activeProfilesPatch(inherited, "model.gguf").runtime_defaults).toEqual(inherited.runtime_defaults);
  });

  it("does not infer inheritance for an older explicit profile", () => {
    const legacy = defaultServerProfile(cfg);
    delete legacy.runtime_defaults;
    localStorage.setItem("aiolm-model-profiles", JSON.stringify({ version: 3, server: [legacy], model: [], activeServerIds: {}, activeModelIds: {} }));
    expect(loadProfiles({ ...cfg, runtime_defaults: ["ngl"] }, "model.gguf").server[0].runtime_defaults).toEqual([]);
  });

  it("creates and loads independent server and model profiles", () => {
    const server = createServerProfile(cfg, "Fast");
    const model = createModelProfile(cfg, "Creative");
    localStorage.setItem("aiolm-model-profiles", JSON.stringify({ version: 2, server: [server], model: [model], activeServerId: server.id, activeModelIds: { "models/a.gguf": model.id } }));
    const loaded = loadProfiles(cfg, "models/a.gguf");
    expect(loaded.server[0].name).toBe("Fast");
    expect(loaded.model[0].name).toBe("Creative");
  });

  it("maps all supported fields and reports dirty values", () => {
    const server = defaultServerProfile(cfg);
    const model = defaultModelProfile(cfg);
    expect(serverProfilePatch(server)).toHaveProperty("ctx_size", 4096);
    expect(modelProfilePatch({ ...model, stop_strings: ["<end>"] })).toMatchObject({ temperature: 0.7, chat_options: { stop: ["<end>"] } });
    expect(modelProfilePatch({ ...model, chat_options: { stop: ["stale"], max_tokens: 512 }, stop_strings: [] })).toMatchObject({ chat_options: { max_tokens: 512 } });
    expect(modelProfilePatch({ ...model, chat_options: { stop: ["stale"] }, stop_strings: [] }).chat_options).not.toHaveProperty("stop");
    expect(profileDirtyFields(server, cfg)).toEqual([]);
    expect(profileDirtyFields({ ...model, temperature: 1.1 }, cfg)).toContain("temperature");
  });

  it("remembers a different default server tuning profile for each model", () => {
    const fast = { ...createServerProfile(cfg, "Fast"), id: "server-fast", ctx_size: 2048 };
    const quality = { ...createServerProfile(cfg, "Quality"), id: "server-quality", ctx_size: 8192 };
    const modelA = { ...createModelProfile(cfg, "A"), id: "model-a" };
    const modelB = { ...createModelProfile(cfg, "B"), id: "model-b" };
    localStorage.setItem("aiolm-model-profiles", JSON.stringify({
      version: 3,
      server: [fast, quality],
      model: [modelA, modelB],
      activeServerId: fast.id,
      activeServerIds: { "models/a.gguf": fast.id, "models/b.gguf": quality.id },
      activeModelIds: { "models/a.gguf": modelA.id, "models/b.gguf": modelB.id },
    }));

    expect(loadProfiles(cfg, "models/a.gguf").activeServerId).toBe(fast.id);
    expect(loadProfiles(cfg, "models/b.gguf").activeServerId).toBe(quality.id);
    expect(activeProfilesPatch(cfg, "models/a.gguf")).toHaveProperty("ctx_size", 2048);
    expect(activeProfilesPatch(cfg, "models/b.gguf")).toHaveProperty("ctx_size", 8192);
  });

  it.each([2, 3])("migrates version %s into a shared list without losing saved settings", (version) => {
    const modelA = { ...createModelProfile(cfg, "기본"), modelPath: "models/a.gguf", temperature: 0.2, system_prompt: "Be concise.", stop_strings: ["<end-a>"] };
    const modelB = { ...createModelProfile(cfg, "기본"), modelPath: "models/b.gguf", temperature: 1.2, runtime_defaults: ["top_k"], chat_options: { seed: 42 } };
    localStorage.setItem(MODEL_PROFILES_STORAGE_KEY, JSON.stringify({ version, server: [defaultServerProfile(cfg)], model: [modelA, modelB], activeModelIds: { "models/a.gguf": modelA.id, "models/b.gguf": modelB.id } }));

    const loaded = loadProfiles({ ...cfg, active_model: "models/b.gguf" }, "models/c.gguf");
    expect(loaded.activeModelId).toBe(modelB.id);
    expect(loaded.model).toEqual([
      expect.objectContaining({ id: modelA.id, name: "기본 · a.gguf", temperature: 0.2, system_prompt: "Be concise.", stop_strings: ["<end-a>"] }),
      expect.objectContaining({ id: modelB.id, name: "기본 · b.gguf", temperature: 1.2, runtime_defaults: ["top_k"], chat_options: { seed: 42 } }),
    ]);
    const persisted = JSON.parse(localStorage.getItem(MODEL_PROFILES_STORAGE_KEY)!);
    expect(persisted.version).toBe(4);
    expect(persisted.activeModelIds).toMatchObject({ 'models/a.gguf': modelA.id, 'models/b.gguf': modelB.id, 'models/c.gguf': modelB.id });
    for (const profile of persisted.model) expect(profile).not.toHaveProperty("modelPath");
    expect(loadProfiles(cfg, "models/d.gguf").model).toEqual(loaded.model);
    expect(loadProfiles(cfg, "models/a.gguf").activeModelId).toBe(modelA.id);
  });

  it("reuses the selected profile and prompt when switching models or reloading", () => {
    const initial = loadProfiles(cfg, "models/a.gguf");
    const shared = { ...createModelProfile({ ...cfg, temperature: 1.1 }, "Creative"), system_prompt: "Write creatively." };
    saveModelProfile(shared);
    saveProfileSelection(initial.activeServerId, "models/a.gguf", shared.id);
    for (const modelPath of ["models/b.gguf", "models/c.gguf", "models/a.gguf"]) {
      expect(loadProfiles(cfg, modelPath).activeModelId).toBe(shared.id);
      expect(loadProfiles(cfg, modelPath).model).toHaveLength(2);
      expect(activeProfilesPatch(cfg, modelPath).temperature).toBe(1.1);
      expect(getActiveModelProfile({ ...cfg, active_model: modelPath })?.system_prompt).toBe("Write creatively.");
    }
  });

  it("duplicates, renames and deletes a shared profile globally with a valid fallback", () => {
    const initial = loadProfiles(cfg, "models/a.gguf");
    const copy = duplicateModelProfile(initial.model[0]);
    saveModelProfile({ ...copy, name: "Shared copy" });
    saveProfileSelection(initial.activeServerId, "models/a.gguf", copy.id);
    expect(loadProfiles(cfg, "models/b.gguf").model.find((profile) => profile.id === copy.id)?.name).toBe("Shared copy");
    deleteModelProfile(copy.id);
    const remaining = loadProfiles(cfg, "models/b.gguf");
    expect(remaining.model).toHaveLength(1);
    expect(remaining.activeModelId).toBe(initial.model[0].id);
    deleteModelProfile(remaining.activeModelId);
    expect(loadProfiles(cfg, "models/c.gguf").model).toHaveLength(1);
  });
});
