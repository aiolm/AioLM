import type { AppConfig } from '../../shared/api/types';
import { emptyProfileLibrary, ensureProfileLibrary, profileApplicationConfig, profileTargetKey, saveSettingsProfile, type ProfileApplication, type SettingsProfileLibrary } from '../../shared/config/settingsProfiles';
import { migrateProfileLibrary } from '../../shared/config/profileMigration';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { ensureProfileAssignments } from '../../shared/config/profileAssignments';
import type { ModelProfile } from '../profiles/modelProfiles';
import { executionChanges, executionConfig, settingsForSession } from '../../shared/config/executionSettings';
import { sessionConfig } from '../../shared/runtime/sessionUtils';
import { BENCHMARK_CONTROLLED_KEYS } from './profileResetState';

export function requestProfileFromApplication(application?: ProfileApplication | null): ModelProfile | null {
  if (!application) return null;
  const settings = application.settings;
  const defaults = tuningResetValues();
  const stop = settings.chat_options?.stop;
  return { id: application.profile_id ?? '', name: application.profile_name ?? '', system_prompt: application.system_prompt,
    temperature: settings.temperature ?? defaults.temperature!, top_p: settings.top_p ?? defaults.top_p!, top_k: settings.top_k ?? defaults.top_k!,
    reasoning_effort: settings.reasoning_effort ?? '', runtime_defaults: settings.runtime_defaults,
    chat_options: structuredClone(settings.chat_options ?? {}), stop_strings: typeof stop === 'string' ? [stop] : Array.isArray(stop) ? stop.filter((item): item is string => typeof item === 'string') : [] };
}

export interface ProfileEditorResult {
  baseRevision: number;
  library: SettingsProfileLibrary;
  baseLibrary?: SettingsProfileLibrary;
  application: ProfileApplication;
  saveMode?: 'all' | 'benchmark';
}
export interface ProfileCommitResult { config: AppConfig; application: ProfileApplication }

export function profileLibrary(cfg: AppConfig): SettingsProfileLibrary {
  return ensureProfileAssignments(cfg, ensureProfileLibrary(cfg.settings_profiles ?? migrateProfileLibrary(cfg)));
}

export function appliedProfile(cfg: AppConfig, sessionId = 'default'): ProfileApplication | undefined {
  const application = profileLibrary(cfg).applied[profileTargetKey(cfg.active_model, sessionId)];
  return application && profileTargetKey(application.model) === profileTargetKey(cfg.active_model) ? application : undefined;
}

/** Commit selected profile values and their target application in the same configuration write. */
export function mergeProfileEditor(current: AppConfig, edit: ProfileEditorResult, sessionId?: string): SettingsProfileLibrary {
  const latest = current.settings_profiles ?? emptyProfileLibrary();
  let library = edit.library;
  let baseRevision = edit.baseRevision;
  if (latest.revision !== baseRevision) {
    const rebased = rebaseStaleProfileEdit(edit.baseLibrary, latest, library);
    if (!rebased) throw new Error('Profiles changed elsewhere. Reopen settings to review the latest profiles.');
    library = rebased;
    baseRevision = latest.revision;
  }
  if (!library.entries.length) throw new Error('At least one profile must remain.');
  const next = structuredClone(ensureProfileLibrary(library));
  next.applied = { ...latest.applied, ...next.applied };
  let application = structuredClone(edit.application);
  if (edit.saveMode) {
    const entry = next.entries.find(profile => profile.id === application.profile_id);
    if (!entry) throw new Error('This profile is no longer available.');
    const savedRevision = latest.entries.find(profile => profile.id === entry.id)?.revision ?? 0;
    const benchmark = edit.saveMode === 'benchmark';
    const saved = saveSettingsProfile(entry, profileApplicationConfig(application), application.system_prompt,
      benchmark ? BENCHMARK_CONTROLLED_KEYS : undefined, benchmark);
    saved.revision = Math.max(entry.revision, savedRevision + 1);
    next.entries = next.entries.map(profile => profile.id === saved.id ? saved : profile);
    application = { ...application, profile_name: saved.name, profile_revision: saved.revision };
  }
  if (sessionId !== undefined) {
    next.applied[profileTargetKey(application.model, sessionId)] = application;
  }
  const available = new Set(next.entries.map(profile => profile.id));
  for (const [key, application] of Object.entries(next.applied)) {
    if (!application.profile_id || !available.has(application.profile_id)) throw new Error('Every model must reference an available profile.');
    const entry = next.entries.find(profile => profile.id === application.profile_id)!;
    next.applied[key] = { ...application, profile_name: entry.name };
  }
  next.revision = latest.revision + 1;
  next.legacy_imported = true;
  return next;
}

/** Rebase a stale library edit onto the latest saved library when it is safe.
 * Returns the rebased library, or null when the user and another writer changed
 * the same profile entry or default in conflicting ways. Callers without a base
 * snapshot preserve the previous strict revision check. */
export function rebaseStaleProfileEdit(base: SettingsProfileLibrary | undefined, latest: SettingsProfileLibrary, edited: SettingsProfileLibrary): SettingsProfileLibrary | null {
  if (!base) return null;
  const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
  const baseEntries = new Map(base.entries.map(entry => [entry.id, entry]));
  const latestEntries = new Map(latest.entries.map(entry => [entry.id, entry]));
  const editedEntries = new Map(edited.entries.map(entry => [entry.id, entry]));
  const mergedEntries: SettingsProfileLibrary['entries'] = [];
  // Preserve the user's entry order; background-only additions are appended.
  for (const entry of edited.entries) {
    const id = entry.id;
    const baseEntry = baseEntries.get(id);
    const latestEntry = latestEntries.get(id);
    if (baseEntry && same(entry, baseEntry)) {
      // The user did not touch this entry: adopt the latest version (which may
      // have changed, or have been deleted elsewhere).
      if (latestEntry) mergedEntries.push(structuredClone(latestEntry));
      continue;
    }
    if (!baseEntry) {
      // Added by the user. A background addition with the same id but different
      // content is a true conflict.
      if (latestEntry && !same(entry, latestEntry)) return null;
      mergedEntries.push(structuredClone(entry));
      continue;
    }
    if (!latestEntry) return null; // Deleted elsewhere while the user edited it.
    if (same(latestEntry, baseEntry)) { mergedEntries.push(structuredClone(entry)); continue; }
    if (same(latestEntry, entry)) { mergedEntries.push(structuredClone(entry)); continue; }
    return null;
  }
  for (const entry of latest.entries) {
    if (editedEntries.has(entry.id) || baseEntries.has(entry.id)) continue;
    mergedEntries.push(structuredClone(entry));
  }
  if (!mergedEntries.length) return null;
  const baseDefault = base.default_profile_id;
  const latestDefault = latest.default_profile_id;
  const editedDefault = edited.default_profile_id;
  let default_profile_id = editedDefault;
  if (editedDefault !== baseDefault) {
    if (latestDefault !== baseDefault && latestDefault !== editedDefault) return null;
  } else {
    default_profile_id = latestDefault;
  }
  const baseApplied = base.applied ?? {};
  const latestApplied = latest.applied ?? {};
  const editedApplied = edited.applied ?? {};
  const applied: SettingsProfileLibrary['applied'] = {};
  for (const key of new Set([...Object.keys(baseApplied), ...Object.keys(latestApplied), ...Object.keys(editedApplied)])) {
    const baseValue = baseApplied[key];
    const latestValue = latestApplied[key];
    const editedValue = editedApplied[key];
    if (editedValue === undefined) {
      // Removed by the user only if it existed in the base; otherwise adopt latest.
      if (baseValue !== undefined) continue;
      if (latestValue !== undefined) applied[key] = structuredClone(latestValue);
      continue;
    }
    if (baseValue === undefined) {
      if (latestValue !== undefined && !same(editedValue, latestValue)) return null;
      applied[key] = structuredClone(editedValue);
      continue;
    }
    if (same(editedValue, baseValue)) {
      if (latestValue !== undefined) applied[key] = structuredClone(latestValue);
      continue;
    }
    if (latestValue !== undefined && same(latestValue, baseValue)) { applied[key] = structuredClone(editedValue); continue; }
    if (latestValue !== undefined && same(latestValue, editedValue)) { applied[key] = structuredClone(editedValue); continue; }
    return null;
  }
  return { ...structuredClone(latest), entries: mergedEntries, applied, default_profile_id, legacy_imported: edited.legacy_imported || latest.legacy_imported };
}

/** Persist replacement settings with the library when a profile is deleted. */
export function profileLibraryConfigPatch(current: AppConfig, edit: ProfileEditorResult): Partial<AppConfig> {
  const library = mergeProfileEditor(current, edit);
  const removed = new Set((current.settings_profiles?.entries ?? []).filter(entry => !library.entries.some(next => next.id === entry.id)).map(entry => entry.id));
  const replacement = (model: string, sessionId = 'default') => {
    const key = profileTargetKey(model, sessionId);
    const previous = current.settings_profiles?.applied[key];
    const next = library.applied[key];
    return previous?.profile_id && removed.has(previous.profile_id) && next && profileTargetKey(next.model) === profileTargetKey(model) ? next : undefined;
  };
  const patch: Partial<AppConfig> = { settings_profiles: library };
  const active = replacement(current.active_model);
  if (active) Object.assign(patch, executionChanges(current, executionConfig(current, active.settings)));
  let changed = false;
  const sessions = current.sessions?.map(definition => {
    const application = replacement(definition.models.primary_model, definition.id);
    if (!application) return definition;
    changed = true;
    const next = settingsForSession(definition, executionConfig(sessionConfig(current, definition), application.settings));
    delete next.model_profile_id;
    return next;
  });
  if (changed) patch.sessions = sessions;
  return patch;
}

/** A save can succeed before runtime start or delivery to another editor fails. */
export class SettingsDeliveryError extends Error {
  constructor(message: string, public readonly saved: AppConfig, public readonly application: ProfileApplication) { super(message); }
}
