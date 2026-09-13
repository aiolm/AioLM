import type { AppConfig } from '../api/types';
import { sessionConfig } from '../runtime/sessionUtils';
import {
  applySettingsProfile, defaultSettingsProfileEntry, ensureProfileLibrary, materializeProfileApplication,
  MODEL_PROFILE_KEYS, profileApplicationConfig, profileMatches, profileSettingsSnapshot, profileTargetKey,
  type ProfileApplication, type SettingsProfile, type SettingsProfileLibrary,
} from './settingsProfiles';

export interface ResolvedProfileApplication {
  library: SettingsProfileLibrary;
  application: ProfileApplication;
  profile: SettingsProfile;
}

function compatible(profile: SettingsProfile, model: string): boolean {
  return profile.scope === 'global' || Boolean(model && (!profile.model_key || profile.model_key === profileTargetKey(model)));
}

function recoveredId(library: SettingsProfileLibrary, targetKey: string): string {
  let hash = 2166136261;
  for (let index = 0; index < targetKey.length; index++) hash = Math.imul(hash ^ targetKey.charCodeAt(index), 16777619);
  const base = `profile-recovered-${(hash >>> 0).toString(16)}`;
  let id = base;
  let suffix = 2;
  while (library.entries.some(entry => entry.id === id)) id = `${base}-${suffix++}`;
  return id;
}

export function applyDefaultProfile(cfg: AppConfig, source: SettingsProfileLibrary): ResolvedProfileApplication {
  const library = ensureProfileLibrary(source);
  const profile = defaultSettingsProfileEntry(library);
  return { library, profile, application: materializeProfileApplication(applySettingsProfile(cfg, profile), profile.system_prompt ?? '', profile) };
}

/** Explicit references to removed profiles use the designated default; anonymous legacy values are recovered. */
export function resolveProfileApplicationOrDefault(
  cfg: AppConfig, library: SettingsProfileLibrary, saved?: ProfileApplication, targetKey = profileTargetKey(cfg.active_model),
): ResolvedProfileApplication {
  if (saved?.profile_id && !library.entries.some(entry => entry.id === saved.profile_id)) {
    return applyDefaultProfile({ ...cfg, ...saved.settings, active_model: saved.model }, library);
  }
  return resolveProfileApplication(cfg, library, saved, targetKey);
}

/** Resolve the current saved profile for a new edit or execution without changing live snapshots. */
export function resolveProfileForExecution(
  cfg: AppConfig, source: SettingsProfileLibrary, saved?: ProfileApplication, targetKey = profileTargetKey(cfg.active_model),
): ResolvedProfileApplication {
  const library = ensureProfileLibrary(source);
  const reference = saved ?? library.applied[targetKey];
  if (!reference) return applyDefaultProfile(cfg, library);
  const target = { ...cfg, ...(profileTargetKey(reference.model) === profileTargetKey(cfg.active_model) ? reference.settings : {}), active_model: cfg.active_model };
  if (reference.profile_id) {
    const profile = library.entries.find(entry => entry.id === reference.profile_id && compatible(entry, cfg.active_model));
    if (!profile) return applyDefaultProfile(target, library);
    return { library, profile, application: materializeProfileApplication(applySettingsProfile(target, profile),
      profile.system_prompt ?? reference.system_prompt, profile) };
  }
  const resolved = resolveProfileApplication(target, library, { ...reference, model: cfg.active_model }, targetKey);
  return { ...resolved, application: materializeProfileApplication(applySettingsProfile(target, resolved.profile),
    resolved.profile.system_prompt ?? reference.system_prompt, resolved.profile) };
}

/** Resolve a saved or working snapshot to a named profile without changing its values. */
export function resolveProfileApplication(
  cfg: AppConfig,
  source: SettingsProfileLibrary,
  saved?: ProfileApplication,
  targetKey = profileTargetKey(cfg.active_model),
): ResolvedProfileApplication {
  let library = ensureProfileLibrary(source);
  const prompt = saved?.system_prompt ?? '';
  const target = saved ? { ...cfg, ...saved.settings, active_model: saved.model } : cfg;
  const assigned = library.entries.find(entry => entry.id === saved?.profile_id && compatible(entry, target.active_model));
  if (assigned) {
    const revision = saved?.profile_revision;
    const validRevision = typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 && revision <= assigned.revision;
    return { library, profile: assigned, application: { ...structuredClone(saved!), profile_id: assigned.id,
      profile_name: assigned.name, profile_revision: validRevision ? revision : assigned.revision } };
  }
  let profile = library.entries.find(entry => compatible(entry, target.active_model) && profileMatches(entry, target, prompt));
  // Before a model is chosen, the initial workspace belongs to its portable default profile.
  if (!profile && !target.active_model && !saved) profile = defaultSettingsProfileEntry(library);
  if (!profile) {
    profile = {
      id: recoveredId(library, targetKey), name: 'Recovered profile', scope: target.active_model ? 'model' : 'global', revision: 1,
      ...(target.active_model ? { model_key: profileTargetKey(target.active_model) } : { legacy: true, coverage: [...MODEL_PROFILE_KEYS] }),
      settings: profileSettingsSnapshot(target), system_prompt: prompt,
    };
    library = { ...library, entries: [...library.entries, profile] };
  }
  const application = saved ? { ...structuredClone(saved), profile_id: profile.id, profile_name: profile.name, profile_revision: profile.revision }
    : materializeProfileApplication(target, prompt, profile);
  return { library, application, profile };
}

/** Every persisted execution target has a profile identity, including the empty initial workspace. */
export function ensureProfileAssignments(cfg: AppConfig, source: SettingsProfileLibrary): SettingsProfileLibrary {
  let library = structuredClone(ensureProfileLibrary(source));
  if (cfg.active_model) delete library.applied[profileTargetKey('')];
  for (const [key, application] of Object.entries(library.applied)) {
    const definition = (cfg.sessions ?? []).find(session => profileTargetKey(session.models.primary_model, session.id) === key);
    if (definition && profileTargetKey(definition.models.primary_model) !== profileTargetKey(application.model)) continue;
    const target = { ...cfg, ...profileApplicationConfig(application) };
    const resolved = resolveProfileApplication(target, library, application, key);
    library = { ...resolved.library, applied: { ...resolved.library.applied, [key]: resolved.application } };
  }
  const currentKey = profileTargetKey(cfg.active_model);
  if (!library.applied[currentKey]) {
    if (!cfg.active_model) {
      library.applied[currentKey] = applyDefaultProfile(cfg, library).application;
    } else {
      const resolved = resolveProfileApplication(cfg, library);
      library = { ...resolved.library, applied: { ...resolved.library.applied, [currentKey]: resolved.application } };
    }
  }
  for (const definition of cfg.sessions ?? []) {
    if (definition.id === 'default' || !definition.models.primary_model) continue;
    const key = profileTargetKey(definition.models.primary_model, definition.id);
    const existing = library.applied[key];
    if (existing && profileTargetKey(existing.model) === profileTargetKey(definition.models.primary_model)) continue;
    const target = sessionConfig(cfg, definition);
    const saved = existing ? { ...existing, model: target.active_model, settings: profileSettingsSnapshot(target) } : undefined;
    const resolved = resolveProfileApplication(target, library, saved, key);
    library = { ...resolved.library, applied: { ...resolved.library.applied, [key]: resolved.application } };
  }
  return library;
}
