import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import {
  applySettingsProfile, canDeleteSettingsProfile, captureProfile, defaultSettingsProfile, deleteSettingsProfile, emptyProfileLibrary, ensureProfileLibrary, materializeProfileApplication,
  changedSettings, defaultSettingsProfileEntry, MODEL_PROFILE_KEYS, profileMatches, profileTargetKey, setDefaultSettingsProfile, settingsEqual, settingsSnapshot, type SettingsProfile,
} from './settingsProfiles';

describe('settings profiles', () => {
  it('keeps an empty migration container and normalizes model identities independently of session identities', () => {
    expect(emptyProfileLibrary()).toEqual({ version: 1, revision: 0, entries: [], applied: {}, legacy_imported: false });
    expect(profileTargetKey('C:\\Models\\Example.gguf')).toBe('model:c:/models/example.gguf');
    expect(profileTargetKey('models/a.gguf', 'saved-session')).toBe('session:saved-session');
    expect(emptyProfileLibrary().entries).not.toBe(emptyProfileLibrary().entries);
  });

  it('initializes one independent Default profile using only runtime defaults', () => {
    const seeded = ensureProfileLibrary(emptyProfileLibrary());
    expect(seeded.entries).toEqual([defaultSettingsProfile()]);
    expect(seeded.default_profile_id).toBe(defaultSettingsProfile().id);
    expect(seeded.entries[0].settings.runtime_defaults).toContain('temperature');
    expect(seeded.entries[0].settings).not.toHaveProperty('active_model');
    expect(seeded.entries[0].settings).not.toHaveProperty('active_build');
    expect(seeded.entries[0].settings).not.toHaveProperty('gpu');
    expect(ensureProfileLibrary(seeded)).toBe(seeded);
    seeded.entries[0].settings.runtime_defaults!.push('synthetic');
    expect(defaultSettingsProfile().settings.runtime_defaults).not.toContain('synthetic');
  });

  it('protects only the designated default even when it has internal model copies', () => {
    const source = defaultSettingsProfile();
    const copy = { ...captureProfile(testConfig, 'Default', 'model', ''), source_id: source.id, source_scope: 'global' as const };
    const library = { ...emptyProfileLibrary(), entries: [source, copy] };
    expect(canDeleteSettingsProfile(library, source.id)).toBe(false);
    expect(() => deleteSettingsProfile(library, source.id)).toThrow('default profile cannot be deleted');
    expect(canDeleteSettingsProfile(library, copy.id)).toBe(true);
    expect(library.entries).toEqual([source, copy]);
    expect(canDeleteSettingsProfile(library, 'missing')).toBe(false);
  });

  it('reassigns affected model and session snapshots to the default when deleting an assigned source', () => {
    const source = defaultSettingsProfile();
    const copy = { ...captureProfile(testConfig, 'Default', 'model', ''), source_id: source.id, source_scope: 'global' as const };
    const other = captureProfile({ ...testConfig, temperature: 0.25 }, 'Keep', 'global', 'Default prompt');
    const application = materializeProfileApplication(testConfig, 'Applied prompt', copy);
    const session = materializeProfileApplication({ ...testConfig, active_model: 'other.gguf', mmproj: 'session-projector.gguf' }, 'Session prompt', source);
    const library = { ...emptyProfileLibrary(), default_profile_id: other.id, entries: [source, copy, other],
      applied: { current: application, 'session:saved': session, untouched: materializeProfileApplication(testConfig, 'Keep prompt', other) } };
    expect(canDeleteSettingsProfile(library, source.id)).toBe(true);
    expect(canDeleteSettingsProfile(library, copy.id)).toBe(true);
    const next = deleteSettingsProfile(library, source.id);
    expect(next.entries).toEqual([other]);
    expect(next.applied.current.profile_id).toBe(other.id);
    expect(next.applied.current).toMatchObject({ settings: { temperature: 0.25 }, system_prompt: 'Default prompt' });
    expect(next.applied['session:saved']).toMatchObject({ model: 'other.gguf', profile_id: other.id, system_prompt: 'Default prompt',
      settings: { temperature: 0.25, mmproj: 'session-projector.gguf' } });
    expect(next.applied.untouched).toEqual(library.applied.untouched);
    expect(library.applied.current).toEqual(application);
    expect(library.entries).toHaveLength(3);
    expect(canDeleteSettingsProfile(next, other.id)).toBe(false);
  });

  it('promotes a model profile in place when designated as default and detaches it from its source', () => {
    const source = { ...defaultSettingsProfile(), name: 'Chosen' };
    const copy = { ...captureProfile({ ...testConfig, ngl: 17, temperature: 0.2 }, 'Chosen', 'model', 'Chosen prompt'),
      source_id: source.id, source_scope: 'global' as const };
    const library = { ...emptyProfileLibrary(), entries: [source, copy], revision: 8 };
    const selected = setDefaultSettingsProfile(library, copy.id);
    const promoted = defaultSettingsProfileEntry(selected);
    expect(promoted).toMatchObject({ id: copy.id, name: copy.name, scope: 'global', legacy: true, coverage: [...MODEL_PROFILE_KEYS],
      settings: copy.settings, system_prompt: copy.system_prompt, revision: copy.revision + 1 });
    expect(promoted).not.toHaveProperty('model_key');
    expect(promoted).not.toHaveProperty('source_id');
    expect(promoted).not.toHaveProperty('source_scope');
    expect(selected.revision).toBe(8);
    expect(selected.entries.map(entry => entry.name)).toEqual(['Chosen', 'Chosen']);
    expect(applySettingsProfile({ ...testConfig, active_model: 'another.gguf' }, promoted)).toMatchObject({ ngl: 17, temperature: 0.2 });
    expect(deleteSettingsProfile(selected, source.id).entries).toEqual([promoted]);
    expect(library.entries[1]).toEqual(copy);
  });

  it('repairs missing default designations deterministically and preserves partial model coverage on promotion', () => {
    const model = { ...captureProfile(testConfig, 'Partial', 'model', ''), legacy: true, coverage: ['temperature'], settings: { temperature: 0.3 } };
    const portable = captureProfile(testConfig, 'Portable', 'global', '');
    expect(defaultSettingsProfileEntry({ ...emptyProfileLibrary(), entries: [model, portable] })).toEqual(portable);
    const onlyModel = ensureProfileLibrary({ ...emptyProfileLibrary(), entries: [model], default_profile_id: 'missing' });
    expect(defaultSettingsProfileEntry(onlyModel)).toMatchObject({ id: model.id, scope: 'global', coverage: ['temperature'], settings: model.settings });
    expect(ensureProfileLibrary(onlyModel)).toBe(onlyModel);
  });

  it('captures model settings with an independent identity and preserves the prompt exactly', () => {
    const cfg = { ...structuredClone(testConfig), chat_options: { stop: [' end ', '\n\n'] } };
    const profile = captureProfile(cfg, '  Writing  ', 'model', '  Keep line breaks.\n');
    expect(profile).toMatchObject({ name: 'Writing', scope: 'model', revision: 1, model_key: profileTargetKey(cfg.active_model), system_prompt: '  Keep line breaks.\n' });
    expect(profile.settings).not.toHaveProperty('active_model');
    expect(profile.settings).not.toHaveProperty('port');
    expect(profile.settings).not.toHaveProperty('models_dir');
    expect(profileMatches(profile, cfg, 'Keep line breaks.')).toBe(true);
    cfg.chat_options.stop.push('changed');
    expect(profile.settings.chat_options?.stop).toEqual([' end ', '\n\n']);
    expect(profileMatches(profile, cfg, 'Keep line breaks.')).toBe(false);
    expect(captureProfile(testConfig, 'Writing', 'model', '').id).not.toBe(profile.id);
  });

  it('keeps global profiles portable and leaves model-specific settings intact when applied', () => {
    const source = { ...testConfig, threads: 6, ctx_size: 8192, ngl: 99, spec_type: 'draft', spec_draft_model: 'draft.gguf',
      mmproj: 'vision.gguf', runtime_defaults: ['temperature', 'ngl', 'spec_draft_n_max'],
      server_args: ['--seed', '7'], gpu: { gpu_ids: ['runtime:vulkan:Vulkan0'], split_mode: 'none' as const, tensor_split: [] },
      lora_adapters: [{ path: 'adapter.gguf', scale: 0.5, enabled: true }],
    };
    const profile = captureProfile(source, 'Portable', 'global', 'Write clearly.');
    for (const field of ['active_backend', 'active_build', 'gpu', 'ngl', 'n_cpu_moe', 'spec_type', 'spec_draft_n_max', 'spec_draft_model', 'mmproj', 'lora_adapters', 'server_args']) {
      expect(profile.settings).not.toHaveProperty(field);
    }
    expect(profile.settings.runtime_defaults).toEqual(['temperature']);
    const target = { ...testConfig, active_model: 'second.gguf', mmproj: 'second-projector.gguf', runtime_defaults: ['ngl', 'ctx_size'] };
    const applied = applySettingsProfile(target, profile);
    expect(applied).toMatchObject({ active_model: target.active_model, active_backend: target.active_backend, active_build: target.active_build,
      ngl: target.ngl, mmproj: target.mmproj, threads: 6, ctx_size: 8192, server_args: target.server_args });
    expect(applied.runtime_defaults).toEqual(['ngl', 'temperature']);
    expect(profileMatches(profile, applied, 'Write clearly.')).toBe(true);
  });

  it('rejects applying another model profile and invalid names without changing configuration', () => {
    const profile = captureProfile(testConfig, 'Model', 'model', '');
    expect(() => applySettingsProfile({ ...testConfig, active_model: 'another.gguf' }, profile)).toThrow('different model');
    expect(profileMatches(profile, { ...testConfig, active_model: 'another.gguf' }, '')).toBe(false);
    expect(() => captureProfile(testConfig, ' ', 'global', '')).toThrow('name');
    expect(() => captureProfile({ ...testConfig, active_model: '' }, 'Named', 'model', '')).toThrow('Choose a model');
  });

  it('resets missing owned fields to defaults while legacy coverage only changes saved fields', () => {
    const partial: SettingsProfile = { id: 'partial', name: 'Partial', scope: 'global', revision: 1, settings: { temperature: 0.25 } };
    const target = { ...testConfig, ctx_size: 32000, top_k: 9, server_args: ['--seed', '5'], runtime_defaults: ['temperature', 'ngl'] };
    const replaced = applySettingsProfile(target, partial);
    expect(replaced.temperature).toBe(0.25);
    expect(replaced.runtime_defaults).toContain('top_k');
    expect(replaced.runtime_defaults).toContain('ctx_size');
    expect(replaced.runtime_defaults).not.toContain('temperature');
    expect(replaced.server_args).toEqual(['--seed', '5']);
    const legacy = applySettingsProfile(target, { ...partial, legacy: true, coverage: ['temperature'] });
    expect(legacy).toMatchObject({ temperature: 0.25, top_k: 9, ctx_size: 32000 });
    expect(legacy.runtime_defaults).toEqual(['ngl']);
    expect(profileMatches({ ...partial, legacy: true, coverage: ['temperature'] }, legacy, 'Unowned prompt')).toBe(true);
  });

  it('compares default markers, aliases, stop forms and object order without reordering meaningful arrays', () => {
    expect(settingsEqual(
      { temperature: 0.1, runtime_defaults: ['temperature', 'top_k', 'temperature'], chat_options: { stop: 'end', mirostat_lr: 0.3, seed: 5 } },
      { temperature: 1.5, runtime_defaults: ['top_k', 'temperature'], chat_options: { seed: 5, mirostat_eta: 0.3, stop: ['end'] } },
    )).toBe(true);
    expect(settingsEqual({ chat_options: { stop: [] } }, {})).toBe(true);
    expect(settingsEqual({ temperature: 0.8, runtime_defaults: ['temperature'] }, { temperature: 0.8 })).toBe(false);
    expect(settingsEqual({ chat_options: { stop: ['a', 'b'] } }, { chat_options: { stop: ['b', 'a'] } })).toBe(false);
    expect(settingsEqual({ server_args: ['--seed', '1'] }, { server_args: ['--seed', '2'] })).toBe(false);
  });

  it('keeps execution comparisons literal while saved snapshots exclude credentials and managed raw options', () => {
    const cfg = { ...testConfig, server_args: ['--api-key=synthetic-secret', '--host', '127.0.0.1', '--password', 'synthetic-password',
      '--lora-scaled', 'adapter.gguf', '0.5', '--seed', '-1', '--no-webui', '--custom-option=value'], api_key: 'synthetic-key' };
    expect(settingsSnapshot(cfg).server_args).toEqual(cfg.server_args);
    const profile = captureProfile(cfg, 'Safe snapshot', 'model', 'Prompt');
    const application = materializeProfileApplication(cfg, 'Prompt', profile);
    expect(application.settings.server_args).toEqual(['--seed', '-1', '--no-webui', '--custom-option=value']);
    expect(profile.settings.server_args).toEqual(application.settings.server_args);
    expect(application).toMatchObject({ model: cfg.active_model, profile_id: profile.id, profile_name: profile.name, profile_revision: 1, system_prompt: 'Prompt' });
    expect(application.settings).not.toHaveProperty('api_key');
    expect(cfg.server_args).toContain('--api-key=synthetic-secret');
    profile.settings.temperature = 0.1;
    expect(application.settings.temperature).toBe(testConfig.temperature);
  });
});

describe('settings a save would rewrite', () => {
  it('names each changed setting with the value it comes from and goes to', () => {
    const changes = changedSettings({ ctx_size: 4096, temperature: 0.8 }, { ctx_size: 8192, temperature: 0.8 });
    expect(changes).toEqual([{ key: 'ctx_size', before: 4096, after: 8192 }]);
  });

  it('reports nothing exactly when the save would be a no-op', () => {
    // The list and the "unchanged" verdict come from the same comparison, so a
    // save cannot claim changes it would not make, or hide ones it would.
    const left = { ctx_size: 4096, runtime_defaults: ['threads', 'parallel'] };
    const right = { ctx_size: 4096, runtime_defaults: ['parallel', 'threads'] };
    expect(settingsEqual(left, right)).toBe(true);
    expect(changedSettings(left, right)).toEqual([]);
  });

  it('shows a setting handed back to the runtime as losing its value', () => {
    const changes = changedSettings({ threads: 12 }, { threads: 12, runtime_defaults: ['threads'] });
    expect(changes.find(change => change.key === 'threads')).toMatchObject({ before: 12, after: undefined });
  });

  it('lists an added setting and a removed one alike', () => {
    const changes = changedSettings({ top_k: 40 }, { top_p: 0.9 });
    expect(changes.map(change => change.key).sort()).toEqual(['top_k', 'top_p']);
  });
});
