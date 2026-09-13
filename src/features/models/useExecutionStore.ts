import { useCallback, useRef, useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/api/types';
import type { ConfigPatch } from '../../shared/state/configSaveQueue';
import { MODEL_EXECUTION_KEY, rememberExecution, restoreExecution } from './modelExecutionState';
import { executionChanges } from '../../shared/config/executionSettings';
import {
  emptyProfileLibrary, materializeProfileApplication, saveSettingsProfile,
  profileSettingsSnapshot, profileTargetKey, settingsEqual, type SettingsProfileLibrary,
} from '../../shared/config/settingsProfiles';
import { applyDefaultProfile, ensureProfileAssignments, resolveProfileApplication, resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import { sessionConfig } from '../../shared/runtime/sessionUtils';

function saveTargetApplication(target: AppConfig, source: SettingsProfileLibrary, key: string): SettingsProfileLibrary {
  const previous = source.applied[key];
  const saved = previous && profileTargetKey(previous.model) !== profileTargetKey(target.active_model)
    ? { ...previous, model: target.active_model, settings: profileSettingsSnapshot(target) } : previous;
  const resolved = resolveProfileApplication(target, source, saved, key);
  let library = resolved.library;
  let profile = resolved.profile;
  const prompt = resolved.application.system_prompt;
  if (!settingsEqual(profileSettingsSnapshot(target), resolved.application.settings)) {
    profile = saveSettingsProfile(profile, target, prompt);
    const exists = library.entries.some(entry => entry.id === profile.id);
    library = { ...library, entries: exists ? library.entries.map(entry => entry.id === profile.id ? profile : entry) : [...library.entries, profile] };
  }
  return { ...library, applied: { ...library.applied, [key]: materializeProfileApplication(target, prompt, profile) } };
}

function applicationPatch(current: AppConfig, patch: Partial<AppConfig>): Partial<AppConfig> {
  const previous = current.settings_profiles;
  const target = { ...current, ...patch };
  if (patch.settings_profiles && JSON.stringify(patch.settings_profiles) !== JSON.stringify(previous)) {
    return { ...patch, settings_profiles: ensureProfileAssignments(target, patch.settings_profiles) };
  }
  let library = ensureProfileAssignments(current, previous ?? emptyProfileLibrary());
  if (Object.keys(executionChanges(current, target)).length) library = saveTargetApplication(target, library, profileTargetKey(target.active_model));
  if (patch.sessions) {
    for (const definition of patch.sessions) {
      if (definition.id === 'default' || !definition.models.primary_model) continue;
      const before = current.sessions?.find(session => session.id === definition.id);
      const nextConfig = sessionConfig(target, definition);
      if (!before || Object.keys(executionChanges(sessionConfig(current, before), nextConfig)).length) {
        library = saveTargetApplication(nextConfig, library, profileTargetKey(nextConfig.active_model, definition.id));
      }
    }
  }
  library = ensureProfileAssignments(target, library);
  if (JSON.stringify(previous) === JSON.stringify(library)) return patch;
  library.revision = (previous?.revision ?? 0) + 1;
  return { ...patch, settings_profiles: library };
}

/** All screens persist model settings through the same serialized native config queue. */
export function useExecutionStore(base: AppStore) {
  const latest = useRef(base);
  latest.current = base;
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const updateConfig = useCallback((patch: ConfigPatch<AppConfig>): Promise<AppConfig> => {
    const operation = pending.current.catch(() => undefined).then(async () => {
      const current = latest.current.getConfig();
      if (!current) throw new Error('Configuration is still loading.');
      let next = typeof patch === 'function' ? patch(current) : patch;
      const changesExecution = Object.keys(executionChanges(current, { ...current, ...next })).length > 0;
      if (changesExecution) next = withManualOverrides(current, next);
      next = applicationPatch(current, next);
      if (!changesExecution) {
        const saved = await latest.current.updateConfig(next); setError(null); return saved;
      }
      // Save the departing model before allowing a selection/project to overwrite it.
      if (next.active_model && next.active_model !== current.active_model) rememberExecution(current);
      const previousMemory = window.localStorage.getItem(MODEL_EXECUTION_KEY);
      // Detect storage/quota failures before publishing a new native selection.
      rememberExecution({ ...current, ...next });
      let saved: AppConfig;
      try {
        saved = await latest.current.updateConfig(next);
      } catch (cause) {
        if (previousMemory === null) window.localStorage.removeItem(MODEL_EXECUTION_KEY);
        else window.localStorage.setItem(MODEL_EXECUTION_KEY, previousMemory);
        throw cause;
      }
      try {
        rememberExecution(saved);
        setError(null);
      } catch (cause) {
        setError(`Settings were saved, but the local model cache could not be updated: ${String(cause)}`);
      }
      return saved;
    }).catch(cause => { setError(String(cause)); throw cause; });
    pending.current = operation;
    return operation;
  }, []);
  const selectModel = useCallback(async (path: string) => {
    await updateConfig(current => {
      if (current.active_model === path) return {};
      const patch = restoreExecution(current, path);
      const library = ensureProfileAssignments(current, current.settings_profiles ?? emptyProfileLibrary());
      const key = profileTargetKey(path);
      if (library.applied[key]) {
        const selected = resolveProfileForExecution({ ...current, ...patch }, library, library.applied[key], key);
        return { ...patch, ...selected.application.settings, settings_profiles: { ...selected.library, revision: library.revision + 1,
          applied: { ...library.applied, [key]: selected.application } } };
      }
      const selected = applyDefaultProfile({ ...current, ...patch }, library);
      return { ...patch, ...selected.application.settings, settings_profiles: { ...selected.library, revision: library.revision + 1,
        applied: { ...library.applied, [key]: selected.application } } };
    });
  }, [updateConfig]);
  const start = useCallback(async (_override?: AppConfig, replaceRunning = false) => {
    // A failed save rolls back config; a retry uses the saved profile rather than the failed draft.
    await pending.current.catch(() => undefined);
    setError(null);
    const current = latest.current.getConfig();
    if (!current) throw new Error('Configuration is still loading.');
    const prepare = (saved: AppConfig) => {
      const library = ensureProfileAssignments(saved, saved.settings_profiles ?? emptyProfileLibrary());
      const target = saved;
      const key = profileTargetKey(saved.active_model);
      const selected = resolveProfileForExecution(target, library, library.applied[key], key);
      const settings_profiles = { ...selected.library, applied: { ...selected.library.applied, [key]: selected.application } };
      const next = { ...target, ...selected.application.settings, settings_profiles };
      const patch: Partial<AppConfig> = executionChanges(saved, next);
      if (JSON.stringify(saved.settings_profiles) !== JSON.stringify(settings_profiles)) {
        patch.settings_profiles = { ...settings_profiles, revision: (saved.settings_profiles?.revision ?? 0) + 1 };
      }
      return { next, patch };
    };
    const prepared = prepare(current);
    const saved = Object.keys(prepared.patch).length ? await updateConfig(value => prepare(value).patch) : prepared.next;
    return latest.current.start(saved, replaceRunning);
  }, [updateConfig]);
  const clearErrors = useCallback(() => { setError(null); latest.current.clearErrors(); }, []);
  // Persistence is serialized above; only server lifecycle operations lock the app.
  // A field save must not flash every page's buttons into their busy state.
  return { store: { ...base, updateConfig, start,
    actionError: error ?? base.actionError,
    clearErrors,
  } satisfies AppStore, selectModel };
}
