import type { AppConfig } from '../api/types';
import { PROVIDERS, providerOf, type ProviderId } from '../api/providers';
import { modelPathIdentity } from '../lib/displayPaths';
import { EXECUTION_KEYS, executionSettings, type ExecutionKey, type ExecutionSettings } from './executionSettings';
import { RUNTIME_DEFAULT_KEYS } from './tuningDefaults';
import { tuningResetValues } from './tuningResetValues';
import { canonicalServerOptionName, mapChatOptionAliases } from './tuningValidation';
import { cloneGpuPlacement } from '../runtime/sessionUtils';

export interface SettingsProfile {
  provider?: ProviderId;
  legacy_runtime?: Record<string, unknown>;
  id: string;
  name: string;
  /** Model scope is accepted only when reading older libraries; normalization shares it within the engine. */
  scope: 'model' | 'global';
  model_key?: string;
  revision: number;
  settings: Partial<ExecutionSettings>;
  system_prompt?: string;
  legacy?: boolean;
  coverage?: string[];
  source_id?: string;
  source_scope?: 'preset' | 'global';
}

export interface ProfileApplication {
  provider?: ProviderId;
  model: string;
  profile_id?: string;
  profile_name?: string;
  profile_revision?: number;
  settings: Partial<ExecutionSettings>;
  system_prompt: string;
}

export interface SettingsProfileLibrary {
  provider_defaults?: Partial<Record<ProviderId, string>>;
  provider_recent?: Partial<Record<ProviderId, string>>;
  version: 1;
  revision: number;
  entries: SettingsProfile[];
  default_profile_id?: string;
  applied: Record<string, ProfileApplication>;
  legacy_imported: boolean;
}

export const RUNTIME_SELECTION_KEYS = ['active_provider', 'active_runtime', 'active_backend', 'active_build'] as const;
export const MODEL_PROFILE_KEYS = EXECUTION_KEYS.filter((key): key is Exclude<ExecutionKey, 'active_model' | typeof RUNTIME_SELECTION_KEYS[number]> => key !== 'active_model' && !(RUNTIME_SELECTION_KEYS as readonly string[]).includes(key));
/** Original shared-profile coverage, retained for older partial profiles. New captures own all engine options. */
export const GLOBAL_PROFILE_KEYS: readonly ExecutionKey[] = [
  'provider_options', 'runtime_defaults', 'ctx_size', 'batch_size', 'ubatch_size', 'keep', 'cache_type_k', 'cache_type_v',
  'flash_attn', 'threads', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds',
  'temperature', 'top_p', 'top_k', 'chat_options', 'reasoning', 'reasoning_format', 'reasoning_effort',
  'reasoning_budget', 'reasoning_budget_message', 'reasoning_preserve',
];

export function emptyProfileLibrary(): SettingsProfileLibrary {
  return { version: 1, revision: 0, entries: [], applied: {}, legacy_imported: false };
}

export const DEFAULT_SETTINGS_PROFILE_ID = 'profile-default';

/**
 * Fields the initial Default profile owns: every global field plus the tuning
 * fields that are otherwise model-scoped, so a fresh install inherits the
 * runtime default for each one instead of leaving it on a captured value.
 */
export const DEFAULT_PROFILE_KEYS: readonly ExecutionKey[] = MODEL_PROFILE_KEYS
  .filter(key => GLOBAL_PROFILE_KEYS.includes(key) || RUNTIME_DEFAULT_KEYS.includes(key)).sort();

/** A fresh profile inherits product/runtime defaults without capturing any user configuration. */
export function defaultSettingsProfile(): SettingsProfile {
  return { provider: 'llama.cpp', id: DEFAULT_SETTINGS_PROFILE_ID, name: 'Default', scope: 'global', revision: 1, system_prompt: '',
    settings: { runtime_defaults: DEFAULT_PROFILE_KEYS.filter(key => RUNTIME_DEFAULT_KEYS.includes(key)), chat_options: {} },
    legacy: true, coverage: [...DEFAULT_PROFILE_KEYS] };
}

export function ensureProfileLibrary(library: SettingsProfileLibrary): SettingsProfileLibrary {
  const source = library;
  library = structuredClone(library);
  for (const profile of library.entries) {
    profile.provider ??= 'llama.cpp';
    if (profile.scope === 'model') {
      profile.coverage = [...ownedKeys(profile)];
      profile.legacy = true;
      profile.scope = 'global';
    }
    delete profile.model_key;
    delete profile.source_id;
    delete profile.source_scope;
    const legacy: Record<string, unknown> = {};
    for (const key of RUNTIME_SELECTION_KEYS) {
      if (profile.settings[key] !== undefined) legacy[key] = profile.settings[key];
      delete profile.settings[key];
    }
    if (Object.keys(legacy).length) profile.legacy_runtime = { ...profile.legacy_runtime, ...legacy };
    if (profile.coverage) profile.coverage = profile.coverage.filter(key => !(RUNTIME_SELECTION_KEYS as readonly string[]).includes(key));
  }
  for (const application of Object.values(library.applied)) {
    application.provider ??= 'llama.cpp';
    for (const key of RUNTIME_SELECTION_KEYS) delete application.settings[key];
  }
  library = migrateModelPathKeys(library);
  const populated = library;
  let llamaProfiles = populated.entries.filter(entry => entry.provider === 'llama.cpp');
  if (!llamaProfiles.length) {
    let id = DEFAULT_SETTINGS_PROFILE_ID;
    for (let suffix = 2; populated.entries.some(entry => entry.id === id); suffix++) id = `${DEFAULT_SETTINGS_PROFILE_ID}-${suffix}`;
    const profile = { ...defaultSettingsProfile(), id };
    populated.entries.push(profile);
    llamaProfiles = [profile];
  }
  const selected = llamaProfiles.find(entry => entry.id === populated.default_profile_id)
    ?? llamaProfiles.find(entry => entry.id === populated.provider_defaults?.['llama.cpp'])
    ?? llamaProfiles.find(entry => entry.id === DEFAULT_SETTINGS_PROFILE_ID)
    ?? llamaProfiles.find(entry => entry.scope === 'global') ?? llamaProfiles[0];
  const normalized = setDefaultSettingsProfile(populated, selected.id);
  normalized.provider_defaults ??= {};
  normalized.provider_recent ??= {};
  normalized.provider_defaults['llama.cpp'] ??= normalized.default_profile_id;
  for (const provider of PROVIDERS.filter(provider => provider !== 'llama.cpp')) {
    if (normalized.entries.some(entry => entry.id === normalized.provider_defaults?.[provider] && entry.provider === provider && entry.scope === 'global')) continue;
    let id = `profile-default-${provider}`;
    for (let suffix = 2; normalized.entries.some(entry => entry.id === id && (entry.provider !== provider || entry.scope !== 'global')); suffix++) id = `profile-default-${provider}-${suffix}`;
    if (!normalized.entries.some(entry => entry.id === id)) normalized.entries.push({ id, provider, name: 'Default', scope: 'global', revision: 1,
      settings: { provider_options: { [provider]: {} } }, system_prompt: '' });
    normalized.provider_defaults[provider] = id;
  }
  normalized.provider_recent = Object.fromEntries(Object.entries(normalized.provider_recent).filter(([provider, id]) => normalized.entries.some(entry => entry.id === id && (entry.provider ?? 'llama.cpp') === provider)));
  return JSON.stringify(source) === JSON.stringify(normalized) ? source : normalized;
}

/** A designated default must be applicable to every model without changing its saved identity. */
export function setDefaultSettingsProfile(library: SettingsProfileLibrary, id: string): SettingsProfileLibrary {
  const selected = library.entries.find(entry => entry.id === id);
  if (!selected) throw new Error('This profile is no longer available.');
  const promoted = selected.scope === 'model' || selected.model_key !== undefined || selected.source_id !== undefined || selected.source_scope !== undefined;
  const provider = selected.provider ?? 'llama.cpp';
  if ((library.provider_defaults?.[provider] ?? (provider === 'llama.cpp' ? library.default_profile_id : undefined)) === id && !promoted) return library;
  let profile = selected;
  if (promoted) {
    profile = { ...selected, scope: 'global', revision: selected.revision + 1,
      ...(selected.scope === 'model' ? { legacy: true, coverage: [...ownedKeys(selected)] } : {}) };
    delete profile.model_key;
    delete profile.source_id;
    delete profile.source_scope;
  }
  return { ...library, ...(provider === 'llama.cpp' ? { default_profile_id: id } : {}),
    provider_defaults: { ...library.provider_defaults, [provider]: id }, entries: library.entries.map(entry => entry.id === id ? profile : entry) };
}

export function defaultSettingsProfileEntry(library: SettingsProfileLibrary, provider: ProviderId = 'llama.cpp'): SettingsProfile {
  const normalized = ensureProfileLibrary(library);
  return normalized.entries.find(entry => entry.id === (normalized.provider_defaults?.[provider] ?? normalized.default_profile_id))!;
}

/** Migrated copies are independent shared profiles; deleting one preserves the others. */
export function profileDeletionIds(library: SettingsProfileLibrary, id: string): Set<string> {
  return new Set(library.entries.some(entry => entry.id === id) ? [id] : []);
}

export function canDeleteSettingsProfile(library: SettingsProfileLibrary, id: string): boolean {
  return library.entries.some(entry => entry.id === id) && profileDeletionReason(library, id) === undefined;
}

export function profileDeletionReason(library: SettingsProfileLibrary, id: string): 'default' | undefined {
  return Object.values(ensureProfileLibrary(library).provider_defaults ?? {}).includes(id) ? 'default' : undefined;
}

export function deleteSettingsProfile(source: SettingsProfileLibrary, id: string): SettingsProfileLibrary {
  const library = ensureProfileLibrary(source);
  if (profileDeletionReason(library, id)) throw new Error('The default profile cannot be deleted. Choose another default profile first.');
  const removed = profileDeletionIds(library, id);
  if (!removed.size) throw new Error('This profile is no longer available.');
  const entries = library.entries.filter(entry => !removed.has(entry.id));
  const applied = Object.fromEntries(Object.entries(library.applied).map(([key, application]) => {
    if (!application.profile_id || !removed.has(application.profile_id)) return [key, application];
    const fallback = defaultSettingsProfileEntry(library, application.provider ?? 'llama.cpp');
    const cfg = applySettingsProfile(profileApplicationConfig(application), fallback);
    return [key, materializeProfileApplication(cfg, fallback.system_prompt ?? application.system_prompt, fallback)];
  }));
  const provider_recent = Object.fromEntries(Object.entries(library.provider_recent ?? {}).filter(([, recent]) => !removed.has(recent)));
  return { ...library, entries, applied, provider_recent };
}

/** Expand saved execution fields with product defaults without reading another target's configuration. */
export function profileApplicationConfig(application: ProfileApplication): AppConfig {
  const baseline = applySettingsProfile({ active_model: application.model } as AppConfig, {
    id: 'profile-application-defaults', name: 'Default', scope: 'global', revision: 1,
    legacy: true, coverage: [...MODEL_PROFILE_KEYS], settings: {},
  });
  return { ...baseline, ...profileSettingsSnapshot({ ...application.settings, active_provider: application.provider }), active_provider: application.provider ?? 'llama.cpp', active_model: application.model,
    runtime_defaults: application.settings.runtime_defaults ?? (baseline.runtime_defaults ?? []).filter(field => !(field in application.settings)) };
}

export function profileTargetKey(modelPath: string, sessionId = 'default', provider: ProviderId = 'llama.cpp'): string {
  return sessionId === 'default'
    ? `${provider === 'llama.cpp' ? '' : `provider:${provider}:`}model:${modelPathIdentity(modelPath)}`
    : `session:${sessionId}`;
}

/** Recover original POSIX spelling from saved applications, never from a folded key alone. */
function migrateModelPathKeys(library: SettingsProfileLibrary): SettingsProfileLibrary {
  let changed = false;
  const profileKeys = new Map<string, Set<string>>();
  const applied: Record<string, ProfileApplication> = {};
  for (const [key, application] of Object.entries(library.applied)) {
    const modelKey = profileTargetKey(application.model);
    const legacyKey = `model:${application.model.trim().replace(/\\/g, '/').toLowerCase()}`;
    const target = key === legacyKey || key === modelKey ? profileTargetKey(application.model, 'default', application.provider) : key;
    if (applied[target] && JSON.stringify(sortedValue(applied[target])) !== JSON.stringify(sortedValue(application))) {
      throw new Error('Conflicting saved settings for the same model path.');
    }
    applied[target] = application;
    changed ||= target !== key;
    if (application.profile_id) {
      const keys = profileKeys.get(application.profile_id) ?? new Set<string>();
      keys.add(modelKey);
      profileKeys.set(application.profile_id, keys);
    }
  }
  const entries = library.entries.map(profile => {
    const keys = profileKeys.get(profile.id);
    if (profile.scope !== 'model' || keys?.size !== 1) return profile;
    const key = [...keys][0];
    if (key === profile.model_key || key.toLowerCase().replace(/\\/g, '/') !== profile.model_key) return profile;
    changed = true;
    return { ...profile, model_key: key };
  });
  return changed ? { ...library, applied, entries } : library;
}

/** The model identity and app management fields live outside a reusable settings snapshot. */
export function settingsSnapshot(cfg: Partial<AppConfig>): Partial<ExecutionSettings> {
  const settings = executionSettings(cfg);
  delete (settings as Partial<ExecutionSettings>).active_model;
  return settings;
}

const secretName = /^(?:api[-_]?key(?:[-_]?file)?|authorization|auth|credential|password|private[-_]?key|secret|token)$/i;
function profileArgs(args: readonly string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i];
    const name = token.trim().split('=', 1)[0];
    if (canonicalServerOptionName(token) || secretName.test(name.replace(/^--?/, ''))) {
      if (!token.includes('=')) {
        const count = name === '--lora-scaled' ? 2 : 1;
        for (let j = 0; j < count && args[i + 1] !== undefined && !/^--?[a-zA-Z]/.test(args[i + 1]); j++) i++;
      }
      continue;
    }
    result.push(token);
  }
  return result;
}

/** Library snapshots must not duplicate credentials or app-managed CLI arguments. */
export function profileSettingsSnapshot(cfg: Partial<AppConfig>): Partial<ExecutionSettings> {
  const settings = settingsSnapshot(cfg);
  for (const key of RUNTIME_SELECTION_KEYS) delete settings[key];
  const provider = providerOf(cfg);
  if (provider === 'llama.cpp') delete settings.provider_options;
  else {
    for (const key of Object.keys(settings)) if (!['provider_options', 'request_timeout_seconds', 'sleep_idle_seconds'].includes(key)) delete settings[key as ExecutionKey];
    settings.provider_options = { [provider]: structuredClone(cfg.provider_options?.[provider] ?? {}) };
  }
  if (settings.server_args) settings.server_args = profileArgs(settings.server_args);
  return settings;
}

function captureSettings(cfg: AppConfig): Partial<ExecutionSettings> {
  if (providerOf(cfg) !== 'llama.cpp') return profileSettingsSnapshot(cfg);
  const allowed: readonly ExecutionKey[] = MODEL_PROFILE_KEYS;
  const snapshot = profileSettingsSnapshot(cfg);
  const settings = Object.fromEntries(Object.entries(snapshot).filter(([key]) => allowed.includes(key as ExecutionKey))) as Partial<ExecutionSettings>;
  settings.runtime_defaults = [...new Set((cfg.runtime_defaults ?? []).filter(key => allowed.includes(key as ExecutionKey)))].sort();
  return settings;
}

/** The legacy scope argument is accepted for callers importing old settings; every new profile is shared. */
export function captureProfile(cfg: AppConfig, name: string, _scope: SettingsProfile['scope'], systemPrompt: string): SettingsProfile {
  if (!name.trim()) throw new Error('A profile name is required.');
  return {
    id: `profile-${crypto.randomUUID()}`, name: name.trim(), scope: 'global', revision: 1,
    provider: providerOf(cfg),
    ...(providerOf(cfg) === 'llama.cpp' ? { legacy: true, coverage: [...MODEL_PROFILE_KEYS] } : {}),
    settings: captureSettings(cfg), system_prompt: systemPrompt,
  };
}

function ownedKeys(profile: SettingsProfile): readonly ExecutionKey[] {
  if ((profile.provider ?? 'llama.cpp') !== 'llama.cpp') return ['provider_options', 'request_timeout_seconds', 'sleep_idle_seconds'];
  if (!profile.legacy) return profile.scope === 'global' ? GLOBAL_PROFILE_KEYS : MODEL_PROFILE_KEYS;
  const fields = profile.coverage ?? [...Object.keys(profile.settings), ...(profile.settings.runtime_defaults ?? [])];
  return MODEL_PROFILE_KEYS.filter(key => fields.includes(key));
}

/** An explicit save updates the chosen entry and captures every editable field. */
export function saveSettingsProfile(entry: SettingsProfile, cfg: AppConfig, systemPrompt: string,
  excludedKeys: ReadonlySet<string> = new Set(), preservePrompt = false): SettingsProfile {
  if ((entry.provider ?? 'llama.cpp') !== providerOf(cfg)) throw new Error('This profile belongs to another runtime provider.');
  entry = { ...entry, scope: 'global', ...(entry.scope === 'model' ? { legacy: true, coverage: [...ownedKeys(entry)] } : {}) };
  delete entry.model_key;
  delete entry.source_id;
  delete entry.source_scope;
  if (providerOf(cfg) !== 'llama.cpp') return { ...entry, revision: entry.revision + 1, settings: profileSettingsSnapshot(cfg), ...(!preservePrompt ? { system_prompt: systemPrompt } : {}) };
  const fields: ExecutionKey[] = MODEL_PROFILE_KEYS.filter(key => key !== 'runtime_defaults' && !excludedKeys.has(key));
  const snapshot = profileSettingsSnapshot(cfg);
  const settings = structuredClone(entry.settings);
  for (const key of fields) {
    if (snapshot[key] === undefined) delete settings[key];
    else Object.assign(settings, { [key]: structuredClone(snapshot[key]) });
  }
  settings.runtime_defaults = [...new Set([...(entry.settings.runtime_defaults ?? []).filter(key => !fields.includes(key as ExecutionKey)),
    ...(snapshot.runtime_defaults ?? []).filter(key => fields.includes(key as ExecutionKey))])].sort();
  const saved: SettingsProfile = { ...entry, revision: entry.revision + 1, settings,
    ...(!preservePrompt ? { system_prompt: systemPrompt } : {}) };
  if (entry.scope === 'global' || excludedKeys.size) {
    saved.legacy = true;
    saved.coverage = [...new Set([...ownedKeys(entry), ...fields, 'runtime_defaults'])];
  } else {
    delete saved.legacy;
    delete saved.coverage;
  }
  delete saved.source_id;
  delete saved.source_scope;
  return saved;
}

/** Copy only the profile's owned fields; legacy profiles keep their original partial coverage. */
export function applySettingsProfile(cfg: AppConfig, profile: SettingsProfile): AppConfig {
  if ((profile.provider ?? 'llama.cpp') !== providerOf(cfg)) throw new Error('This profile belongs to another runtime provider.');
  const keys = ownedKeys(profile);
  if (providerOf(cfg) !== 'llama.cpp') return { ...cfg, ...Object.fromEntries(Object.entries(profile.settings).filter(([key]) => key !== 'provider_options' && keys.includes(key as ExecutionKey))),
    provider_options: { ...cfg.provider_options, [providerOf(cfg)]: structuredClone(profile.settings.provider_options?.[providerOf(cfg)] ?? {}) } };
  const defaults = tuningResetValues();
  const settings = settingsSnapshot(profile.settings);
  const patch: Partial<ExecutionSettings> = {};
  const inherited = new Set((cfg.runtime_defaults ?? []).filter(key => !keys.includes(key as ExecutionKey)));
  for (const key of keys) {
    if (key === 'runtime_defaults') continue;
    let value: unknown = settings[key];
    if (value === undefined) {
      if (RUNTIME_DEFAULT_KEYS.includes(key)) value = defaults[key as keyof typeof defaults];
      else if (key === 'server_args' || key === 'lora_adapters') value = [];
      else if (key === 'chat_options') value = {};
      else if (key === 'gpu') value = { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null };
      else value = '';
      if (RUNTIME_DEFAULT_KEYS.includes(key)) inherited.add(key);
    }
    if (settings.runtime_defaults?.includes(key)) inherited.add(key);
    Object.assign(patch, { [key]: structuredClone(value) });
  }
  patch.runtime_defaults = [...inherited].sort();
  delete patch.provider_options;
  return { ...cfg, ...patch };
}

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortedValue(item)]));
  return value;
}

function comparable(settings: Partial<ExecutionSettings>): unknown {
  const snapshot = settingsSnapshot(settings);
  snapshot.runtime_defaults = [...new Set(snapshot.runtime_defaults ?? [])].sort();
  for (const key of snapshot.runtime_defaults) delete snapshot[key as ExecutionKey];
  snapshot.gpu = cloneGpuPlacement(snapshot.gpu);
  snapshot.server_args ??= [];
  snapshot.lora_adapters ??= [];
  snapshot.chat_options = mapChatOptionAliases(snapshot.chat_options ?? {});
  {
    if (typeof snapshot.chat_options.stop === 'string') snapshot.chat_options.stop = [snapshot.chat_options.stop];
    if (Array.isArray(snapshot.chat_options.stop) && !snapshot.chat_options.stop.length) delete snapshot.chat_options.stop;
  }
  return sortedValue(snapshot);
}

export function settingsEqual(left: Partial<ExecutionSettings>, right: Partial<ExecutionSettings>): boolean {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

export interface SettingChange {
  key: string;
  path?: string[];
  /** Absent when the setting is only being added, or is moving to inherited. */
  before?: unknown;
  after?: unknown;
  beforeInherited?: boolean;
  afterInherited?: boolean;
}

function serverArgumentGroups(value: unknown): { groups: Record<string, string[]>; order: string[] } | null {
  if (!Array.isArray(value) || !value.every((token): token is string => typeof token === 'string')) return null;
  const groups: Record<string, string[]> = {};
  const order: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const flag = value[index].match(/^--?[a-zA-Z][\w.-]*/)?.[0];
    if (!flag) return null;
    order.push(flag);
    const tokens = [value[index]];
    while (index + 1 < value.length && !/^--?[a-zA-Z][\w.-]*/.test(value[index + 1])) tokens.push(value[++index]);
    (groups[flag] ??= []).push(tokens.join(' '));
  }
  return { groups, order };
}

function loraAdapterGroups(value: unknown): Record<string, Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  const groups: Record<string, Record<string, unknown>> = {};
  for (const adapter of value) {
    if (!adapter || typeof adapter !== 'object' || Array.isArray(adapter)) return null;
    const { path, ...settings } = adapter as Record<string, unknown>;
    if (typeof path !== 'string' || !path || Object.prototype.hasOwnProperty.call(groups, path)) return null;
    groups[path] = settings;
  }
  return groups;
}

/**
 * Which settings a save would rewrite, and what they would go from and to.
 *
 * Compared through the same normalization `settingsEqual` decides on, so a save
 * that reports no changes and a save that is refused as unchanged always agree.
 * A key that moved to the runtime default drops out of the normalized snapshot,
 * which is itself a change worth showing: it had a value and will not any more.
 */
export function changedSettings(saved: Partial<ExecutionSettings>, current: Partial<ExecutionSettings>): SettingChange[] {
  const before = comparable(saved) as Record<string, unknown>;
  const after = comparable(current) as Record<string, unknown>;
  const beforeDefaults = new Set(before.runtime_defaults as string[]);
  const afterDefaults = new Set(after.runtime_defaults as string[]);
  const changes: SettingChange[] = [];
  const record = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  const visit = (path: string[], previous: unknown, next: unknown, beforeInherited = false, afterInherited = false) => {
    if (JSON.stringify(previous) === JSON.stringify(next) && beforeInherited === afterInherited) return;
    if ((record(previous) && (record(next) || next === undefined)) || (previous === undefined && record(next))) {
      const left = record(previous) ? previous : {};
      const right = record(next) ? next : {};
      const children = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort((a, b) => a.localeCompare(b));
      if (children.length) {
        for (const child of children) visit([...path, child], left[child], right[child], beforeInherited, afterInherited);
        return;
      }
    }
    changes.push({ key: path.join('.'), ...(path.length > 1 ? { path } : {}),
      before: previous, after: next,
      ...(beforeInherited ? { beforeInherited: true } : {}),
      ...(afterInherited ? { afterInherited: true } : {}) });
  };
  const keys = new Set([...Object.keys(before), ...Object.keys(after), ...beforeDefaults, ...afterDefaults]);
  keys.delete('runtime_defaults');
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    if (key === 'server_args' || key === 'lora_adapters') {
      const previousArgs = key === 'server_args' ? serverArgumentGroups(before[key]) : null;
      const nextArgs = key === 'server_args' ? serverArgumentGroups(after[key]) : null;
      const previous = key === 'server_args' ? previousArgs?.groups : loraAdapterGroups(before[key]);
      const next = key === 'server_args' ? nextArgs?.groups : loraAdapterGroups(after[key]);
      if (previous && next) {
        const start = changes.length;
        visit([key], previous, next);
        // Retained flags can change precedence even alongside a value edit.
        // Added/removed flags already have their own rows; compare their shared order only.
        const orderChanged = previousArgs && nextArgs
          && JSON.stringify(previousArgs.order.filter(flag => Object.prototype.hasOwnProperty.call(nextArgs.groups, flag)))
            !== JSON.stringify(nextArgs.order.filter(flag => Object.prototype.hasOwnProperty.call(previousArgs.groups, flag)));
        if (!orderChanged && (changes.length > start || JSON.stringify(before[key]) === JSON.stringify(after[key]))) continue;
      }
    }
    visit([key], before[key], after[key], beforeDefaults.has(key), afterDefaults.has(key));
  }
  return changes;
}

export function profileMatches(profile: SettingsProfile, cfg: AppConfig, systemPrompt: string): boolean {
  if ((profile.provider ?? 'llama.cpp') !== providerOf(cfg)) return false;
  if (profile.system_prompt !== undefined && profile.system_prompt.trim() !== systemPrompt.trim()) return false;
  return settingsEqual(profileSettingsSnapshot(applySettingsProfile(cfg, profile)), profileSettingsSnapshot(cfg));
}

export function materializeProfileApplication(cfg: AppConfig, systemPrompt: string, profile: SettingsProfile): ProfileApplication {
  return {
    model: cfg.active_model,
    provider: providerOf(cfg),
    profile_id: profile.id, profile_name: profile.name, profile_revision: profile.revision,
    settings: profileSettingsSnapshot(cfg), system_prompt: systemPrompt,
  };
}
