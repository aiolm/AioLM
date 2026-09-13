import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../shared/api/types';
import { applySettingsProfile, captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey, saveSettingsProfile, type SettingsProfile } from '../../shared/config/settingsProfiles';
import { testConfig } from '../../testing/appStore';
import { mergeProfileEditor, profileLibraryConfigPatch } from './profileEditor';
import { useProfileEditor } from './useProfileEditor';
import { profileDisplayName } from '../../shared/i18n/profileNames';

function editor(entries: SettingsProfile[] = [], benchmark = false, cfg: AppConfig = structuredClone(testConfig), active?: SettingsProfile) {
  const application = active ? materializeProfileApplication(cfg, 'Current prompt', active)
    : { model: cfg.active_model, settings: profileSettingsSnapshot(cfg), system_prompt: 'Current prompt' };
  const initial = { ...cfg, settings_profiles: { ...emptyProfileLibrary(), revision: 1, legacy_imported: true,
    entries: entries.length && !entries.some(entry => entry.scope === 'global') ? [...entries, defaultSettingsProfile()] : entries,
    applied: { [profileTargetKey(cfg.active_model)]: application } } };
  return renderHook(({ draft }) => useProfileEditor(initial, draft, application, benchmark), { initialProps: { draft: cfg } });
}

function accept(hook: ReturnType<typeof editor>, prepared: ReturnType<ReturnType<typeof useProfileEditor>['prepareApply']>) {
  const current = { ...prepared.config, settings_profiles: hook.result.current.library };
  const saved = { ...prepared.config, settings_profiles: mergeProfileEditor(current, prepared.edit, prepared.applyTarget ? 'default' : undefined) };
  const application = saved.settings_profiles.applied[profileTargetKey(saved.active_model)];
  act(() => { hook.result.current.acceptSaved(saved, application); });
  hook.rerender({ draft: saved });
  return saved;
}

describe('profile editor persistence', () => {
  it('keeps Default selected when choosing the first model without creating a recovery profile', () => {
    const blank = { ...testConfig, active_model: '' };
    const hook = renderHook(({ draft }) => useProfileEditor(blank, draft, undefined, false), { initialProps: { draft: blank } });
    expect(hook.result.current.selected.id).toBe('profile-default');
    let selected!: AppConfig;
    act(() => { selected = hook.result.current.resetModel(testConfig); });
    hook.rerender({ draft: selected });
    expect(hook.result.current.selected.id).toBe('profile-default');
    expect(hook.result.current.library.entries).toEqual([defaultSettingsProfile()]);
    const saved = hook.result.current.result();
    const named = saved.library.entries.find(entry => entry.id === saved.application.profile_id)!;
    expect(named).toMatchObject({ id: 'profile-default', name: 'Default', scope: 'global', settings: { active_backend: testConfig.active_backend, ngl: testConfig.ngl } });
    expect(saved.library.entries).toHaveLength(1);
    expect(saved.application.profile_name).toBe('Default');
  });

  it.each(['global', 'model'] as const)('loads the latest saved %s profile when selecting a model with an older application', scope => {
    const nextModel = { ...testConfig, active_model: 'models/next.gguf' };
    const current = captureProfile(testConfig, 'Current', 'model', 'Current prompt');
    const source = captureProfile(testConfig, 'Shared', 'global', 'Source prompt');
    const previous = scope === 'global' ? source : {
      ...captureProfile(nextModel, 'Model copy', 'model', 'Earlier prompt'), source_id: source.id, source_scope: 'global' as const,
    };
    const latestConfig: AppConfig = { ...nextModel, ctx_size: 16384, temperature: 0.25, ngl: 17,
      active_backend: 'vulkan', active_build: 'saved-build', runtime_defaults: [],
      gpu: { gpu_ids: ['gpu-test'], main_gpu: 'gpu-test', split_mode: 'none', tensor_split: [], draft_gpu_id: null },
      mmproj: 'models/projector.gguf', spec_draft_model: 'models/draft.gguf',
      lora_adapters: [{ path: 'models/adapter.gguf', scale: 0.5, enabled: true }] };
    const latest = saveSettingsProfile(previous, latestConfig, 'Latest saved prompt');
    const sibling = captureProfile(nextModel, 'Sibling', 'model', 'Sibling prompt');
    const entries = [current, ...(scope === 'model' ? [source] : []), latest, sibling];
    const currentApplication = materializeProfileApplication(testConfig, 'Current prompt', current);
    const staleApplication = materializeProfileApplication(nextModel, 'Earlier prompt', previous);
    const initial = { ...testConfig, settings_profiles: { ...emptyProfileLibrary(), revision: 2, legacy_imported: true,
      entries, applied: { [profileTargetKey(testConfig.active_model)]: currentApplication, [profileTargetKey(nextModel.active_model)]: staleApplication } } };
    const hook = renderHook(({ draft }) => useProfileEditor(initial, draft, currentApplication, false), { initialProps: { draft: testConfig } });
    const before = structuredClone(hook.result.current.library);
    let selected!: AppConfig;
    act(() => { selected = hook.result.current.resetModel(nextModel); });
    hook.rerender({ draft: selected });

    expect(hook.result.current.selected.id).toBe(previous.id);
    expect(hook.result.current.systemPrompt).toBe('Latest saved prompt');
    expect(selected).toMatchObject({ active_model: nextModel.active_model, ctx_size: 16384, temperature: 0.25, ngl: 17,
      active_backend: latestConfig.active_backend, active_build: latestConfig.active_build, gpu: latestConfig.gpu,
      mmproj: latestConfig.mmproj, spec_draft_model: latestConfig.spec_draft_model, lora_adapters: latestConfig.lora_adapters });
    expect(hook.result.current.savedApplication.profile_revision).toBe(latest.revision);
    expect(hook.result.current.library).toEqual(before);
    const edit = hook.result.current.result();
    expect(edit.application).toMatchObject({ profile_id: previous.id, system_prompt: 'Latest saved prompt', settings: { ctx_size: 16384, temperature: 0.25, ngl: 17 } });
    expect(edit.library.entries).toHaveLength(entries.length);
    expect(edit.library.entries.filter(entry => entry.id !== previous.id)).toEqual(before.entries.filter(entry => entry.id !== previous.id));
    expect(edit.library.applied).toEqual(before.applied);
  });

  it.each(['ko', 'ja', 'zh'] as const)('rejects duplicate localized Default names in %s', locale => {
    const source = defaultSettingsProfile();
    const other = captureProfile(testConfig, 'Other', 'global', '');
    const initial = { ...testConfig, settings_profiles: { ...emptyProfileLibrary(), entries: [source, other], legacy_imported: true } };
    const hook = renderHook(() => useProfileEditor(initial, initial, undefined, false, profile => profileDisplayName(profile, locale)));
    const name = profileDisplayName(source, locale);
    expect(() => hook.result.current.prepareSaveAs(name, 'global')).toThrow('already exists');
    expect(() => hook.result.current.prepareRename(other.id, name)).toThrow('already exists');
    expect(hook.result.current.library.entries).toEqual([source, other]);
  });

  it('keeps prepared application values separate until the saved result is accepted', () => {
    const profile = captureProfile({ ...testConfig, temperature: 0.2 }, 'Careful', 'model', 'Saved prompt');
    const hook = editor([profile]);
    const initialLibrary = structuredClone(hook.result.current.library);
    const prepared = hook.result.current.prepareApply(profile);

    expect(prepared.config.temperature).toBe(0.2);
    expect(prepared.edit.application).toMatchObject({ profile_id: profile.id, system_prompt: 'Saved prompt', settings: { temperature: 0.2 } });
    expect(hook.result.current.library).toEqual(initialLibrary);
    expect(hook.result.current.selected.id).toBeTruthy();
    expect(hook.result.current.selected.id).not.toBe(profile.id);
    expect(hook.result.current.systemPrompt).toBe('Current prompt');
    expect(hook.result.current.result().application.settings.temperature).toBe(testConfig.temperature);

    accept(hook, prepared);
    expect(hook.result.current.selected?.id).toBe(profile.id);
    expect(hook.result.current.systemPrompt).toBe('Saved prompt');
    expect(hook.result.current.result().application.settings.temperature).toBe(0.2);
    expect(hook.result.current.library.revision).toBe(2);
  });

  it('clears editing when all values return to the saved profile', () => {
    const profile = captureProfile(testConfig, 'Named settings', 'model', 'Current prompt');
    const hook = editor([profile], false, structuredClone(testConfig), profile);
    act(() => { });
    hook.rerender({ draft: { ...testConfig, temperature: 0.3 } });
    hook.rerender({ draft: structuredClone(testConfig) });

    expect(hook.result.current.working).toBe(false);
    expect(hook.result.current.selected?.id).toBe(profile.id);
    expect(hook.result.current.result().application.profile_id).toBe(profile.id);
    expect(hook.result.current.library.entries).toEqual([profile, defaultSettingsProfile()]);

    accept(hook, hook.result.current.prepareApply(profile));
    expect(hook.result.current.working).toBe(false);
    expect(hook.result.current.result().application.profile_id).toBe(profile.id);
  });

  it.each(['model', 'global'] as const)('saves Working profile as one new %s profile with the same application identity', scope => {
    const cfg = { ...testConfig, temperature: 0.4, ngl: 7 };
    const hook = editor([], false, cfg);
    const originalLibrary = structuredClone(hook.result.current.library);
    act(() => { hook.result.current.setSystemPrompt('Working prompt'); });
    const prepared = hook.result.current.prepareSaveAs('  New settings  ', scope);
    const source = prepared.edit.library.entries.find(profile => profile.scope === scope && profile.name === 'New settings')!;
    const applied = prepared.edit.library.entries.find(profile => profile.id === prepared.edit.application.profile_id)!;

    expect(source.name).toBe('New settings');
    expect(applied).toMatchObject({ id: source.id, scope, system_prompt: 'Working prompt' });
    expect(prepared.edit.library.entries).toHaveLength(originalLibrary.entries.length + 1);
    expect(prepared.edit.application).toMatchObject({ model: cfg.active_model, profile_name: 'New settings', settings: { temperature: 0.4, ngl: 7 }, system_prompt: 'Working prompt' });
    if (scope === 'global') {
      expect(source.settings.ngl).toBe(7);
      expect(applied).not.toHaveProperty('source_id');
      expect(applied).not.toHaveProperty('model_key');
    }
    expect(hook.result.current.library).toEqual(originalLibrary);
    expect(hook.result.current.working).toBe(true);

    accept(hook, prepared);
    expect(hook.result.current.selected?.id).toBe(applied.id);
    expect(hook.result.current.working).toBe(false);
  });

  it('updates an active profile with Working profile values only after persistence succeeds', () => {
    const profile = captureProfile(testConfig, 'Active', 'model', 'Current prompt');
    const hook = editor([profile], false, structuredClone(testConfig), profile);
    hook.rerender({ draft: { ...testConfig, temperature: 0.3 } });
    act(() => { });
    const prepared = hook.result.current.prepareUpdate(profile.id);

    expect(prepared.applyTarget).toBe(true);
    expect(prepared.edit.application).toMatchObject({ profile_id: profile.id, profile_revision: 2, settings: { temperature: 0.3 } });
    expect(hook.result.current.library.entries[0]).toEqual(profile);
    expect(hook.result.current.working).toBe(true);

    accept(hook, prepared);
    expect(hook.result.current.selected).toMatchObject({ id: profile.id, revision: 2, settings: { temperature: 0.3 } });
    expect(hook.result.current.working).toBe(false);
  });

  it('updates a different profile without changing the target application', () => {
    const active = captureProfile(testConfig, 'Active', 'model', 'Current prompt');
    const other = captureProfile({ ...testConfig, temperature: 0.2 }, 'Other', 'model', 'Other prompt');
    const hook = editor([active, other], false, { ...testConfig, temperature: 1.1 }, active);
    const prepared = hook.result.current.prepareUpdate(other.id);

    expect(prepared.applyTarget).toBe(false);
    expect(prepared.edit.library.entries[0]).toEqual(active);
    expect(prepared.edit.library.entries[1]).toMatchObject({ id: other.id, revision: 2, settings: { temperature: 1.1 }, system_prompt: 'Current prompt' });
    expect(hook.result.current.selected?.id).toBe(active.id);
    expect(hook.result.current.library.entries).toEqual([active, other, defaultSettingsProfile()]);
  });

  it('updates the selected global profile without creating a model copy', () => {
    const source = captureProfile(testConfig, 'Shared', 'global', 'Current prompt');
    const hook = editor([source]);
    accept(hook, hook.result.current.prepareApply(source));
    const activeId = hook.result.current.selected!.id;
    const activeRevision = hook.result.current.selected.revision;
    hook.rerender({ draft: { ...testConfig, temperature: 0.3 } });
    const prepared = hook.result.current.prepareUpdate(source.id);

    expect(prepared.applyTarget).toBe(true);
    expect(prepared.edit.application).toMatchObject({ profile_id: activeId, settings: { temperature: 0.3 } });
    expect(prepared.edit.library.entries.find(profile => profile.id === source.id)).toMatchObject({ revision: 2, settings: { temperature: 0.3 } });
    expect(prepared.edit.library.entries.find(profile => profile.id === activeId)).toMatchObject({ revision: activeRevision + 1, settings: { temperature: 0.3 } });
    expect(activeId).toBe(source.id);
    expect(prepared.edit.library.entries.filter(profile => profile.name === source.name)).toHaveLength(1);
  });

  it('saves every editable option and prompt into the selected global profile without changing another entry', () => {
    const source = captureProfile(testConfig, 'Selected global', 'global', 'Current prompt');
    const copy = { ...captureProfile(testConfig, source.name, 'model', 'Independent prompt'), source_id: source.id, source_scope: 'global' as const };
    const hook = editor([source, copy], false, structuredClone(testConfig), source);
    const cfg = { ...testConfig, temperature: 0.3, ngl: 17, active_backend: 'vulkan', active_build: 'saved-build',
      gpu: { gpu_ids: ['gpu-test'], main_gpu: 'gpu-test', split_mode: 'none' as const, tensor_split: [], draft_gpu_id: null },
      spec_draft_model: 'models/draft.gguf', mmproj: 'models/projector.gguf', lora_adapters: [{ path: 'models/adapter.gguf', scale: 0.5, enabled: true }], server_args: ['--jinja'] };
    hook.rerender({ draft: cfg });
    act(() => hook.result.current.setSystemPrompt('Saved instruction'));
    const edit = hook.result.current.result();
    const saved = edit.library.entries.find(entry => entry.id === source.id)!;
    expect(edit.saveMode).toBe('all');
    expect(edit.application).toMatchObject({ profile_id: source.id, profile_revision: saved.revision, system_prompt: 'Saved instruction' });
    expect(edit.library.entries).toHaveLength(2);
    expect(edit.library.entries[1]).toEqual(copy);
    expect(saved).toMatchObject({ id: source.id, scope: 'global', system_prompt: 'Saved instruction',
      settings: { ngl: 17, active_backend: cfg.active_backend, active_build: cfg.active_build, gpu: cfg.gpu,
        spec_draft_model: cfg.spec_draft_model, mmproj: cfg.mmproj, lora_adapters: cfg.lora_adapters, server_args: cfg.server_args } });
    expect(applySettingsProfile({ ...testConfig, active_model: 'other.gguf' }, saved)).toMatchObject({ active_model: 'other.gguf',
      temperature: 0.3, ngl: 17, active_backend: cfg.active_backend, gpu: cfg.gpu, mmproj: cfg.mmproj, lora_adapters: cfg.lora_adapters });
    expect(hook.result.current.library.entries).toEqual([source, copy]);
  });

  it('saves the explicitly selected generated entry without writing through to its source', () => {
    const source = captureProfile(testConfig, 'Shared', 'global', 'Source prompt');
    const copy = { ...captureProfile(testConfig, source.name, 'model', 'Current prompt'), source_id: source.id, source_scope: 'global' as const };
    const hook = editor([source, copy], false, structuredClone(testConfig), copy);
    hook.rerender({ draft: { ...testConfig, temperature: 0.25, ngl: 8 } });
    const edit = hook.result.current.result();
    expect(edit.application.profile_id).toBe(copy.id);
    expect(edit.library.entries[0]).toEqual(source);
    expect(edit.library.entries[1]).toMatchObject({ id: copy.id, settings: { temperature: 0.25, ngl: 8 } });
    expect(edit.library.entries[1]).not.toHaveProperty('source_id');
  });

  it('renames a profile without overwriting its saved settings with the current editor values', () => {
    const profile = captureProfile({ ...testConfig, temperature: 0.2 }, 'Original', 'model', 'Saved prompt');
    const hook = editor([profile], false, { ...testConfig, temperature: 1.2 }, profile);
    const prepared = hook.result.current.prepareRename(profile.id, 'Renamed');

    expect(prepared.applyTarget).toBe(false);
    expect(prepared.edit.library.entries[0]).toEqual({ ...profile, name: 'Renamed', revision: 2 });
    expect(hook.result.current.library.entries[0]).toEqual(profile);
  });

  it('rejects a global rename that would collide in another model with a linked copy', () => {
    const source = captureProfile(testConfig, 'Original', 'global', 'Shared prompt');
    const currentCopy = { ...captureProfile(testConfig, source.name, 'model', 'Current prompt'), source_id: source.id, source_scope: 'global' as const };
    const otherConfig = { ...testConfig, active_model: 'other.gguf' };
    const otherCopy = { ...captureProfile(otherConfig, source.name, 'model', 'Other prompt'), source_id: source.id, source_scope: 'global' as const };
    const existing = captureProfile(otherConfig, 'Occupied', 'model', 'Separate prompt');
    const entries = [source, currentCopy, otherCopy, existing];
    const hook = editor(entries, false, structuredClone(testConfig), currentCopy);

    expect(() => hook.result.current.prepareRename(source.id, '  Occupied  ')).toThrow('already exists');
    expect(hook.result.current.library.entries).toEqual(entries);
    expect(hook.result.current.selected?.name).toBe('Original');
  });

  it('renames linked copies only in their original name while allowing matching names in unaffected models', () => {
    const source = captureProfile(testConfig, 'Original', 'global', 'Shared prompt');
    const currentCopy = { ...captureProfile(testConfig, source.name, 'model', 'Current prompt'), source_id: source.id, source_scope: 'global' as const };
    const otherConfig = { ...testConfig, active_model: 'other.gguf' };
    const renamedCopy = { ...captureProfile(otherConfig, 'Local name', 'model', 'Other prompt'), source_id: source.id, source_scope: 'global' as const };
    const existing = captureProfile(otherConfig, 'Renamed', 'model', 'Separate prompt');
    const hook = editor([source, currentCopy, renamedCopy, existing], false, structuredClone(testConfig), currentCopy);
    const prepared = hook.result.current.prepareRename(source.id, 'Renamed');

    expect(prepared.edit.library.entries).toEqual([
      { ...source, name: 'Renamed', revision: 2 }, { ...currentCopy, name: 'Renamed', revision: 2 }, renamedCopy, existing,
    ]);
  });

  it('deletes the selected profile and switches its saved target to the designated default', () => {
    const profile = captureProfile(testConfig, 'Disposable name', 'model', 'Current prompt');
    const remaining = { ...defaultSettingsProfile(), settings: { temperature: 0.55 }, system_prompt: 'Fallback prompt' };
    const hook = editor([profile, remaining], false, structuredClone(testConfig), profile);
    const originalSettings = structuredClone(hook.result.current.savedApplication!.settings);
    const prepared = hook.result.current.prepareDelete(profile.id);
    expect(prepared.applyTarget).toBe(false);
    expect(prepared.edit.library.entries).toEqual([remaining]);
    expect(prepared.edit.library.applied[profileTargetKey(testConfig.active_model)]).toMatchObject({ profile_id: remaining.id,
      system_prompt: 'Fallback prompt', settings: { temperature: 0.55 } });
    expect(hook.result.current.library.entries).toEqual([profile, remaining]);
    expect(hook.result.current.savedApplication).toMatchObject({ settings: originalSettings, system_prompt: 'Current prompt' });
    expect(hook.result.current.savedApplication.profile_id).toBe(profile.id);
    accept(hook, prepared);
    expect(hook.result.current.selected.id).toBe(remaining.id);
    expect(hook.result.current.systemPrompt).toBe('Fallback prompt');
    expect(() => hook.result.current.prepareDelete(remaining.id)).toThrow('default profile cannot be deleted');
  });

  it('changes the default designation without saving Working profile values or changing the target assignment', () => {
    const active = captureProfile(testConfig, 'Same name', 'model', 'Current prompt');
    const fallback = { ...defaultSettingsProfile(), name: active.name };
    const hook = editor([active, fallback], false, structuredClone(testConfig), active);
    hook.rerender({ draft: { ...testConfig, temperature: 1.6 } });
    act(() => { hook.result.current.setSystemPrompt('Unsaved prompt'); });
    const prepared = hook.result.current.prepareSetDefault(active.id);
    const current = { ...testConfig, settings_profiles: hook.result.current.library };
    const before = structuredClone(current);
    const patch = profileLibraryConfigPatch(current, prepared.edit);
    expect(prepared.applyTarget).toBe(false);
    expect(patch).not.toHaveProperty('temperature');
    expect(patch.settings_profiles).toMatchObject({ default_profile_id: active.id });
    expect(patch.settings_profiles!.entries.find(entry => entry.id === active.id)).toMatchObject({ name: active.name, scope: 'global',
      settings: { temperature: testConfig.temperature }, system_prompt: 'Current prompt' });
    expect(patch.settings_profiles!.applied[profileTargetKey(testConfig.active_model)]).toMatchObject({ profile_id: active.id,
      settings: { temperature: testConfig.temperature }, system_prompt: 'Current prompt' });
    expect(hook.result.current.working).toBe(true);
    expect(current).toEqual(before);
    const saved = { ...current, ...patch };
    const application = saved.settings_profiles!.applied[profileTargetKey(testConfig.active_model)];
    act(() => hook.result.current.acceptMetadata(saved, application));
    expect(hook.result.current.library.default_profile_id).toBe(active.id);
    expect(hook.result.current.working).toBe(true);
    expect(hook.result.current.systemPrompt).toBe('Unsaved prompt');
    expect(hook.result.current.result().application).toMatchObject({ settings: { temperature: 1.6 }, system_prompt: 'Unsaved prompt' });
  });

  it('selects the designated default values for an unseen model instead of the current portable profile', () => {
    const active = captureProfile({ ...testConfig, temperature: 1.1 }, 'Current portable', 'global', 'Current prompt');
    const fallback = { ...defaultSettingsProfile(), settings: { temperature: 0.35 }, system_prompt: 'Fallback prompt' };
    const hook = editor([active, fallback], false, structuredClone(testConfig), active);
    let selected!: AppConfig;
    act(() => { selected = hook.result.current.resetModel({ ...testConfig, active_model: 'new.gguf' }); });
    hook.rerender({ draft: selected });
    expect(selected).toMatchObject({ active_model: 'new.gguf', temperature: 0.35 });
    expect(hook.result.current.selected.id).toBe(fallback.id);
    expect(hook.result.current.systemPrompt).toBe('Fallback prompt');
  });
});

describe('profile editor scope', () => {
  it('preserves controlled settings and the original prompt when a benchmark updates a profile', () => {
    const profile = captureProfile({ ...testConfig, ctx_size: 16384, temperature: 0.2, threads: 8,
      chat_options: { stop: ['original stop'] }, runtime_defaults: ['temperature', 'threads'] }, 'Reusable', 'global', 'Original prompt');
    const hook = editor([profile], true);
    const selected = hook.result.current.prepareApply(profile).config;
    hook.rerender({ draft: { ...selected, threads: 4, runtime_defaults: [] } });
    const updated = hook.result.current.prepareUpdate(profile.id).edit.library.entries[0];

    expect(updated).toMatchObject({ id: profile.id, scope: 'global', revision: 2, system_prompt: 'Original prompt',
      settings: { ctx_size: 16384, temperature: 0.2, chat_options: { stop: ['original stop'] }, threads: 4, runtime_defaults: ['temperature'] } });
    expect(profile.settings.threads).toBe(8);
    expect(updated.coverage).toContain('ngl');
    expect(hook.result.current.systemPrompt).toBe('Current prompt');
  });

  it('expands a legacy global profile on explicit save and preserves its identity and scope', () => {
    const profile: SettingsProfile = { id: 'legacy', name: 'Partial', scope: 'global', revision: 1, legacy: true,
      coverage: ['ngl', 'temperature'], settings: { ngl: 2, temperature: 0.4, active_backend: 'incomplete-runtime' } };
    const hook = editor([profile], false, { ...testConfig, ngl: 6, temperature: 0.7, runtime_defaults: ['ngl'] });
    act(() => { hook.result.current.setSystemPrompt('Unrelated prompt'); });
    const updated = hook.result.current.prepareUpdate(profile.id).edit.library.entries[0];

    expect(updated).toMatchObject({ id: profile.id, scope: 'global', revision: 2,
      settings: { ngl: 6, temperature: 0.7, active_backend: testConfig.active_backend, runtime_defaults: ['ngl'] } });
    expect(updated.coverage).toEqual(expect.arrayContaining(['ngl', 'active_backend', 'active_build', 'gpu', 'chat_options']));
    expect(updated).not.toHaveProperty('model_key');
    expect(updated.system_prompt).toBe('Unrelated prompt');
  });

  it('captures the complete edited model settings when saving a partial profile', () => {
    const profile: SettingsProfile = { id: 'legacy-prompt', name: 'Prompt', scope: 'model', model_key: 'model:model.gguf', revision: 1,
      legacy: true, coverage: ['temperature'], settings: { temperature: 0.4 }, system_prompt: 'Original' };
    const hook = editor([profile]);
    act(() => { hook.result.current.setSystemPrompt('Updated'); });
    const updated = hook.result.current.prepareUpdate(profile.id).edit.library.entries[0];

    expect(updated).toMatchObject({ id: profile.id, revision: 2, system_prompt: 'Updated', settings: { temperature: testConfig.temperature, ngl: testConfig.ngl, runtime_defaults: [] } });
    expect(updated).not.toHaveProperty('legacy');
    expect(updated).not.toHaveProperty('coverage');
  });

  it('creates a partial benchmark profile that leaves request and measurement settings untouched on reuse', () => {
    const hook = editor([], true, { ...testConfig, ctx_size: 32768, temperature: 0.1, threads: 4, runtime_defaults: ['temperature', 'threads'] });
    const prepared = hook.result.current.prepareSaveAs('Benchmark tuning', 'global');
    const created = prepared.edit.library.entries.find(profile => profile.id !== 'profile-default' && profile.scope === 'global')!;

    expect(created).toMatchObject({ scope: 'global', legacy: true, settings: { threads: 4, runtime_defaults: ['threads'] } });
    for (const field of ['ctx_size', 'temperature', 'chat_options', 'parallel']) {
      expect(created.settings).not.toHaveProperty(field);
      expect(created.coverage).not.toContain(field);
    }
    expect(created).not.toHaveProperty('system_prompt');
    const restored = applySettingsProfile({ ...testConfig, ctx_size: 8192, temperature: 0.6, chat_options: { stop: ['keep'] } }, created);
    expect(restored).toMatchObject({ ctx_size: 8192, temperature: 0.6, chat_options: { stop: ['keep'] }, threads: 4 });
    expect(restored.runtime_defaults).toEqual(['threads']);
  });

  it('preserves legacy coverage on benchmark selection and captures editable runtime fields on save', () => {
    const profile: SettingsProfile = { id: 'legacy-runtime', name: 'Partial runtime', scope: 'global', revision: 1, legacy: true,
      coverage: ['threads'], settings: { active_backend: 'incomplete-runtime', threads: 3 } };
    const hook = editor([profile], true);
    const selected = hook.result.current.prepareApply(profile).config;
    expect(selected).toMatchObject({ active_backend: testConfig.active_backend, active_build: testConfig.active_build, threads: 3 });
    expect(hook.result.current.library.entries[0]).toEqual(profile);
    hook.rerender({ draft: { ...selected, threads: 7 } });
    const updated = hook.result.current.prepareUpdate(profile.id).edit.library.entries[0];

    expect(updated).toMatchObject({ id: profile.id, scope: profile.scope, revision: 2, settings: { active_backend: testConfig.active_backend, threads: 7, runtime_defaults: [] } });
    expect(updated.coverage).toContain('active_backend');
    expect(updated.coverage).not.toContain('temperature');
    expect(updated).not.toHaveProperty('system_prompt');
  });
});
