import type { AppConfig, SessionDefinition } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { executionChanges, executionConfig, settingsForSession } from '../../shared/config/executionSettings';
import { resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { profileTargetKey } from '../../shared/config/settingsProfiles';
import { sessionConfig } from '../../shared/runtime/sessionUtils';
import { mergeProfileEditor, profileLibrary } from './profileEditor';

/** Record the selected profile's current values before starting a session. */
export async function prepareSessionProfile(store: AppStore, definition: SessionDefinition): Promise<AppConfig> {
  const id = definition.id;
  const existingSession = id !== 'default' && (store.getConfig?.() ?? store.cfg)?.sessions?.some(item => item.id === id);
  const saved = await store.updateConfig(current => {
    const latestDefinition = current.sessions?.find(item => item.id === id);
    if (existingSession && !latestDefinition) throw new Error('The selected session was removed before loading.');
    const source = latestDefinition ?? definition;
    const target = sessionConfig(current, source);
    const library = profileLibrary(current);
    const resolved = resolveProfileForExecution(target, library, undefined, profileTargetKey(target.active_model, id));
    const next = executionConfig(target, resolved.application.settings);
    const settings_profiles = mergeProfileEditor(current, {
      baseRevision: library.revision, library: resolved.library, application: resolved.application,
    }, id);
    if (id === 'default') return { ...executionChanges(current, next), settings_profiles };
    const updated = settingsForSession(source, next);
    delete updated.model_profile_id;
    return { settings_profiles, sessions: [...(current.sessions ?? []).filter(item => item.id !== id), updated] };
  });
  return id === 'default' ? saved : sessionConfig(saved, saved.sessions!.find(item => item.id === id)!);
}
