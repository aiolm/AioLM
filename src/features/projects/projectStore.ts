import type { AppConfig, LoraAdapterConfig } from "../../shared/api/types";
import type { JsonObject } from "../../shared/config/tuningValidation";
import type { ProfileApplication } from "../../shared/config/settingsProfiles";
import type { ExecutionKey, ExecutionSettings } from "../../shared/config/executionSettings";

export const PROJECTS_KEY = "aiolm.projects.v1";
export const ACTIVE_PROJECT_KEY = "aiolm.active-project.v1";
export const PROJECTS_CHANGED_EVENT = "aiolm-projects-changed";

export const MAX_PROJECTS = 100;
export const MAX_PROJECT_TOOLS = 128;
export const MAX_PROJECT_DOCUMENTS = 16;
export const MAX_PROJECT_RUNTIME_DEFAULTS = 128;

/** Project snapshots always cover exactly the execution settings. Keep derived so a new EXECUTION_KEYS entry cannot be missed. */
export type ProjectConfigKey = ExecutionKey;

export type ProjectConfig = ExecutionSettings;

export interface ProjectDocument {
  name: string;
  path: string;
}

export interface ProjectPreset {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  config: ProjectConfig;
  profileApplication?: ProfileApplication;
  documentBindings: ProjectDocument[];
  toolIds: string[];
  createdAt: number;
  updatedAt: number;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const next = Math.trunc(numberValue(value, fallback));
  if (!Number.isFinite(next)) return fallback;
  return Math.min(max, Math.max(min, next));
}

function clampFloat(value: unknown, fallback: number, min: number, max: number): number {
  const next = numberValue(value, fallback);
  return Math.min(max, Math.max(min, next));
}

function safeClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

const PROJECT_CACHE_TYPES = new Set(["f16", "f32", "bf16", "q8_0", "q5_0", "q5_1", "q4_0", "q4_1"]);

function stringList(value: unknown, limit: number): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, limit) : [];
}

function jsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return safeClone(value) as JsonObject;
}

function loraAdapters(value: unknown): LoraAdapterConfig[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Partial<LoraAdapterConfig> => !!item && typeof item === "object")
    .map((item) => ({
      path: stringValue(item.path).slice(0, 32_768),
      scale: Math.max(0, Math.min(4, numberValue(item.scale, 1))),
      enabled: item.enabled !== false,
    }))
    .filter((item) => item.path.toLowerCase().endsWith(".gguf"))
    .slice(0, 32);
}

function normalizeConfig(value: unknown): ProjectConfig {
  const source = value && typeof value === "object" ? value as Partial<ProjectConfig> : {};
  const batch_size = clampInt(source.batch_size, 2048, 1, 131072);
  const ubatch_size = Math.min(batch_size, clampInt(source.ubatch_size, 512, 1, 131072));
  const keep = clampInt(source.keep, 0, 0, 131072);
  const cache_type_k = typeof source.cache_type_k === "string" && PROJECT_CACHE_TYPES.has(source.cache_type_k) ? source.cache_type_k : "f16";
  const cache_type_v = typeof source.cache_type_v === "string" && PROJECT_CACHE_TYPES.has(source.cache_type_v) ? source.cache_type_v : "f16";
  return {
    runtime_defaults: stringList(source.runtime_defaults, MAX_PROJECT_RUNTIME_DEFAULTS),
    ...(source.gpu ? { gpu: safeClone(source.gpu) } : {}),
    active_model: stringValue(source.active_model),
    active_backend: stringValue(source.active_backend),
    active_build: stringValue(source.active_build),
    mmproj: stringValue(source.mmproj),
    ctx_size: clampInt(source.ctx_size, 4096, 1, 1_048_576),
    batch_size,
    ubatch_size,
    keep,
    cache_type_k,
    cache_type_v,
    ngl: clampInt(source.ngl, 0, 0, 100_000),
    threads: clampInt(source.threads, 0, 0, 1024),
    parallel: clampInt(source.parallel, 0, 0, 1024),
    request_timeout_seconds: Math.max(0, numberValue(source.request_timeout_seconds, 3600)),
    sleep_idle_seconds: Math.max(-1, numberValue(source.sleep_idle_seconds, -1)),
    flash_attn: stringValue(source.flash_attn, "auto"),
    n_cpu_moe: clampInt(source.n_cpu_moe, 0, 0, 1024),
    temperature: numberValue(source.temperature, 0.8),
    top_p: clampFloat(source.top_p, 0.95, 0, 1),
    top_k: clampInt(source.top_k, 40, 0, 1000),
    spec_type: stringValue(source.spec_type, "none"),
    spec_draft_n_max: clampInt(source.spec_draft_n_max, 3, 0, 1024),
    spec_draft_n_min: clampInt(source.spec_draft_n_min, 0, 0, 1024),
    spec_draft_p_min: clampFloat(source.spec_draft_p_min, 0, 0, 1),
    spec_draft_p_split: clampFloat(source.spec_draft_p_split, 0.1, 0, 1),
    spec_draft_ngl: stringValue(source.spec_draft_ngl, "auto"),
    spec_draft_device: stringValue(source.spec_draft_device),
    spec_draft_model: stringValue(source.spec_draft_model),
    reasoning: stringValue(source.reasoning, "auto"),
    reasoning_format: stringValue(source.reasoning_format, "auto"),
    reasoning_effort: stringValue(source.reasoning_effort, "default"),
    reasoning_budget: clampInt(source.reasoning_budget, -1, -1, 1_048_576),
    reasoning_budget_message: stringValue(source.reasoning_budget_message),
    reasoning_preserve: stringValue(source.reasoning_preserve, "auto"),
    server_args: Array.isArray(source.server_args) ? source.server_args.filter((item): item is string => typeof item === "string").slice(0, 512) : [],
    chat_options: jsonObject(source.chat_options),
    lora_adapters: loraAdapters(source.lora_adapters),
  };
}

function normalizeProject(value: unknown): ProjectPreset | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ProjectPreset>;
  const name = stringValue(source.name).trim();
  if (!name) return null;
  const now = Date.now();
  const config = normalizeConfig(source.config);
  const systemPrompt = stringValue(source.systemPrompt, "You are a helpful assistant.").slice(0, 32_768);
  const application = source.profileApplication;
  const { active_model: model, ...settings } = config;
  const profileApplication: ProfileApplication | undefined = application && typeof application === 'object'
    && application.model === model && typeof application.profile_id === 'string' && application.profile_id.trim()
    ? {
      model, profile_id: application.profile_id.trim().slice(0, 256),
      ...(typeof application.profile_name === 'string' ? { profile_name: application.profile_name.slice(0, 120) } : {}),
      ...(Number.isSafeInteger(application.profile_revision) && application.profile_revision! >= 0 ? { profile_revision: application.profile_revision } : {}),
      settings: safeClone(settings), system_prompt: systemPrompt,
    } : undefined;
  const documents = Array.isArray(source.documentBindings)
    ? source.documentBindings
      .filter((item): item is ProjectDocument => !!item && typeof item === "object" && typeof (item as ProjectDocument).name === "string" && typeof (item as ProjectDocument).path === "string")
      .slice(0, MAX_PROJECT_DOCUMENTS)
      .map((item) => ({ name: item.name.slice(0, 256), path: item.path.slice(0, 32_768) }))
    : [];
  return {
    id: stringValue(source.id, `project-${now.toString(36)}`),
    name: name.slice(0, 128),
    description: stringValue(source.description).slice(0, 512),
    systemPrompt,
    config,
    ...(profileApplication ? { profileApplication } : {}),
    documentBindings: documents,
    toolIds: stringList(source.toolIds, MAX_PROJECT_TOOLS),
    createdAt: numberValue(source.createdAt, now),
    updatedAt: numberValue(source.updatedAt, now),
  };
}

export function readProjects(store: Storage | null = storage()): ProjectPreset[] {
  if (!store) return [];
  let value: unknown;
  try {
    value = JSON.parse(store.getItem(PROJECTS_KEY) ?? "[]");
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const projects: ProjectPreset[] = [];
  for (const item of value) {
    try {
      const project = normalizeProject(item);
      if (project) projects.push(project);
    } catch {
      continue;
    }
    if (projects.length >= MAX_PROJECTS) break;
  }
  return projects;
}

export function writeProjects(projects: ProjectPreset[], store: Storage | null = storage()): void {
  if (!store) return;
  try {
    store.setItem(PROJECTS_KEY, JSON.stringify(projects.slice(0, MAX_PROJECTS)));
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch {
    // Storage quota or restricted WebView must not break the chat client.
  }
}

export function activeProjectId(store: Storage | null = storage()): string | null {
  if (!store) return null;
  const value = store.getItem(ACTIVE_PROJECT_KEY);
  return value?.trim() || null;
}

export function setActiveProjectId(id: string | null, store: Storage | null = storage()): void {
  if (!store) return;
  try {
    if (id) store.setItem(ACTIVE_PROJECT_KEY, id);
    else store.removeItem(ACTIVE_PROJECT_KEY);
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(PROJECTS_CHANGED_EVENT));
  } catch {
    // best effort only
  }
}

export function projectFromConfig(
  name: string,
  systemPrompt: string,
  config: AppConfig,
  documentBindings: ProjectDocument[] = [],
  toolIds: string[] = [],
  description = "",
  now = Date.now(),
  profileApplication?: ProfileApplication,
): ProjectPreset {
  const project = normalizeProject({
    id: `project-${now.toString(36)}`,
    name,
    description,
    systemPrompt,
    config,
    profileApplication,
    documentBindings,
    toolIds,
    createdAt: now,
    updatedAt: now,
  });
  if (!project) throw new Error("A project name is required.");
  return project;
}

export function upsertProject(project: ProjectPreset, projects = readProjects()): ProjectPreset[] {
  const normalized = normalizeProject(project);
  if (!normalized) throw new Error("Invalid project preset.");
  const byId = projects.filter((item) => item.id !== normalized.id && item.name.toLocaleLowerCase() !== normalized.name.toLocaleLowerCase());
  return [normalized, ...byId].slice(0, MAX_PROJECTS);
}

export function deleteProject(id: string, projects = readProjects()): ProjectPreset[] {
  return projects.filter((project) => project.id !== id);
}

const SENSITIVE_NAME_PARTS = new Set([
  "api-key", "apikey", "api_key", "authorization", "auth", "connection-string",
  "connection_string", "credential", "credentials", "password", "private-key",
  "private_key", "privatekey", "secret", "secrets", "token", "tokens",
]);

function sensitiveExportName(name: string): boolean {
  const normalized = name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  const parts = normalized.split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => SENSITIVE_NAME_PARTS.has(part))
    || /(api[_-]?key|private[_-]?key|connection[_-]?string)/i.test(normalized);
}

function sensitiveExportFlag(value: string): boolean {
  return /^--?(?:[a-z0-9_.-]*[_-])?(api-key|api_key|apikey|authorization|password|private-key|private_key|secret|token)(?:=|$)/i.test(value);
}

function isFlagLike(value: string): boolean {
  return /^-/.test(value);
}

function redactExportValue(value: unknown, key = ""): unknown {
  if (sensitiveExportName(key)) return "[REDACTED]";
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map((item) => {
      if (redactNext) {
        redactNext = false;
        if (typeof item === "string" && isFlagLike(item)) return item;
        return "[REDACTED]";
      }
      if (typeof item === "string") {
        if (sensitiveExportFlag(item) && item.includes("=")) {
          return `${item.slice(0, item.indexOf("="))}=[REDACTED]`;
        }
        redactNext = sensitiveExportFlag(item);
        return item;
      }
      return redactExportValue(item);
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [entryKey, redactExportValue(entryValue, entryKey)]),
    );
  }
  return value;
}

export function exportProject(project: ProjectPreset): string {
  return JSON.stringify({ schema: "aiolm.project.v1", project: redactExportValue(project) }, null, 2);
}

export function importProject(raw: string): ProjectPreset {
  const parsed: unknown = JSON.parse(raw);
  const source = parsed && typeof parsed === "object" && "project" in parsed ? (parsed as { project: unknown }).project : parsed;
  const project = normalizeProject(source);
  if (!project) throw new Error("The selected file is not a valid aiolm project preset.");
  return { ...project, id: `project-${Date.now().toString(36)}`, updatedAt: Date.now() };
}

export function projectConfigPatch(project: ProjectPreset): Partial<AppConfig> {
  return safeClone(project.config);
}
