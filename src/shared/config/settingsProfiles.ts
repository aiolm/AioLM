import type { AppConfig } from '../api/types';
import { normalizeDisplayPath } from '../lib/displayPaths';
import { EXECUTION_KEYS, executionSettings, type ExecutionKey, type ExecutionSettings } from './executionSettings';
import { RUNTIME_DEFAULT_KEYS } from './tuningDefaults';
import { tuningResetValues } from './tuningResetValues';
import { canonicalServerOptionName, mapChatOptionAliases } from './tuningValidation';
import { cloneGpuPlacement } from '../runtime/sessionUtils';

export interface SettingsProfile {
  id: string;
  name: string;
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
  model: string;
  profile_id?: string;
  profile_name?: string;
  profile_revision?: number;
  settings: Partial<ExecutionSettings>;
  system_prompt: string;
}

export interface SettingsProfileLibrary {
  version: 1;
  revision: number;
  entries: SettingsProfile[];
  default_profile_id?: string;
  applied: Record<string, ProfileApplication>;
  legacy_imported: boolean;
}

export const MODEL_PROFILE_KEYS = EXECUTION_KEYS.filter(key => key !== 'active_model');
export const GLOBAL_PROFILE_KEYS: readonly ExecutionKey[] = [
  'runtime_defaults', 'ctx_size', 'batch_size', 'ubatch_size', 'keep', 'cache_type_k', 'cache_type_v',
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
  return { id: DEFAULT_SETTINGS_PROFILE_ID, name: 'Default', scope: 'global', revision: 1, system_prompt: '',
    settings: { runtime_defaults: DEFAULT_PROFILE_KEYS.filter(key => RUNTIME_DEFAULT_KEYS.includes(key)), chat_options: {} },
    legacy: true, coverage: [...DEFAULT_PROFILE_KEYS] };
}

export function ensureProfileLibrary(library: SettingsProfileLibrary): SettingsProfileLibrary {
  const populated = library.entries.length ? library : { ...library, entries: [defaultSettingsProfile()] };
  const selected = populated.entries.find(entry => entry.id === populated.default_profile_id)
    ?? populated.entries.find(entry => entry.id === DEFAULT_SETTINGS_PROFILE_ID)
    ?? populated.entries.find(entry => entry.scope === 'global') ?? populated.entries[0];
  return setDefaultSettingsProfile(populated, selected.id);
}

/** A designated default must be applicable to every model without changing its saved identity. */
export function setDefaultSettingsProfile(library: SettingsProfileLibrary, id: string): SettingsProfileLibrary {
  const selected = library.entries.find(entry => entry.id === id);
  if (!selected) throw new Error('This profile is no longer available.');
  const promoted = selected.scope === 'model' || selected.model_key !== undefined || selected.source_id !== undefined || selected.source_scope !== undefined;
  if (library.default_profile_id === id && !promoted) return library;
  let profile = selected;
  if (promoted) {
    profile = { ...selected, scope: 'global', revision: selected.revision + 1,
      ...(selected.scope === 'model' ? { legacy: true, coverage: [...ownedKeys(selected)] } : {}) };
    delete profile.model_key;
    delete profile.source_id;
    delete profile.source_scope;
  }
  return { ...library, default_profile_id: id, entries: library.entries.map(entry => entry.id === id ? profile : entry) };
}

export function defaultSettingsProfileEntry(library: SettingsProfileLibrary): SettingsProfile {
  const normalized = ensureProfileLibrary(library);
  return normalized.entries.find(entry => entry.id === normalized.default_profile_id)!;
}

/** Removing a source includes the model copies created from that source. */
export function profileDeletionIds(library: SettingsProfileLibrary, id: string): Set<string> {
  const defaultId = defaultSettingsProfileEntry(library).id;
  const removed = new Set(library.entries.some(entry => entry.id === id) ? [id] : []);
  let previousSize = -1;
  while (removed.size !== previousSize) {
    previousSize = removed.size;
    for (const entry of library.entries) if (entry.id !== defaultId && entry.source_id && removed.has(entry.source_id)) removed.add(entry.id);
  }
  return removed;
}

export function canDeleteSettingsProfile(library: SettingsProfileLibrary, id: string): boolean {
  return library.entries.some(entry => entry.id === id) && profileDeletionReason(library, id) === undefined;
}

export function profileDeletionReason(library: SettingsProfileLibrary, id: string): 'default' | undefined {
  return defaultSettingsProfileEntry(library).id === id ? 'default' : undefined;
}

export function deleteSettingsProfile(source: SettingsProfileLibrary, id: string): SettingsProfileLibrary {
  const library = ensureProfileLibrary(source);
  if (profileDeletionReason(library, id)) throw new Error('The default profile cannot be deleted. Choose another default profile first.');
  const removed = profileDeletionIds(library, id);
  if (!removed.size) throw new Error('This profile is no longer available.');
  const entries = library.entries.filter(entry => !removed.has(entry.id));
  const fallback = defaultSettingsProfileEntry(library);
  const applied = Object.fromEntries(Object.entries(library.applied).map(([key, application]) => {
    if (!application.profile_id || !removed.has(application.profile_id)) return [key, application];
    const cfg = applySettingsProfile(profileApplicationConfig(application), fallback);
    return [key, materializeProfileApplication(cfg, fallback.system_prompt ?? application.system_prompt, fallback)];
  }));
  return { ...library, entries, applied };
}

/** Expand saved execution fields with product defaults without reading another target's configuration. */
export function profileApplicationConfig(application: ProfileApplication): AppConfig {
  const baseline = applySettingsProfile({ active_model: application.model } as AppConfig, {
    id: 'profile-application-defaults', name: 'Default', scope: 'global', revision: 1,
    legacy: true, coverage: [...MODEL_PROFILE_KEYS], settings: {},
  });
  return { ...baseline, ...profileSettingsSnapshot(application.settings), active_model: application.model,
    runtime_defaults: application.settings.runtime_defaults ?? (baseline.runtime_defaults ?? []).filter(field => !(field in application.settings)) };
}

export function profileTargetKey(modelPath: string, sessionId = 'default'): string {
  return sessionId === 'default'
    ? `model:${normalizeDisplayPath(modelPath).replace(/\\/g, '/').toLowerCase()}`
    : `session:${sessionId}`;
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
  if (settings.server_args) settings.server_args = profileArgs(settings.server_args);
  return settings;
}

function captureSettings(cfg: AppConfig, scope: SettingsProfile['scope']): Partial<ExecutionSettings> {
  const allowed = scope === 'global' ? GLOBAL_PROFILE_KEYS : MODEL_PROFILE_KEYS;
  const snapshot = profileSettingsSnapshot(cfg);
  const settings = Object.fromEntries(Object.entries(snapshot).filter(([key]) => allowed.includes(key as ExecutionKey))) as Partial<ExecutionSettings>;
  settings.runtime_defaults = [...new Set((cfg.runtime_defaults ?? []).filter(key => allowed.includes(key as ExecutionKey)))].sort();
  return settings;
}

export function captureProfile(cfg: AppConfig, name: string, scope: SettingsProfile['scope'], systemPrompt: string): SettingsProfile {
  if (!name.trim()) throw new Error('A profile name is required.');
  if (scope === 'model' && !cfg.active_model.trim()) throw new Error('Choose a model before saving its profile.');
  return {
    id: `profile-${crypto.randomUUID()}`, name: name.trim(), scope, revision: 1,
    ...(scope === 'model' ? { model_key: profileTargetKey(cfg.active_model) } : {}),
    settings: captureSettings(cfg, scope), system_prompt: systemPrompt,
  };
}

function ownedKeys(profile: SettingsProfile): readonly ExecutionKey[] {
  if (!profile.legacy) return profile.scope === 'global' ? GLOBAL_PROFILE_KEYS : MODEL_PROFILE_KEYS;
  const fields = profile.coverage ?? [...Object.keys(profile.settings), ...(profile.settings.runtime_defaults ?? [])];
  return MODEL_PROFILE_KEYS.filter(key => fields.includes(key));
}

/** An explicit save updates the chosen entry and captures every editable field. */
export function saveSettingsProfile(entry: SettingsProfile, cfg: AppConfig, systemPrompt: string,
  excludedKeys: ReadonlySet<string> = new Set(), preservePrompt = false): SettingsProfile {
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
  if (profile.scope === 'model' && profile.model_key && profile.model_key !== profileTargetKey(cfg.active_model)) {
    throw new Error('This profile belongs to a different model.');
  }
  const keys = ownedKeys(profile);
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
  /** Absent when the setting is only being added, or is moving to inherited. */
  before?: unknown;
  after?: unknown;
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
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort((left, right) => left.localeCompare(right))
    .filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
    .map(key => ({ key, before: before[key], after: after[key] }));
}

export function profileMatches(profile: SettingsProfile, cfg: AppConfig, systemPrompt: string): boolean {
  if (profile.scope === 'model' && profile.model_key && profile.model_key !== profileTargetKey(cfg.active_model)) return false;
  if (profile.system_prompt !== undefined && profile.system_prompt.trim() !== systemPrompt.trim()) return false;
  return settingsEqual(settingsSnapshot(applySettingsProfile(cfg, profile)), settingsSnapshot(cfg));
}

export function materializeProfileApplication(cfg: AppConfig, systemPrompt: string, profile: SettingsProfile): ProfileApplication {
  return {
    model: cfg.active_model,
    profile_id: profile.id, profile_name: profile.name, profile_revision: profile.revision,
    settings: profileSettingsSnapshot(cfg), system_prompt: systemPrompt,
  };
}
