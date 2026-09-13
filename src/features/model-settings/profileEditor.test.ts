import { beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { captureProfile, defaultSettingsProfile, deleteSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey, type SettingsProfileLibrary } from '../../shared/config/settingsProfiles';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileLibraryConfigPatch, requestProfileFromApplication, type ProfileEditorResult } from './profileEditor';
import { emptyGpuPlacement, sessionConfig } from '../../shared/runtime/sessionUtils';

function fixture() {
  const profile = { ...captureProfile(testConfig, 'Shared', 'global', 'Original prompt'), id: 'shared' };
  const application = materializeProfileApplication({ ...testConfig, chat_options: { stop: [' end ', '\n'] } }, 'Original prompt', profile);
  const other = materializeProfileApplication({ ...testConfig, active_model: 'other.gguf', temperature: 0.3 }, 'Other prompt', profile);
  const library: SettingsProfileLibrary = { ...emptyProfileLibrary(), revision: 4, legacy_imported: true,
    entries: [profile, defaultSettingsProfile()], default_profile_id: defaultSettingsProfile().id, applied: {
    [profileTargetKey(testConfig.active_model)]: application, [profileTargetKey('other.gguf')]: other,
  } };
  const current = { ...testConfig, settings_profiles: library };
  const edit: ProfileEditorResult = { baseRevision: 4, library: structuredClone(library), application: structuredClone(application) };
  return { current, edit, application, other };
}

beforeEach(() => localStorage.clear());

describe('profile editor persistence', () => {
  it('reads a migrated library without writing browser storage or modifying config', () => {
    localStorage.setItem('aiolm-model-profiles', JSON.stringify({ version: 4, server: [], model: [{ id: 'old', name: 'Old', system_prompt: 'Saved prompt' }] }));
    const before = localStorage.getItem('aiolm-model-profiles');
    const library = profileLibrary(testConfig);
    expect(library.entries).toHaveLength(1);
    expect(library.legacy_imported).toBe(true);
    expect(localStorage.getItem('aiolm-model-profiles')).toBe(before);
    expect(testConfig).not.toHaveProperty('settings_profiles');
  });

  it('keeps applied values independent when a global profile is overwritten or renamed', () => {
    const { current, edit, application, other } = fixture();
    edit.library.entries[0] = { ...edit.library.entries[0], revision: 2, name: 'Renamed', system_prompt: 'Replacement prompt', settings: { temperature: 1.1 } };
    const next = mergeProfileEditor(current, edit);
    expect(next.revision).toBe(5);
    expect(next.applied[profileTargetKey(testConfig.active_model)]).toEqual({ ...application, profile_name: 'Renamed' });
    expect(next.applied[profileTargetKey('other.gguf')]).toEqual({ ...other, profile_name: 'Renamed' });
    expect(current.settings_profiles.entries[0]).toMatchObject({ revision: 1, name: 'Shared', system_prompt: 'Original prompt' });
  });

  it('rejects library edits that leave saved targets referencing a removed profile', () => {
    const { current, edit, application, other } = fixture();
    edit.library.entries = [defaultSettingsProfile()];
    expect(() => mergeProfileEditor(current, edit)).toThrow('Every model must reference an available profile');
    expect(current.settings_profiles.applied[profileTargetKey(testConfig.active_model)]).toEqual(application);
    expect(current.settings_profiles.applied[profileTargetKey('other.gguf')]).toEqual(other);
    expect(current.settings_profiles.entries).toHaveLength(2);
  });

  it('rejects saving an application whose selected profile was removed', () => {
    const { current, edit } = fixture();
    edit.library.entries = [defaultSettingsProfile()];
    expect(() => mergeProfileEditor(current, edit, 'default')).toThrow('Every model must reference an available profile');
  });

  it('commits a target snapshot and library changes together without changing another model', () => {
    const { current, edit, other } = fixture();
    edit.application.system_prompt = 'Edited prompt';
    edit.application.settings.chat_options = { stop: ['new stop'] };
    const next = mergeProfileEditor(current, edit, 'default');
    expect(next.applied[profileTargetKey(testConfig.active_model)]).toMatchObject({ system_prompt: 'Edited prompt', settings: { chat_options: { stop: ['new stop'] } } });
    expect(next.applied[profileTargetKey('other.gguf')]).toEqual(other);
    expect(next.entries[0].system_prompt).toBe('Original prompt');
    edit.application.system_prompt = 'Changed later';
    expect(next.applied[profileTargetKey(testConfig.active_model)].system_prompt).toBe('Edited prompt');
  });

  it.each(['default', 'work', undefined])('saves final normalized values into the selected global profile for target %s', sessionId => {
    const { current, edit, other } = fixture();
    const before = structuredClone(current);
    edit.saveMode = 'all';
    edit.library.entries[0].revision = 2;
    edit.application = { ...edit.application, profile_revision: 2, system_prompt: 'Final prompt',
      settings: { ...edit.application.settings, active_backend: 'vulkan', active_build: 'normalized-build', ngl: 9, mmproj: 'models/vision.gguf', runtime_defaults: [] } };
    const next = mergeProfileEditor(current, edit, sessionId);
    expect(next.entries[0]).toMatchObject({ id: 'shared', scope: 'global', revision: 2, system_prompt: 'Final prompt',
      settings: { active_backend: 'vulkan', active_build: 'normalized-build', ngl: 9, mmproj: 'models/vision.gguf' } });
    expect(next.entries[0].coverage).toContain('active_backend');
    expect(next.applied[profileTargetKey(other.model)]).toEqual(other);
    if (sessionId === undefined) expect(next.applied).toEqual(current.settings_profiles.applied);
    else expect(next.applied[profileTargetKey(testConfig.active_model, sessionId)]).toMatchObject({ profile_id: 'shared', profile_revision: 2, system_prompt: 'Final prompt' });
    expect(current).toEqual(before);
  });

  it('keeps benchmark-controlled values and prompt while saving final editable fields to a legacy profile', () => {
    const { current, edit } = fixture();
    current.settings_profiles.entries[0] = { ...current.settings_profiles.entries[0], legacy: true, coverage: ['temperature', 'threads'],
      settings: { temperature: 0.2, threads: 4, runtime_defaults: ['temperature'] } };
    edit.library = structuredClone(current.settings_profiles);
    edit.saveMode = 'benchmark';
    edit.application = { ...edit.application, system_prompt: 'Workload prompt', settings: { ...edit.application.settings,
      temperature: 1.5, threads: 7, ngl: 12, runtime_defaults: [] } };
    const next = mergeProfileEditor(current, edit);
    expect(next.entries[0]).toMatchObject({ id: 'shared', revision: 2, system_prompt: 'Original prompt',
      settings: { temperature: 0.2, threads: 7, ngl: 12, runtime_defaults: ['temperature'] } });
    expect(next.entries[0].coverage).toContain('ngl');
    expect(next.applied).toEqual(current.settings_profiles.applied);
  });

  it('rejects stale library edits before any target or source data is changed', () => {
    const { current, edit } = fixture();
    const before = structuredClone(current);
    edit.baseRevision = 3;
    expect(() => mergeProfileEditor(current, edit, 'default')).toThrow('Profiles changed elsewhere');
    expect(current).toEqual(before);
  });

  it('synchronizes deleted-profile replacements into the active model and every affected session', () => {
    const { current: original, application, other } = fixture();
    const fallback = { ...defaultSettingsProfile(), settings: { temperature: 0.55, threads: 9 }, system_prompt: 'Fallback prompt' };
    const sessions = [
      { id: 'first', name: 'First session', enabled: true, models: { primary_model: 'first.gguf', mmproj: 'first-projector.gguf', draft_model: '' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.2, threads: 2 }, model_profile_id: 'legacy-first' },
      { id: 'second', name: 'Second session', enabled: false, models: { primary_model: 'second.gguf', mmproj: '', draft_model: 'second-draft.gguf' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.3, threads: 3 }, model_profile_id: 'legacy-second' },
      { id: 'untouched', name: 'Keep session', enabled: true, models: { primary_model: 'keep.gguf', mmproj: '', draft_model: '' },
        gpu: emptyGpuPlacement(), execution: { temperature: 0.8, threads: 4 }, model_profile_id: 'legacy-keep' },
    ];
    const current = { ...original, port: 9090, sessions, settings_profiles: { ...original.settings_profiles,
      entries: [original.settings_profiles.entries[0], fallback], applied: { ...original.settings_profiles.applied } } };
    for (const definition of sessions) {
      const source = definition.id === 'untouched' ? fallback : current.settings_profiles.entries[0];
      current.settings_profiles.applied[profileTargetKey(definition.models.primary_model, definition.id)] = materializeProfileApplication(sessionConfig(current, definition), `${definition.id} prompt`, source);
    }
    const before = structuredClone(current);
    const edit = { baseRevision: current.settings_profiles.revision, library: deleteSettingsProfile(current.settings_profiles, 'shared'), application };
    const patch = profileLibraryConfigPatch(current, edit);
    expect(patch).toMatchObject({ temperature: 0.55, threads: 9 });
    expect(patch).not.toHaveProperty('port');
    expect(patch).not.toHaveProperty('active_model');
    expect(patch.settings_profiles!.applied[profileTargetKey(current.active_model)]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Fallback prompt' });
    expect(patch.settings_profiles!.applied[profileTargetKey(other.model)]).toMatchObject({ model: other.model, profile_id: fallback.id, settings: { temperature: 0.55 } });
    for (const [index, definition] of sessions.entries()) {
      const target = patch.sessions![index];
      if (definition.id === 'untouched') {
        expect(target).toEqual(definition);
        expect(patch.settings_profiles!.applied['session:untouched']).toEqual(current.settings_profiles.applied['session:untouched']);
      } else {
        expect(target).toMatchObject({ id: definition.id, name: definition.name, enabled: definition.enabled,
          models: definition.models, gpu: definition.gpu, execution: { temperature: 0.55, threads: 9 } });
        expect(target).not.toHaveProperty('model_profile_id');
        expect(patch.settings_profiles!.applied[`session:${definition.id}`]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Fallback prompt' });
      }
    }
    expect(current).toEqual(before);
    expect(() => profileLibraryConfigPatch(current, { ...edit, baseRevision: edit.baseRevision - 1 })).toThrow('Profiles changed elsewhere');
    expect(current).toEqual(before);
  });

  it('rejects an empty library before changing saved target snapshots', () => {
    const { current, edit } = fixture();
    edit.library.entries = [];
    const before = structuredClone(current);
    expect(() => mergeProfileEditor(current, edit)).toThrow('At least one profile');
    expect(current).toEqual(before);
  });

  it('resolves equivalent model paths and rejects a snapshot belonging to another named-session model', () => {
    const { current, application } = fixture();
    current.settings_profiles.applied[profileTargetKey('C:\\Models\\Example.gguf')] = { ...application, model: 'C:\\Models\\Example.gguf' };
    expect(appliedProfile({ ...current, active_model: 'c:/models/example.gguf' })?.system_prompt).toBe('Original prompt');
    current.settings_profiles.applied['session:work'] = { ...application, model: 'different.gguf' };
    expect(appliedProfile(current, 'work')).toBeUndefined();
  });

  it('derives request defaults from the application without consulting or mutating its source', () => {
    const { application } = fixture();
    const request = requestProfileFromApplication(application)!;
    expect(request).toMatchObject({ id: 'shared', system_prompt: 'Original prompt', stop_strings: [' end ', '\n'] });
    request.stop_strings.push('extra');
    request.chat_options.stop = [];
    expect(application.settings.chat_options?.stop).toEqual([' end ', '\n']);
    expect(requestProfileFromApplication(undefined)).toBeNull();
  });
});
