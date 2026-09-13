import { describe, expect, it } from 'vitest';
import { captureProfile, defaultSettingsProfileEntry, emptyProfileLibrary, setDefaultSettingsProfile, type SettingsProfile } from '../../shared/config/settingsProfiles';
import { testConfig } from '../../testing/appStore';
import { applyProfile, profileForChoice, overwriteProfile, type ProfileChoice } from './profileWorkspaceState';

describe('profile workspace selection', () => {
  it('selects the latest global entry instead of an older generated copy', () => {
    const source = captureProfile({ ...testConfig, temperature: 1.1 }, 'Shared', 'global', 'Latest prompt');
    const copy = { ...captureProfile({ ...testConfig, temperature: 0.5 }, source.name, 'model', 'Older prompt'), source_id: source.id, source_scope: 'global' as const };
    const library = { ...emptyProfileLibrary(), entries: [source, copy] };
    const selected = profileForChoice(library, { ...source, revision: 0, settings: { temperature: 0.2 } });
    expect(selected).toBe(source);
    expect(applyProfile(testConfig, selected, false).temperature).toBe(1.1);
    expect(selected.system_prompt).toBe('Latest prompt');
    expect(library.entries).toEqual([source, copy]);
    expect(profileForChoice(library, copy)).toBe(copy);
  });

  it('creates a named preset entry once without creating a model copy', () => {
    const preset: ProfileChoice = { id: 'preset-thread-count', name: 'Threads', scope: 'preset', revision: 1, legacy: true,
      coverage: ['threads'], settings: { threads: 3, chat_options: { stop: ['finish'] } } };
    const library = emptyProfileLibrary();
    const selected = profileForChoice(library, preset);
    expect(selected).toMatchObject({ id: preset.id, scope: 'global', coverage: ['threads'] });
    expect(profileForChoice(library, preset)).toBe(selected);
    expect(library.entries).toHaveLength(1);
    selected.settings.chat_options!.stop = ['changed'];
    expect(preset.settings.chat_options!.stop).toEqual(['finish']);
    expect(selected).not.toHaveProperty('source_id');
  });

  it('uses the designated profile identity when another entry has the same name', () => {
    const source = captureProfile({ ...testConfig, temperature: 0.2 }, 'Shared', 'global', 'Original prompt');
    const chosen = { ...captureProfile({ ...testConfig, active_model: 'other.gguf', temperature: 0.7 }, 'Shared', 'model', 'Chosen prompt'),
      source_id: source.id, source_scope: 'global' as const };
    const library = setDefaultSettingsProfile({ ...emptyProfileLibrary(), entries: [source, chosen] }, chosen.id);
    const selected = profileForChoice(library, defaultSettingsProfileEntry(library));
    expect(selected.id).toBe(chosen.id);
    expect(applyProfile(testConfig, selected, false).temperature).toBe(0.7);
    expect(library.entries).toHaveLength(2);
    expect(source.settings.temperature).toBe(0.2);
  });

  it('saves a generated model entry independently without updating or removing its source', () => {
    const source = captureProfile(testConfig, 'Shared', 'global', 'Original prompt');
    const copy = { ...captureProfile(testConfig, source.name, 'model', 'Copy prompt'), source_id: source.id, source_scope: 'global' as const };
    const updated = overwriteProfile(copy, { ...testConfig, ngl: 17, temperature: 0.4 }, 'Edited prompt', false);
    expect(updated).toMatchObject({ id: copy.id, scope: 'model', model_key: copy.model_key, settings: { ngl: 17, temperature: 0.4 }, system_prompt: 'Edited prompt' });
    expect(updated).not.toHaveProperty('source_id');
    expect(updated).not.toHaveProperty('source_scope');
    expect(copy.source_id).toBe(source.id);
    expect(source.settings.temperature).toBe(testConfig.temperature);
    expect(source.system_prompt).toBe('Original prompt');
  });

  it('uses a selected model profile directly and rejects applying it to another model', () => {
    const profile = captureProfile(testConfig, 'Model settings', 'model', 'Prompt');
    const library = { ...emptyProfileLibrary(), entries: [profile] };
    expect(profileForChoice(library, profile)).toBe(profile);
    expect(() => applyProfile({ ...testConfig, active_model: 'other.gguf' }, profile, false)).toThrow('different model');
    expect(() => profileForChoice(emptyProfileLibrary(), profile)).toThrow('no longer available');
  });

  it('preserves partial profile coverage and unrelated model settings on selection', () => {
    const cfg = { ...testConfig, mmproj: 'models/vision-projector.gguf', temperature: 0.3, chat_options: { stop: ['keep'] }, threads: 12 };
    const profile: SettingsProfile = { id: 'legacy-partial', name: 'Saved partial settings', scope: 'global', revision: 1,
      legacy: true, coverage: ['ngl', 'ctx_size', 'threads', 'flash_attn'], settings: { ngl: 99, ctx_size: 8192, threads: 0, flash_attn: 'auto', active_backend: 'uncovered-runtime' } };
    const before = structuredClone(profile);
    const library = { ...emptyProfileLibrary(), entries: [profile] };
    const applied = applyProfile(cfg, profileForChoice(library, profile), false);
    expect(applied).toMatchObject({ ngl: 99, ctx_size: 8192, threads: 0, flash_attn: 'auto', active_backend: cfg.active_backend,
      temperature: 0.3, mmproj: cfg.mmproj, chat_options: { stop: ['keep'] } });
    expect(profile).toEqual(before);
    expect(library.entries).toHaveLength(1);
  });
});
