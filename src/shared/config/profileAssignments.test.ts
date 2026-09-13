import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { emptyGpuPlacement } from '../runtime/sessionUtils';
import { ensureProfileAssignments, resolveProfileApplication, resolveProfileApplicationOrDefault, resolveProfileForExecution } from './profileAssignments';
import {
  captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication,
  profileSettingsSnapshot, profileTargetKey,
} from './settingsProfiles';

describe('required profile assignments', () => {
  it('uses current saved values for a new execution while retaining the previous live snapshot', () => {
    const profile = captureProfile(testConfig, 'Shared', 'model', 'Before');
    const previous = materializeProfileApplication(testConfig, 'Before', profile);
    const updated = { ...profile, revision: 2, settings: { ...profile.settings, active_backend: 'cpu', ngl: 5, temperature: 0.35 }, system_prompt: 'After' };
    const library = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), updated], applied: { [profileTargetKey(testConfig.active_model)]: previous } };
    const resolved = resolveProfileForExecution(testConfig, library);
    expect(resolved.application).toMatchObject({ profile_id: profile.id, profile_revision: 2, system_prompt: 'After', settings: { active_backend: 'cpu', ngl: 5, temperature: 0.35 } });
    expect(library.applied[profileTargetKey(testConfig.active_model)]).toEqual(previous);
    expect(resolveProfileApplication(testConfig, library, previous).application).toEqual(previous);
  });

  it('uses the selected global identity rather than an older generated model profile', () => {
    const profile = captureProfile({ ...testConfig, temperature: 0.25 }, 'Shared', 'global', 'Current');
    const copy = { ...captureProfile({ ...testConfig, temperature: 1.4 }, 'Shared', 'model', 'Old copy'), source_id: profile.id, source_scope: 'global' as const };
    const library = { ...emptyProfileLibrary(), entries: [profile, copy] };
    const reference = materializeProfileApplication(testConfig, 'Stale snapshot', profile);
    const resolved = resolveProfileForExecution({ ...testConfig, active_model: 'other.gguf' }, library, reference);
    expect(resolved.application).toMatchObject({ model: 'other.gguf', profile_id: profile.id, system_prompt: 'Current', settings: { temperature: 0.25 } });
    expect(library.entries).toHaveLength(2);
    expect(copy.settings.temperature).toBe(1.4);
  });

  it('uses the default for a missing or incompatible profile before executing another model', () => {
    const fallback = captureProfile({ ...testConfig, temperature: 0.65 }, 'Default choice', 'global', 'Fallback');
    const local = captureProfile(testConfig, 'Local', 'model', 'Local');
    const library = { ...emptyProfileLibrary(), default_profile_id: fallback.id, entries: [fallback, local] };
    for (const profile_id of [local.id, 'deleted']) {
      const reference = { ...materializeProfileApplication(testConfig, 'Previous', local), profile_id };
      expect(resolveProfileForExecution({ ...testConfig, active_model: 'other.gguf' }, library, reference).application)
        .toMatchObject({ model: 'other.gguf', profile_id: fallback.id, system_prompt: 'Fallback', settings: { temperature: 0.65 } });
    }
  });

  it('assigns the only Default before model selection and removes the empty target after selection', () => {
    const blank = { ...testConfig, active_model: '' };
    const library = ensureProfileAssignments(blank, emptyProfileLibrary());
    expect(library.entries).toEqual([defaultSettingsProfile()]);
    expect(library.applied['model:'].profile_id).toBe('profile-default');
    const selected = ensureProfileAssignments(testConfig, library);
    expect(selected.applied).not.toHaveProperty('model:');
    expect(selected.applied[profileTargetKey(testConfig.active_model)].profile_id).toBeTruthy();
    expect(ensureProfileAssignments(testConfig, selected)).toEqual(selected);
  });

  it('keeps compatible named assignments and their saved revisions even when a profile changes', () => {
    const original = captureProfile(testConfig, 'Saved', 'global', 'Prompt');
    const application = materializeProfileApplication(testConfig, 'Prompt', original);
    const library = { ...emptyProfileLibrary(), entries: [{ ...original, revision: 2, settings: { temperature: 1.2 } }] };
    const resolved = resolveProfileApplication(testConfig, library, application);
    expect(resolved.application).toEqual(application);
    expect(resolved.profile.revision).toBe(2);
    expect(library.entries).toHaveLength(1);
  });

  it.each([undefined, 0, -1, 1.5, 999, Number.NaN, Number.POSITIVE_INFINITY])('repairs an invalid applied revision %s without changing its saved values', revision => {
    const original = captureProfile(testConfig, 'Saved', 'global', 'Prompt');
    const application = { ...materializeProfileApplication(testConfig, 'Prompt', original), profile_revision: revision };
    const library = { ...emptyProfileLibrary(), entries: [{ ...original, revision: 2, settings: { temperature: 1.2 } }] };
    const resolved = resolveProfileApplication(testConfig, library, application);
    expect(resolved.application).toEqual({ ...application, profile_revision: 2 });
    expect(resolved.application.settings.temperature).toBe(testConfig.temperature);
    expect(resolved.profile.settings.temperature).toBe(1.2);
    expect(library.entries).toHaveLength(1);
  });

  it('matches an existing profile for an anonymous snapshot without creating another entry', () => {
    const profile = captureProfile(testConfig, 'Saved', 'global', 'Prompt');
    const library = { ...emptyProfileLibrary(), entries: [profile] };
    const saved = { model: testConfig.active_model, settings: profileSettingsSnapshot(testConfig), system_prompt: 'Prompt' };
    const resolved = resolveProfileApplication(testConfig, library, saved);
    expect(resolved.library.entries).toEqual([profile]);
    expect(resolved.application).toEqual({ ...saved, profile_id: profile.id, profile_name: profile.name, profile_revision: 1 });
    expect(saved).not.toHaveProperty('profile_id');
  });

  it('recovers missing identities without copying the current model paths into inactive snapshots', () => {
    const current = { ...testConfig, mmproj: 'current-projector.gguf', server_args: ['--seed', '9'], temperature: 1.7 };
    const saved = { model: 'other.gguf', profile_id: 'deleted', settings: { temperature: 0.2 }, system_prompt: '  Saved\nprompt ' };
    const library = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile()], legacy_imported: true,
      applied: { [profileTargetKey(saved.model)]: saved } };
    const before = structuredClone(library);
    const repaired = ensureProfileAssignments(current, library);
    const application = repaired.applied[profileTargetKey(saved.model)];
    const recovered = repaired.entries.find(entry => entry.id === application.profile_id)!;
    expect(application).toMatchObject({ settings: saved.settings, system_prompt: saved.system_prompt });
    expect(recovered).toMatchObject({ scope: 'model', model_key: profileTargetKey(saved.model), system_prompt: saved.system_prompt,
      settings: { temperature: 0.2, mmproj: '', server_args: [], spec_draft_model: '' } });
    expect(recovered.legacy).toBeUndefined();
    expect(recovered.settings.runtime_defaults).not.toContain('temperature');
    expect(ensureProfileAssignments(current, library)).toEqual(repaired);
    expect(ensureProfileAssignments(current, repaired)).toEqual(repaired);
    expect(library).toEqual(before);
  });

  it('gives distinct saved sessions identities while retaining their model binding and prompt', () => {
    const cfg = { ...testConfig, sessions: [{ id: 'saved', name: 'Saved', enabled: false,
      models: { primary_model: 'session.gguf', mmproj: 'session-projector.gguf', draft_model: '' },
      gpu: emptyGpuPlacement(), execution: { temperature: 0.15 } }] };
    const library = ensureProfileAssignments(cfg, emptyProfileLibrary());
    const application = library.applied['session:saved'];
    expect(application).toMatchObject({ model: 'session.gguf', profile_id: expect.any(String), settings: { temperature: 0.15, mmproj: 'session-projector.gguf' } });
    expect(library.entries.find(entry => entry.id === application.profile_id)).toMatchObject({ model_key: profileTargetKey('session.gguf') });
    const moved = { ...cfg, sessions: [{ ...cfg.sessions[0], models: { ...cfg.sessions[0].models, primary_model: 'another.gguf' }, execution: { temperature: 0.6 } }] };
    const reassigned = ensureProfileAssignments(moved, library);
    expect(reassigned.applied['session:saved']).toMatchObject({ model: 'another.gguf', settings: { temperature: 0.6 } });
    expect(reassigned.entries.find(entry => entry.id === reassigned.applied['session:saved'].profile_id)).toMatchObject({ model_key: profileTargetKey('another.gguf') });
  });
  it('applies the configured default for an explicit deleted reference while recovering anonymous legacy values', () => {
    const profile = captureProfile({ ...testConfig, temperature: 0.45 }, 'Fallback', 'global', 'Fallback prompt');
    const library = { ...emptyProfileLibrary(), entries: [profile], default_profile_id: profile.id };
    const saved = { model: testConfig.active_model, profile_id: 'deleted', settings: { temperature: 0.12 }, system_prompt: 'Old prompt' };
    const fallback = resolveProfileApplicationOrDefault(testConfig, library, saved);
    expect(fallback.application).toMatchObject({ profile_id: profile.id, system_prompt: 'Fallback prompt', settings: { temperature: 0.45 } });
    expect(fallback.library.entries).toHaveLength(1);
    const recovered = resolveProfileApplicationOrDefault(testConfig, library, { ...saved, profile_id: undefined });
    expect(recovered.application).toMatchObject({ system_prompt: 'Old prompt', settings: { temperature: 0.12 } });
    expect(recovered.application.profile_id).not.toBe(profile.id);
  });
});
