import type { AppConfig } from '../api/types';
import type { ExecutionSettings } from './executionSettings';
import {
  emptyProfileLibrary, MODEL_PROFILE_KEYS,
  profileSettingsSnapshot, profileTargetKey, type SettingsProfile, type SettingsProfileLibrary,
} from './settingsProfiles';
import { RUNTIME_DEFAULT_KEYS } from './tuningDefaults';
import { sessionConfig } from '../runtime/sessionUtils';
import tuningCatalog from './tuningDefaultsCatalog.json';
import { canonicalServerOptionName } from './tuningValidation';
import { ensureProfileAssignments } from './profileAssignments';

const PROFILES_KEY = 'aiolm-model-profiles';
const LOADING_KEY = 'aiolm.loading-profiles.v1';
const EXECUTION_KEY = 'aiolm-model-execution';
type RecordValue = Record<string, unknown>;
type LegacyEntry = { originalId: string; profile: SettingsProfile };
type LegacyProfiles = {
  version: number; server: LegacyEntry[]; model: LegacyEntry[];
  activeServerId: string; activeModelId: string;
  activeServerIds: Record<string, string>; activeModelIds: Record<string, string>;
};

function invalid(source: string): never { throw new Error(`Cannot import saved profiles: invalid ${source}. The original data has been preserved.`); }
function record(value: unknown, source: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(source);
  return value as RecordValue;
}
function read(storage: Pick<Storage, 'getItem'>, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) as unknown; } catch { return invalid(key); }
}
function string(value: unknown, source: string): string {
  if (typeof value !== 'string') invalid(source);
  return value;
}
function optionalString(value: unknown, source: string): string | undefined {
  return value === undefined ? undefined : string(value, source);
}
function strings(value: unknown, source: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) invalid(source);
  return [...value] as string[];
}
function selections(value: unknown, source: string): Record<string, string> {
  return value === undefined ? {} : Object.fromEntries(Object.entries(record(value, source)).map(([path, id]) => [path, string(id, source)]));
}

const numericFields = new Set([
  'ngl', 'ctx_size', 'batch_size', 'ubatch_size', 'keep', 'n_cpu_moe', 'threads', 'parallel',
  'request_timeout_seconds', 'sleep_idle_seconds', 'temperature', 'top_p', 'top_k',
  'spec_draft_n_max', 'spec_draft_n_min', 'spec_draft_p_min', 'spec_draft_p_split', 'reasoning_budget',
]);

function promoteLegacyArgs(raw: RecordValue, source: string): RecordValue {
  const mapped = { ...raw };
  if (raw.server_args === undefined) return mapped;
  const args = strings(raw.server_args, `${source}.server_args`);
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const name = argument.trim().split('=', 1)[0];
    const canonical = canonicalServerOptionName(argument);
    if (!canonical) continue;
    const field = tuningCatalog.find(entry => entry.args.includes(name) || entry.args.includes(canonical));
    const pathKey = canonical === '--mmproj' ? 'mmproj' : canonical === '--spec-draft-model' ? 'spec_draft_model' : canonical === '--spec-draft-device' ? 'spec_draft_device' : undefined;
    const key = field?.key ?? pathKey;
    if (!key) continue;
    const rawValue = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : args[index + 1];
    let value: unknown;
    if (field?.switch) value = name.startsWith('--no-') ? 'off' : rawValue === 'false' || rawValue === 'off' || rawValue === '0' ? 'off' : 'on';
    else if (canonical === '--mmproj' && ['--no-mmproj', '--mmproj-auto', '--no-mmproj-auto'].includes(name)) value = '';
    else {
      if (rawValue === undefined || !rawValue.trim() || /^--?[a-zA-Z]/.test(rawValue)) invalid(`${source}.server_args ${name}`);
      value = numericFields.has(key) ? Number(rawValue) : rawValue;
    }
    // Explicit stored fields are authoritative; older raw-only settings remain usable.
    if (mapped[key] === undefined) mapped[key] = value;
  }
  return mapped;
}

function validateSettings(value: RecordValue, source: string): Partial<ExecutionSettings> {
  for (const key of MODEL_PROFILE_KEYS) {
    const field = value[key];
    if (field === undefined) continue;
    if (numericFields.has(key)) {
      if (typeof field !== 'number' || !Number.isFinite(field)) invalid(`${source}.${key}`);
    } else if (key === 'server_args' || key === 'runtime_defaults') {
      strings(field, `${source}.${key}`);
      if (key === 'runtime_defaults' && (field as string[]).some(name => !RUNTIME_DEFAULT_KEYS.includes(name))) invalid(`${source}.${key}`);
    } else if (key === 'chat_options') {
      record(field, `${source}.${key}`);
    } else if (key === 'gpu') {
      const gpu = record(field, `${source}.gpu`);
      strings(gpu.gpu_ids, `${source}.gpu.gpu_ids`);
      if (!['none', 'single', 'layer', 'row', 'tensor'].includes(string(gpu.split_mode, `${source}.gpu.split_mode`))) invalid(`${source}.gpu.split_mode`);
      if (!Array.isArray(gpu.tensor_split) || gpu.tensor_split.some(item => typeof item !== 'number' || !Number.isFinite(item))) invalid(`${source}.gpu.tensor_split`);
      if (gpu.main_gpu !== null) optionalString(gpu.main_gpu, `${source}.gpu.main_gpu`);
      if (gpu.draft_gpu_id !== null) optionalString(gpu.draft_gpu_id, `${source}.gpu.draft_gpu_id`);
    } else if (key === 'lora_adapters') {
      if (!Array.isArray(field)) invalid(`${source}.${key}`);
      for (const item of field) {
        const adapter = record(item, `${source}.${key}`);
        string(adapter.path, `${source}.lora.path`);
        if (typeof adapter.scale !== 'number' || !Number.isFinite(adapter.scale) || typeof adapter.enabled !== 'boolean') invalid(`${source}.lora`);
      }
    } else string(field, `${source}.${key}`);
  }
  return profileSettingsSnapshot(value as Partial<AppConfig>);
}

function legacyId(kind: string, id: string, index: number): string {
  // The original ID and position retain duplicate entries and make retries deterministic.
  let hash = 2166136261;
  for (const char of id) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return `legacy-${kind}-${index}-${(hash >>> 0).toString(16)}`;
}

function importEntry(value: unknown, kind: 'server' | 'model' | 'loading', index: number): LegacyEntry {
  const source = `${kind} profile ${index + 1}`;
  const raw = record(value, source);
  const id = string(raw.id, `${source}.id`);
  const name = string(raw.name, `${source}.name`);
  if (!id.trim() || !name.trim()) invalid(source);
  const mapped = promoteLegacyArgs(raw, source);
  if (kind !== 'model') {
    const backend = optionalString(raw.backend, `${source}.backend`);
    const build = optionalString(raw.build, `${source}.build`);
    if (backend !== undefined) mapped.active_backend = backend === 'PATH' ? '' : backend;
    if (build !== undefined) mapped.active_build = build;
    if (backend === '' || backend === 'PATH') { mapped.active_backend = ''; mapped.active_build = ''; }
  }
  const settings = validateSettings(mapped, source);
  const prompt = optionalString(raw.system_prompt, `${source}.system_prompt`);
  if (raw.stop_strings !== undefined) {
    const stops = strings(raw.stop_strings, `${source}.stop_strings`);
    settings.chat_options = { ...settings.chat_options };
    if (stops.length) settings.chat_options.stop = stops;
    else delete settings.chat_options.stop;
  }
  // Missing markers mean the explicitly saved legacy fields were manual overrides.
  settings.runtime_defaults ??= [];
  const coverage = [...new Set([...Object.keys(settings), ...settings.runtime_defaults])];
  if (Boolean(settings.active_backend) !== Boolean(settings.active_build)) {
    // An incomplete old runtime pair cannot replace a currently selected runtime.
    for (const key of ['active_backend', 'active_build']) {
      const position = coverage.indexOf(key);
      if (position >= 0) coverage.splice(position, 1);
    }
  }
  const modelPath = optionalString(kind === 'loading' ? raw.active_model : raw.modelPath, `${source}.modelPath`);
  return { originalId: id, profile: {
    id: legacyId(kind, id, index), name, scope: modelPath ? 'model' : 'global',
    ...(modelPath ? { model_key: profileTargetKey(modelPath) } : {}), revision: 1,
    settings, ...(prompt !== undefined ? { system_prompt: prompt } : {}), legacy: true, coverage,
  } };
}

function legacyProfiles(value: unknown): LegacyProfiles {
  if (value === null) return { version: 4, server: [], model: [], activeServerId: '', activeModelId: '', activeServerIds: {}, activeModelIds: {} };
  const raw = record(value, PROFILES_KEY);
  if (![2, 3, 4].includes(raw.version as number) || !Array.isArray(raw.server) || !Array.isArray(raw.model)) invalid(PROFILES_KEY);
  return {
    version: raw.version as number,
    server: raw.server.map((entry, index) => importEntry(entry, 'server', index)),
    model: raw.model.map((entry, index) => importEntry(entry, 'model', index)),
    activeServerId: optionalString(raw.activeServerId, PROFILES_KEY) ?? '',
    activeModelId: optionalString(raw.activeModelId, PROFILES_KEY) ?? '',
    activeServerIds: selections(raw.activeServerIds, PROFILES_KEY), activeModelIds: selections(raw.activeModelIds, PROFILES_KEY),
  };
}

function selected(map: Record<string, string>, path: string): string | undefined {
  return map[path] ?? Object.entries(map).find(([candidate]) => profileTargetKey(candidate) === profileTargetKey(path))?.[1];
}
function generationProfile(stored: LegacyProfiles, path: string, fallbackPath: string): SettingsProfile | undefined {
  const candidates = stored.version === 4 ? [selected(stored.activeModelIds, path), stored.activeModelId]
    : [selected(stored.activeModelIds, path), selected(stored.activeModelIds, fallbackPath), ...Object.values(stored.activeModelIds)];
  for (const id of candidates) {
    const entry = stored.model.find(item => item.originalId === id);
    if (entry) return entry.profile;
  }
  return stored.model[0]?.profile;
}

function mergedSettings(...sources: Partial<ExecutionSettings>[]): Partial<ExecutionSettings> {
  const result: Partial<ExecutionSettings> = {};
  let inherited: string[] = [];
  for (const source of sources) {
    inherited = [...inherited.filter(key => !(key in source)), ...(source.runtime_defaults ?? [])];
    Object.assign(result, source);
  }
  if (sources.length) result.runtime_defaults = [...new Set(inherited)];
  return result;
}

function existingLibrary(cfg: AppConfig): SettingsProfileLibrary {
  if (cfg.settings_profiles === undefined) return emptyProfileLibrary();
  const value = cfg.settings_profiles;
  if (value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0 || !Array.isArray(value.entries) || typeof value.legacy_imported !== 'boolean') invalid('settings profile library');
  record(value.applied, 'applied settings profiles');
  const ids = new Set<string>();
  for (const entry of value.entries) {
    record(entry, 'settings profile');
    if (typeof entry.id !== 'string' || ids.has(entry.id)) invalid('settings profile ID');
    ids.add(entry.id);
    validateSettings(record(entry.settings, 'profile settings'), 'profile settings');
  }
  return structuredClone(value);
}

/** Read every legacy source without mutating it; the caller commits the returned library atomically. */
export function migrateProfileLibrary(cfg: AppConfig, storage: Pick<Storage, 'getItem'> = window.localStorage): SettingsProfileLibrary {
  const library = existingLibrary(cfg);
  if (library.legacy_imported) return ensureProfileAssignments(cfg, library);
  const stored = legacyProfiles(read(storage, PROFILES_KEY));
  const loadingRaw = read(storage, LOADING_KEY);
  if (loadingRaw !== null && !Array.isArray(loadingRaw)) invalid(LOADING_KEY);
  const loading = ((loadingRaw ?? []) as unknown[]).map((entry, index) => importEntry(entry, 'loading', index));
  const executionRaw = read(storage, EXECUTION_KEY);
  const remembered = new Map<string, { path: string; settings: Partial<ExecutionSettings> }>();
  if (executionRaw !== null) {
    const raw = record(executionRaw, EXECUTION_KEY);
    if (raw.version !== 1) invalid(EXECUTION_KEY);
    for (const [path, settings] of Object.entries(record(raw.models, EXECUTION_KEY))) {
      remembered.set(profileTargetKey(path), { path, settings: validateSettings(promoteLegacyArgs(record(settings, EXECUTION_KEY), EXECUTION_KEY), EXECUTION_KEY) });
    }
  }
  for (const { profile } of [...stored.server, ...stored.model, ...loading]) {
    if (!library.entries.some(entry => entry.id === profile.id)) library.entries.push(profile);
  }

  const paths = new Map<string, string>();
  for (const path of [...Object.keys(stored.activeServerIds), ...Object.keys(stored.activeModelIds), ...[...remembered.values()].map(item => item.path), cfg.active_model]) {
    if (path) paths.set(profileTargetKey(path), path);
  }
  for (const [key, path] of paths) {
    if (library.applied[key]) continue;
    const model = generationProfile(stored, path, cfg.active_model);
    let settings: Partial<ExecutionSettings>;
    if (key === profileTargetKey(cfg.active_model)) settings = profileSettingsSnapshot(cfg);
    else if (remembered.has(key)) settings = remembered.get(key)!.settings;
    else {
      const serverId = selected(stored.activeServerIds, path) ?? stored.activeServerId;
      const server = (stored.server.find(entry => entry.originalId === serverId) ?? stored.server[0])?.profile;
      const covered = (entry?: SettingsProfile) => entry ? Object.fromEntries(Object.entries(entry.settings).filter(([field]) => entry.coverage?.includes(field))) as Partial<ExecutionSettings> : {};
      settings = mergedSettings(covered(server), covered(model));
    }
    library.applied[key] = { model: path, settings, system_prompt: model?.system_prompt ?? '' };
  }
  for (const definition of cfg.sessions ?? []) {
    if (!definition.models.primary_model || definition.id === 'default') continue;
    const key = profileTargetKey(definition.models.primary_model, definition.id);
    if (library.applied[key]) continue;
    const profile = definition.model_profile_id
      ? stored.model.find(item => item.originalId === definition.model_profile_id)?.profile
      : generationProfile(stored, definition.models.primary_model, definition.models.primary_model);
    const target = sessionConfig(cfg, definition);
    library.applied[key] = { model: target.active_model, settings: profileSettingsSnapshot(target), system_prompt: profile?.system_prompt ?? '' };
  }
  library.legacy_imported = true;
  return ensureProfileAssignments(cfg, library);
}
