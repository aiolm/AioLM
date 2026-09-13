import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestStore } from '../../testing/appStore';
import { useExecutionStore } from './useExecutionStore';
import { restoreExecution } from './modelExecutionState';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import { emptyGpuPlacement } from '../../shared/runtime/sessionUtils';

describe('execution store', () => {
  beforeEach(() => localStorage.clear());
  it('keeps unrelated controls available during saves while start waits for persistence', async () => {
    const base = createTestStore();
    const save = base.updateConfig;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    base.updateConfig = vi.fn(async patch => { await gate; return save(patch); });
    const busyStates: boolean[] = [];
    const hook = renderHook(() => {
      const execution = useExecutionStore(base);
      busyStates.push(execution.store.busy);
      return execution;
    });
    let pending!: Promise<unknown>;
    let start!: Promise<unknown>;
    await act(async () => {
      pending = hook.result.current.store.updateConfig({ ctx_size: 8192 });
      start = hook.result.current.store.start();
    });
    expect(base.start).not.toHaveBeenCalled();
    expect(hook.result.current.store.busy).toBe(false);
    await act(async () => { finish(); await pending; await start; });
    expect(base.cfg?.ctx_size).toBe(8192);
    expect(base.start).toHaveBeenCalledOnce();
    expect(busyStates.every(busy => !busy)).toBe(true);
    base.busy = true;
    hook.rerender();
    expect(hook.result.current.store.busy).toBe(true);
  });
  it('restores a model after edits, switching and remounting', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ ctx_size: 8192, temperature: 0.3 }); });
    await act(async () => { await hook.result.current.selectModel('b.gguf'); });
    await act(async () => { await hook.result.current.store.updateConfig({ ctx_size: 2048, temperature: 1.2 }); });
    hook.unmount();
    const reopened = renderHook(() => useExecutionStore(base));
    await act(async () => { await reopened.result.current.selectModel('a.gguf'); });
    expect(base.cfg).toMatchObject({ active_model: 'a.gguf', ctx_size: 8192, temperature: 0.3 });
    expect(restoreExecution(base.cfg!, 'b.gguf')).toMatchObject({ ctx_size: 2048, temperature: 1.2 });
  });
  it('keeps the old selection on save failure and allows retry', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const save = base.updateConfig;
    base.updateConfig = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(save);
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await expect(hook.result.current.selectModel('b.gguf')).rejects.toThrow('disk full'); });
    expect(base.cfg?.active_model).toBe('a.gguf');
    await act(async () => { await hook.result.current.store.start(); });
    expect(base.start).toHaveBeenCalledOnce();
    await act(async () => { await hook.result.current.selectModel('b.gguf'); });
    expect(base.cfg?.active_model).toBe('b.gguf');
  });

  it('starts the persisted selected profile after a failed override save instead of launching the failed draft', async () => {
    const base = createTestStore({ active_model: 'saved.gguf', temperature: 0.4, ngl: 8 });
    const profile = captureProfile(base.cfg!, 'Saved profile', 'model', 'Saved prompt');
    base.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile(), profile], legacy_imported: true,
      applied: { [profileTargetKey(base.cfg!.active_model)]: materializeProfileApplication(base.cfg!, 'Saved prompt', profile) } };
    const save = base.updateConfig;
    base.updateConfig = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(save);
    const hook = renderHook(() => useExecutionStore(base));
    const failed = { ...base.cfg!, active_model: 'unsaved.gguf', temperature: 1.2, ngl: 99 };
    await act(async () => { await expect(hook.result.current.store.updateConfig(failed)).rejects.toThrow('disk full'); });
    await act(async () => { await hook.result.current.store.start(failed); });
    expect(base.start).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'saved.gguf', temperature: 0.4, ngl: 8 }), false);
    expect(base.cfg!.settings_profiles!.entries.find(entry => entry.id === profile.id)).toEqual(profile);
  });

  it('refreshes a stale target from its latest profile before starting without changing another saved target', async () => {
    const base = createTestStore({ active_model: 'saved.gguf', temperature: 0.2 });
    const profile = { ...captureProfile(base.cfg!, 'Shared profile', 'global', 'Original'), revision: 2,
      settings: { temperature: 0.6 }, system_prompt: 'Latest prompt' };
    const original = { ...materializeProfileApplication(base.cfg!, 'Original', profile), profile_revision: 1 };
    const other = { ...original, model: 'other.gguf' };
    base.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [profile], legacy_imported: true,
      applied: { [profileTargetKey(base.cfg!.active_model)]: original, [profileTargetKey(other.model)]: other } };
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.start(); });
    expect(base.start).toHaveBeenCalledWith(expect.objectContaining({ active_model: 'saved.gguf', temperature: 0.6 }), false);
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('saved.gguf')]).toMatchObject({ profile_id: profile.id, profile_revision: 2, system_prompt: 'Latest prompt' });
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey(other.model)]).toEqual(other);
    expect(base.cfg!.settings_profiles!.entries).toEqual([profile]);
  });
  it('serializes selections and makes explicit project configuration take precedence', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await Promise.all([hook.result.current.store.updateConfig({ ctx_size: 8192 }), hook.result.current.selectModel('b.gguf')]); });
    await act(async () => { await hook.result.current.store.updateConfig({ active_model: 'a.gguf', ctx_size: 32768 }); });
    expect(base.cfg).toMatchObject({ active_model: 'a.gguf', ctx_size: 32768 });
    expect(restoreExecution(base.cfg!, 'a.gguf').ctx_size).toBe(32768);
  });
  it('rejects a storage failure before changing the native model', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const hook = renderHook(() => useExecutionStore(base));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await expect(hook.result.current.selectModel('b.gguf')).rejects.toThrow('Storage full'); });
      expect(base.cfg?.active_model).toBe('a.gguf'); expect(base.updateConfig).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  it('saves session and app metadata without accessing model memory', async () => {
    const base = createTestStore();
    const hook = renderHook(() => useExecutionStore(base));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await hook.result.current.store.updateConfig({ sessions: [], stop_existing_sessions_on_load: false }); });
      expect(base.cfg?.stop_existing_sessions_on_load).toBe(false);
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  it('preserves a successful native save when the final local cache write fails', async () => {
    const base = createTestStore({ active_model: 'a.gguf', settings_profiles: { ...emptyProfileLibrary(), revision: 1, legacy_imported: true } });
    const hook = renderHook(() => useExecutionStore(base));
    const original = Storage.prototype.setItem;
    let writes = 0;
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      writes += 1;
      if (writes === 3) throw new Error('Cache full');
      original.call(this, key, value);
    });
    try {
      await act(async () => { await hook.result.current.selectModel('b.gguf'); });
      expect(base.updateConfig).toHaveBeenCalledOnce();
      expect(base.cfg?.active_model).toBe('b.gguf');
      expect(base.cfg?.settings_profiles?.revision).toBe(2);
      expect(hook.result.current.store.actionError).toContain('Settings were saved');
      expect(hook.result.current.store.actionError).toContain('Cache full');
    } finally { write.mockRestore(); }
  });
  it('keeps direct model edits and both model snapshots in the same native save', async () => {
    const base = createTestStore({ active_model: 'a.gguf', settings_profiles: { ...emptyProfileLibrary(), revision: 3, legacy_imported: true } });
    const key = profileTargetKey('a.gguf');
    const profile = { ...captureProfile(base.cfg!, 'Saved source', 'model', 'Preserved prompt'), id: 'source-profile' };
    base.cfg!.settings_profiles!.entries = [defaultSettingsProfile(), profile];
    base.cfg!.settings_profiles!.default_profile_id = defaultSettingsProfile().id;
    base.cfg!.settings_profiles!.applied[key] = materializeProfileApplication(base.cfg!, 'Preserved prompt', profile);
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 0.3 }); });
    expect(base.cfg!.settings_profiles!.applied[key]).toMatchObject({
      settings: { temperature: 0.3 }, system_prompt: 'Preserved prompt', profile_id: 'source-profile',
    });
    expect(base.cfg!.settings_profiles!.entries.find(entry => entry.id === 'source-profile')).toMatchObject({ settings: { temperature: 0.3 }, revision: 2 });
    await act(async () => { await hook.result.current.selectModel('b.gguf'); });
    expect(base.cfg?.settings_profiles?.revision).toBe(5);
    expect(base.cfg!.settings_profiles!.applied[key].settings.temperature).toBe(0.3);
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('b.gguf')].model).toBe('b.gguf');
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 1.2 }); });
    await act(async () => { await hook.result.current.selectModel('a.gguf'); });
    expect(base.cfg?.temperature).toBe(0.3);
    expect(restoreExecution(base.cfg!, 'b.gguf').temperature).toBe(1.2);
  });
  it('preserves an explicitly committed profile library without a second revision increment', async () => {
    const base = createTestStore({ active_model: 'a.gguf', settings_profiles: { ...emptyProfileLibrary(), revision: 1, legacy_imported: true } });
    const profile = captureProfile({ ...base.cfg!, temperature: 0.4 }, 'Saved profile', 'model', 'New prompt');
    const library = { ...emptyProfileLibrary(), revision: 2, legacy_imported: true, default_profile_id: defaultSettingsProfile().id,
      entries: [defaultSettingsProfile(), profile], applied: { [profileTargetKey('a.gguf')]: materializeProfileApplication({ ...base.cfg!, temperature: 0.4 }, 'New prompt', profile) } };
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 0.4, settings_profiles: library }); });
    expect(base.cfg?.settings_profiles).toEqual(library);
    expect(base.updateConfig).toHaveBeenCalledOnce();
  });
  it('writes direct execution edits into the selected global profile without creating a copy', async () => {
    const base = createTestStore({ active_model: 'a.gguf', runtime_defaults: ['temperature'] });
    const source = captureProfile(base.cfg!, 'Portable', 'global', 'Saved prompt');
    const key = profileTargetKey('a.gguf');
    base.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [source], legacy_imported: true,
      applied: { [key]: materializeProfileApplication(base.cfg!, 'Saved prompt', source) } };
    const before = structuredClone(source);
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 0.4, ngl: 17, mmproj: 'projector.gguf' }); });
    const library = base.cfg!.settings_profiles!;
    const applied = library.applied[key];
    const saved = library.entries.find(entry => entry.id === applied.profile_id)!;
    expect(saved).toMatchObject({ id: source.id, scope: 'global', system_prompt: 'Saved prompt',
      settings: { temperature: 0.4, ngl: 17, mmproj: 'projector.gguf' } });
    expect(saved.settings.runtime_defaults).not.toContain('temperature');
    expect(saved.settings.runtime_defaults).not.toContain('ngl');
    expect(source).toEqual(before);
    expect(saved).not.toHaveProperty('source_id');
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 0.7 }); });
    expect(base.cfg!.settings_profiles!.applied[key].profile_id).toBe(source.id);
    expect(base.cfg!.settings_profiles!.entries).toHaveLength(1);
  });
  it('saves session execution changes in a named profile without accessing model memory', async () => {
    const definition = { id: 'saved', name: 'Saved', enabled: false, models: { primary_model: 'session.gguf', mmproj: '', draft_model: '' },
      gpu: emptyGpuPlacement(), execution: { temperature: 0.4 } };
    const base = createTestStore({ sessions: [definition] });
    const hook = renderHook(() => useExecutionStore(base));
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await hook.result.current.store.updateConfig({ sessions: [{ ...definition, execution: { temperature: 0.7 } }] }); });
      const library = base.cfg!.settings_profiles!;
      const application = library.applied['session:saved'];
      expect(application).toMatchObject({ model: 'session.gguf', profile_id: expect.any(String), settings: { temperature: 0.7 } });
      expect(library.entries.find(entry => entry.id === application.profile_id)).toMatchObject({ settings: { temperature: 0.7 } });
      expect(write).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
  });
  it('keeps Default selected when choosing the first model without creating a recovered profile', async () => {
    const base = createTestStore({ active_model: '' });
    const source = defaultSettingsProfile();
    base.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [source], legacy_imported: true,
      applied: { 'model:': materializeProfileApplication(base.cfg!, '', source) } };
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.selectModel('first.gguf'); });
    expect(base.cfg!.settings_profiles!.entries).toEqual([source]);
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('first.gguf')]).toMatchObject({ profile_id: source.id, profile_name: 'Default' });
    expect(base.cfg!.settings_profiles!.applied).not.toHaveProperty('model:');
  });
  it('uses the designated default for a new model while preserving an existing target assignment', async () => {
    const base = createTestStore({ active_model: 'first.gguf' });
    const source = captureProfile(base.cfg!, 'Portable', 'global', 'Selected prompt');
    const savedConfig = { ...base.cfg!, active_model: 'saved.gguf', temperature: 0.2 };
    const savedProfile = captureProfile(savedConfig, 'Saved model', 'model', 'Saved prompt');
    const fallback = captureProfile({ ...base.cfg!, temperature: 0.6 }, 'Preferred', 'global', 'Default prompt');
    base.cfg!.settings_profiles = { ...emptyProfileLibrary(), entries: [source, savedProfile, fallback], legacy_imported: true, default_profile_id: fallback.id,
      applied: { [profileTargetKey('first.gguf')]: materializeProfileApplication(base.cfg!, 'Selected prompt', source),
        [profileTargetKey('saved.gguf')]: materializeProfileApplication(savedConfig, 'Saved prompt', savedProfile) } };
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.selectModel('new.gguf'); });
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('new.gguf')]).toMatchObject({ profile_id: fallback.id, system_prompt: 'Default prompt' });
    expect(base.cfg!.temperature).toBe(0.6);
    await act(async () => { await hook.result.current.selectModel('saved.gguf'); });
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('saved.gguf')]).toMatchObject({ profile_id: savedProfile.id, system_prompt: 'Saved prompt' });
    expect(base.cfg!.temperature).toBe(0.2);
  });
});
