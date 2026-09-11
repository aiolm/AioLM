import type { AppConfig } from "./api";
import { REQUEST_DEFAULT_KEYS } from "./tuningDefaults";
import { cloneGpuPlacement } from "./sessionUtils";

export type ServerProfile = {
  build?: string;
  gpu?: AppConfig["gpu"];
  runtime_defaults?: string[];
  id: string; name: string; backend: string; ctx_size: number; batch_size: number; ubatch_size: number; keep: number; cache_type_k: string; cache_type_v: string;
  ngl: number; n_cpu_moe: number; threads: number; parallel: number;
  request_timeout_seconds: number; sleep_idle_seconds: number; flash_attn: string; spec_type: string; spec_draft_n_max: number;
  spec_draft_n_min: number; spec_draft_p_min: number; spec_draft_p_split: number; spec_draft_ngl: string; spec_draft_device: string;
  spec_draft_model: string; reasoning: string; reasoning_format: string; reasoning_budget: number; reasoning_preserve: string;
  reasoning_budget_message: string; mmproj: string; server_args: string[];
};

export type ModelProfile = {
  runtime_defaults?: string[];
  id: string; name: string; temperature: number; top_p: number; top_k: number; reasoning_effort: string;
  chat_options: AppConfig["chat_options"]; system_prompt: string; stop_strings: string[];
};

type StoredProfiles = { version: 4; server: ServerProfile[]; model: ModelProfile[]; activeServerId: string; activeServerIds: Record<string, string>; activeModelId: string };
type LegacyModelProfile = ModelProfile & { modelPath?: string };
type StoredInput = Omit<Partial<StoredProfiles>, "version" | "model"> & { version?: number; model?: LegacyModelProfile[]; activeModelIds?: Record<string, string> };
const KEY = "llama-board-model-profiles";
const makeId = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
const text = (value: unknown, fallback = "") => typeof value === "string" ? value : fallback;
const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
const sensitiveArg = /^(?:--?)(?:api[-_]?key|token|password|credential|authorization|auth)$/i;
const sanitizeArgs = (value: unknown) => {
  const args = list(value);
  const safe: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [name] = arg.split("=", 1);
    if (sensitiveArg.test(name) || /^(?:bearer|token|sk[-_])/i.test(arg)) {
      if (!arg.includes("=") && args[index + 1] && !args[index + 1].startsWith("-")) index += 1;
      continue;
    }
    safe.push(arg);
  }
  return safe;
};

export function defaultServerProfile(cfg: AppConfig): ServerProfile {
  return {
    build: cfg.active_build,
    gpu: cloneGpuPlacement(cfg.gpu),
    runtime_defaults: (cfg.runtime_defaults ?? []).filter((key) => !REQUEST_DEFAULT_KEYS.includes(key)),
    id: "server-default", name: "기본 서버", backend: cfg.active_backend || "PATH", ctx_size: cfg.ctx_size, batch_size: cfg.batch_size, ubatch_size: cfg.ubatch_size,
    keep: cfg.keep, cache_type_k: cfg.cache_type_k, cache_type_v: cfg.cache_type_v, ngl: cfg.ngl, n_cpu_moe: cfg.n_cpu_moe,
    threads: cfg.threads, parallel: cfg.parallel, request_timeout_seconds: cfg.request_timeout_seconds, sleep_idle_seconds: cfg.sleep_idle_seconds,
    flash_attn: cfg.flash_attn || "auto", spec_type: cfg.spec_type, spec_draft_n_max: cfg.spec_draft_n_max, spec_draft_n_min: cfg.spec_draft_n_min,
    spec_draft_p_min: cfg.spec_draft_p_min, spec_draft_p_split: cfg.spec_draft_p_split, spec_draft_ngl: cfg.spec_draft_ngl,
    spec_draft_device: cfg.spec_draft_device, spec_draft_model: cfg.spec_draft_model, reasoning: cfg.reasoning, reasoning_format: cfg.reasoning_format,
    reasoning_budget: cfg.reasoning_budget, reasoning_preserve: cfg.reasoning_preserve, reasoning_budget_message: cfg.reasoning_budget_message,
    mmproj: cfg.mmproj, server_args: sanitizeArgs(cfg.server_args),
  };
}

export function defaultModelProfile(cfg: AppConfig): ModelProfile {
  return { runtime_defaults: (cfg.runtime_defaults ?? []).filter((key) => REQUEST_DEFAULT_KEYS.includes(key)), id: "model-default", name: "기본", temperature: cfg.temperature, top_p: cfg.top_p, top_k: cfg.top_k,
    reasoning_effort: cfg.reasoning_effort, chat_options: structuredClone(cfg.chat_options), system_prompt: "", stop_strings: typeof cfg.chat_options.stop === "string" ? [cfg.chat_options.stop] : list(cfg.chat_options.stop) };
}

function read(preferredModelPath = ""): StoredProfiles | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as StoredInput | null;
    if (!value || ![2, 3, 4].includes(value.version ?? 0) || !Array.isArray(value.server) || !Array.isArray(value.model)) return null;
    // Keep every saved preset, including different values with the same name.
    // Former model names distinguish legacy duplicates without retaining ownership.
    const names = new Map<string, number>();
    for (const item of value.model) names.set(item.name, (names.get(item.name) ?? 0) + 1);
    const model = value.model.map(({ modelPath, ...profile }) => ({
      ...profile,
      name: value.version !== 4 && modelPath && (names.get(profile.name) ?? 0) > 1
        ? `${profile.name} · ${modelPath.split(/[\\/]/).pop()}` : profile.name,
    }));
    const candidates = value.version === 4 ? [value.activeModelId]
      : [value.activeModelIds?.[preferredModelPath], ...Object.values(value.activeModelIds ?? {})];
    const activeModelId = candidates.find((id) => model.some((profile) => profile.id === id)) ?? model[0]?.id ?? "";
    return { version: 4, server: value.server, model, activeServerId: text(value.activeServerId), activeServerIds: value.activeServerIds ?? {}, activeModelId };
  } catch { return null; }
}
function write(value: StoredProfiles) { try { window.localStorage.setItem(KEY, JSON.stringify(value)); } catch { /* optional */ } }
function current(): StoredProfiles { return read() ?? { version: 4, server: [], model: [], activeServerId: "", activeServerIds: {}, activeModelId: "" }; }
function migrateServer(value: Partial<ServerProfile>, cfg: AppConfig): ServerProfile { return { ...defaultServerProfile(cfg), ...value, gpu: value.gpu, build: value.build ?? (value.backend === cfg.active_backend ? cfg.active_build : ""), runtime_defaults: list(value.runtime_defaults), server_args: list(value.server_args) }; }
function migrateModel(value: Partial<ModelProfile>, cfg: AppConfig): ModelProfile { return { ...defaultModelProfile(cfg), ...value, runtime_defaults: list(value.runtime_defaults), chat_options: value.chat_options && typeof value.chat_options === "object" ? value.chat_options : {}, stop_strings: list(value.stop_strings) }; }

export function loadProfiles(cfg: AppConfig, modelPath: string) {
  const stored = read(cfg.active_model);
  const server = stored?.server.length ? stored.server.map((item) => migrateServer(item, cfg)) : [defaultServerProfile(cfg)];
  const model = stored?.model.map((item) => migrateModel(item, cfg)) ?? [];
  const profiles = model.length ? model : [defaultModelProfile(cfg)];
  const requestedServerId = stored?.activeServerIds?.[modelPath] ?? stored?.activeServerId;
  const activeServerId = requestedServerId && server.some((item) => item.id === requestedServerId) ? requestedServerId : server[0].id;
  const activeModelId = stored?.activeModelId && profiles.some((item) => item.id === stored.activeModelId) ? stored.activeModelId : profiles[0].id;
  write({ version: 4, server, model: profiles, activeServerId, activeServerIds: { ...(stored?.activeServerIds ?? {}), [modelPath]: activeServerId }, activeModelId });
  return { server, model: profiles, activeServerId, activeModelId };
}
export function saveProfileSelection(activeServerId: string, modelPath: string, activeModelId: string) { const value = current(); write({ ...value, activeServerId, activeServerIds: { ...value.activeServerIds, [modelPath]: activeServerId }, activeModelId }); }
export function saveServerProfile(profile: ServerProfile) { const value = current(); write({ ...value, server: [...value.server.filter((item) => item.id !== profile.id), profile] }); }
export function saveModelProfile(profile: ModelProfile) { const value = current(); write({ ...value, model: [...value.model.filter((item) => item.id !== profile.id), profile] }); }
export function deleteServerProfile(profileId: string) { const value = current(); if (value.server.length <= 1) return; const server = value.server.filter((item) => item.id !== profileId); const fallback = server[0].id; write({ ...value, server, activeServerId: value.activeServerId === profileId ? fallback : value.activeServerId, activeServerIds: Object.fromEntries(Object.entries(value.activeServerIds).map(([modelPath, id]) => [modelPath, id === profileId ? fallback : id])) }); }
export function deleteModelProfile(profileId: string) { const value = current(); const model = value.model.filter((item) => item.id !== profileId); if (!model.length) return; write({ ...value, model, activeModelId: value.activeModelId === profileId ? model[0].id : value.activeModelId }); }
export function duplicateServerProfile(profile: ServerProfile): ServerProfile { const copy = { ...profile, id: makeId("server"), name: `${profile.name} 복사`, server_args: [...profile.server_args] }; saveServerProfile(copy); return copy; }
export function duplicateModelProfile(profile: ModelProfile): ModelProfile { const copy = { ...profile, id: makeId("model"), name: `${profile.name} 복사`, chat_options: { ...profile.chat_options }, stop_strings: [...profile.stop_strings] }; saveModelProfile(copy); return copy; }
export function createServerProfile(cfg: AppConfig, name: string) { return { ...defaultServerProfile(cfg), id: makeId("server"), name }; }
export function createModelProfile(cfg: AppConfig, name: string) { return { ...defaultModelProfile(cfg), id: makeId("model"), name }; }

export function serverProfilePatch(profile: ServerProfile): Partial<AppConfig> {
  // PATH is a profile display label; native config uses an empty runtime pair.
  const systemRuntime = !profile.backend || profile.backend === "PATH";
  // Older tuning profiles can have a backend but no build. They cannot identify
  // a runtime, so preserve the current pair instead of saving a partial one.
  const runtime = systemRuntime ? { active_backend: "", active_build: "" }
    : profile.build ? { active_backend: profile.backend, active_build: profile.build } : {};
  return { runtime_defaults: profile.runtime_defaults ?? [], ...runtime, ...(profile.gpu ? { gpu: structuredClone(profile.gpu) } : {}), ctx_size: profile.ctx_size, batch_size: profile.batch_size, ubatch_size: profile.ubatch_size, keep: profile.keep,
    cache_type_k: profile.cache_type_k, cache_type_v: profile.cache_type_v, ngl: profile.ngl, n_cpu_moe: profile.n_cpu_moe, threads: profile.threads, parallel: profile.parallel,
    request_timeout_seconds: profile.request_timeout_seconds, sleep_idle_seconds: profile.sleep_idle_seconds, flash_attn: profile.flash_attn, spec_type: profile.spec_type,
    spec_draft_n_max: profile.spec_draft_n_max, spec_draft_n_min: profile.spec_draft_n_min, spec_draft_p_min: profile.spec_draft_p_min, spec_draft_p_split: profile.spec_draft_p_split,
    spec_draft_ngl: profile.spec_draft_ngl, spec_draft_device: profile.spec_draft_device, spec_draft_model: profile.spec_draft_model, reasoning: profile.reasoning,
    reasoning_format: profile.reasoning_format, reasoning_budget: profile.reasoning_budget, reasoning_preserve: profile.reasoning_preserve,
    reasoning_budget_message: profile.reasoning_budget_message, mmproj: profile.mmproj, server_args: [...profile.server_args] };
}
export function modelProfilePatch(profile: ModelProfile): Partial<AppConfig> {
  const chat_options = { ...profile.chat_options };
  if (profile.stop_strings.length) chat_options.stop = [...profile.stop_strings];
  else delete chat_options.stop;
  return { runtime_defaults: profile.runtime_defaults ?? [], temperature: profile.temperature, top_p: profile.top_p, top_k: profile.top_k, reasoning_effort: profile.reasoning_effort, chat_options };
}
export function getActiveModelProfile(cfg: AppConfig): ModelProfile | null {
  const loaded = loadProfiles(cfg, cfg.active_model);
  return loaded.model.find((profile) => profile.id === loaded.activeModelId) ?? null;
}
export function activeProfilesPatch(cfg: AppConfig, modelPath: string): Partial<AppConfig> {
  if (!modelPath) return {};
  const loaded = loadProfiles(cfg, modelPath);
  const server = loaded.server.find((profile) => profile.id === loaded.activeServerId);
  const model = loaded.model.find((profile) => profile.id === loaded.activeModelId);
  return {
    ...(server ? serverProfilePatch(server) : {}),
    ...(model ? modelProfilePatch(model) : {}),
    runtime_defaults: [...(server?.runtime_defaults ?? []), ...(model?.runtime_defaults ?? [])],
  };
}
export function profileDirtyFields(profile: ServerProfile | ModelProfile, cfg: AppConfig): string[] {
  const patch = "temperature" in profile ? modelProfilePatch(profile) : serverProfilePatch(profile);
  return Object.keys(patch).filter((key) => {
    const current = key === "runtime_defaults" ? (cfg.runtime_defaults ?? []).filter((field) => REQUEST_DEFAULT_KEYS.includes(field) === ("temperature" in profile)).sort() : key === "gpu" ? cloneGpuPlacement(cfg.gpu) : cfg[key as keyof AppConfig];
    const value = key === "runtime_defaults" ? [...(patch.runtime_defaults ?? [])].sort() : patch[key as keyof typeof patch];
    return JSON.stringify(value) !== JSON.stringify(current);
  });
}
export { KEY as MODEL_PROFILES_STORAGE_KEY };
