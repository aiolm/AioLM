import type { AppConfig } from '../api/types';
import { providerOf } from '../api/providers';
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

function assignedApplication(saved: ProfileApplication, profile: SettingsProfile): ProfileApplication {
  const revision = saved.profile_revision;
  const validRevision = typeof revision === 'number' && Number.isSafeInteger(revision) && revision > 0 && revision <= profile.revision;
  return { ...saved, profile_id: profile.id, profile_name: profile.name,
    profile_revision: validRevision ? revision : profile.revision };
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
  const profile = defaultSettingsProfileEntry(library, providerOf(cfg));
  return { library, profile, application: materializeProfileApplication(applySettingsProfile(cfg, profile), profile.system_prompt ?? '', profile) };
}

/** Explicit references to removed profiles use the designated default; anonymous legacy values are recovered. */
export function resolveProfileApplicationOrDefault(
  cfg: AppConfig, library: SettingsProfileLibrary, saved?: ProfileApplication, targetKey = profileTargetKey(cfg.active_model, 'default', providerOf(cfg)),
): ResolvedProfileApplication {
  if (saved && ((saved.provider ?? 'llama.cpp') !== providerOf(cfg) || saved.profile_id && !library.entries.some(entry => entry.id === saved.profile_id))) {
    return applyDefaultProfile(cfg, library);
  }
  return resolveProfileApplication(cfg, library, saved, targetKey);
}

/** Resolve the current saved profile for a new edit or execution without changing live snapshots. */
export function resolveProfileForExecution(
  cfg: AppConfig, source: SettingsProfileLibrary, saved?: ProfileApplication, targetKey = profileTargetKey(cfg.active_model, 'default', providerOf(cfg)),
): ResolvedProfileApplication {
  const library = ensureProfileLibrary(source);
  const reference = saved ?? library.applied[targetKey];
  if (reference && (reference.provider ?? 'llama.cpp') !== providerOf(cfg)) return applyDefaultProfile(cfg, library);
  if (!reference) return applyDefaultProfile(cfg, library);
  const target = { ...cfg, ...(profileTargetKey(reference.model) === profileTargetKey(cfg.active_model) ? profileSettingsSnapshot({ ...reference.settings, active_provider: providerOf(cfg) }) : {}), active_model: cfg.active_model };
  if (reference.profile_id) {
    const profile = library.entries.find(entry => entry.id === reference.profile_id && (entry.provider ?? 'llama.cpp') === providerOf(cfg));
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
  targetKey = profileTargetKey(cfg.active_model, 'default', providerOf(cfg)),
): ResolvedProfileApplication {
  let library = ensureProfileLibrary(source);
  const prompt = saved?.system_prompt ?? '';
  const target = saved ? { ...cfg, ...profileSettingsSnapshot({ ...saved.settings, active_provider: providerOf(cfg) }), active_model: saved.model } : cfg;
  const assigned = library.entries.find(entry => entry.id === saved?.profile_id && (entry.provider ?? 'llama.cpp') === providerOf(cfg));
  if (assigned) {
    return { library, profile: assigned, application: assignedApplication(structuredClone(saved!), assigned) };
  }
  let profile = library.entries.find(entry => profileMatches(entry, target, prompt));
  // Before a model is chosen, the initial workspace belongs to its portable default profile.
  if (!profile && !target.active_model && !saved) profile = defaultSettingsProfileEntry(library, providerOf(cfg));
  if (!profile) {
    profile = {
      id: recoveredId(library, targetKey), name: 'Recovered profile', scope: 'global', revision: 1,
      provider: providerOf(cfg),
      legacy: true, coverage: [...MODEL_PROFILE_KEYS],
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
  const profiles = new Map(library.entries.map(profile => [profile.id, profile]));
  const sessionModels = new Map((cfg.sessions ?? []).map(definition => [
    profileTargetKey(definition.models.primary_model, definition.id), profileTargetKey(definition.models.primary_model),
  ]));
  // The library is detached from its source. Updating this map directly avoids
  // copying every saved target again for each individual assignment.
  const applyResolved = (key: string, resolved: ResolvedProfileApplication) => {
    library = resolved.library;
    library.applied[key] = resolved.application;
    profiles.set(resolved.profile.id, resolved.profile);
  };
  if (cfg.active_model) delete library.applied[profileTargetKey('')];
  for (const [key, application] of Object.entries(library.applied)) {
    const sessionModel = sessionModels.get(key);
    if (sessionModel !== undefined && sessionModel !== profileTargetKey(application.model)) continue;
    const assigned = application.profile_id ? profiles.get(application.profile_id) : undefined;
    if (assigned && (assigned.provider ?? 'llama.cpp') === (application.provider ?? 'llama.cpp')) {
      // Named snapshots retain their saved values and revision. Only recovery
      // needs to reconstruct defaults and search profiles by their settings.
      library.applied[key] = assignedApplication(application, assigned);
      continue;
    }
    const target = { ...cfg, ...profileApplicationConfig(application) };
    applyResolved(key, resolveProfileApplication(target, library, application, key));
  }
  const currentKey = profileTargetKey(cfg.active_model, 'default', providerOf(cfg));
  if (!library.applied[currentKey]) {
    if (!cfg.active_model) {
      library.applied[currentKey] = applyDefaultProfile(cfg, library).application;
    } else {
      applyResolved(currentKey, resolveProfileApplication(cfg, library));
    }
  }
  for (const definition of cfg.sessions ?? []) {
    if (definition.id === 'default' || !definition.models.primary_model) continue;
    const key = profileTargetKey(definition.models.primary_model, definition.id);
    const existing = library.applied[key];
    if (existing && profileTargetKey(existing.model) === profileTargetKey(definition.models.primary_model)) continue;
    const target = sessionConfig(cfg, definition);
    const saved = existing ? { ...existing, model: target.active_model, settings: profileSettingsSnapshot(target) } : undefined;
    applyResolved(key, resolveProfileApplication(target, library, saved, key));
  }
  return library;
}
