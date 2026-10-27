import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../shared/api/types';
import type { ConfigPatch } from '../../shared/state/configSaveQueue';
import { createTestStore } from '../../testing/appStore';
import { useExecutionStore } from './useExecutionStore';
import { MODEL_EXECUTION_KEY, restoreExecution } from './modelExecutionState';
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, ensureProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';
import { emptyGpuPlacement } from '../../shared/runtime/sessionUtils';

function savedProfileConfig(): AppConfig {
  const cfg = createTestStore({ active_model: 'a.gguf', gpu: { ...emptyGpuPlacement(), gpu_ids: ['0'] } }).cfg!;
  const profile = { ...captureProfile(cfg, 'Saved', 'model', 'Saved prompt'), id: 'saved-profile' };
  cfg.settings_profiles = { ...emptyProfileLibrary(), revision: 1, legacy_imported: true, default_profile_id: defaultSettingsProfile().id,
    entries: [defaultSettingsProfile(), profile], applied: { [profileTargetKey('a.gguf')]: materializeProfileApplication(cfg, 'Saved prompt', profile) } };
  return cfg;
}

// A save that waited for the native queue must store what an immediate save of
// the inputs present when it persists stores.
async function saveNow(cfg: AppConfig, patch: ConfigPatch<AppConfig>) {
  const base = createTestStore(structuredClone(cfg));
  const hook = renderHook(() => useExecutionStore(base));
  await act(async () => { await hook.result.current.store.updateConfig(patch); });
  hook.unmount();
  const saved = { cfg: base.cfg, memory: localStorage.getItem(MODEL_EXECUTION_KEY) };
  localStorage.clear();
  return saved;
}

function waitingStore(cfg: AppConfig) {
  const base = createTestStore(structuredClone(cfg));
  const save = base.updateConfig;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  base.updateConfig = vi.fn(async patch => { await gate; return save(patch); });
  return { base, release, hook: renderHook(() => useExecutionStore(base)) };
}

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
  it('recomputes patches against the latest config instead of pinning a stale snapshot', async () => {
    const base = createTestStore({ active_model: 'a.gguf', settings_profiles: { ...emptyProfileLibrary(), revision: 1, legacy_imported: true } });
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ models_dir: 'D:\\models' }); });
    const patch = vi.mocked(base.updateConfig).mock.calls[0][0] as (fresh: AppConfig) => Partial<AppConfig>;
    expect(typeof patch).toBe('function');
    // A base-store conflict recovery re-expands after reloading: profiles must
    // chain onto the reloaded revision instead of the stale one.
    const fresh = { ...base.cfg!, settings_profiles: { ...base.cfg!.settings_profiles!, revision: 9 } };
    const expanded = patch(fresh);
    expect(expanded.models_dir).toBe('D:\\models');
    if (expanded.settings_profiles) expect(expanded.settings_profiles.revision).toBe(10);
  });
  it('saves the latest contents of a caller-owned patch changed while the native save waits', async () => {
    const cfg = savedProfileConfig();
    const expected = await saveNow(cfg, { temperature: 0.9 });
    const { base, release, hook } = waitingStore(cfg);
    const patch: Partial<AppConfig> = { temperature: 0.3 };
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig(patch); });
    expect(base.updateConfig).toHaveBeenCalledOnce();
    patch.temperature = 0.9;
    await act(async () => { release(); await saving; });
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('a.gguf')].settings.temperature).toBe(0.9);
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(expected.memory);
  });
  it('distinguishes an optional field cleared while the native save waits from an absent one', async () => {
    const cfg = savedProfileConfig();
    const expected = await saveNow(cfg, { temperature: 0.3, gpu: undefined });
    const { base, release, hook } = waitingStore(cfg);
    const patch: Partial<AppConfig> = { temperature: 0.3 };
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig(patch); });
    patch.gpu = undefined;
    await act(async () => { release(); await saving; });
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(base.cfg).toHaveProperty('gpu', undefined);
    expect(base.cfg!.settings_profiles!.applied[profileTargetKey('a.gguf')].settings).not.toHaveProperty('gpu');
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(expected.memory);
  });
  it('re-evaluates a functional patch whose captured value changed while the native save waits', async () => {
    const cfg = savedProfileConfig();
    const expected = await saveNow(cfg, { temperature: 0.9 });
    const { base, release, hook } = waitingStore(cfg);
    let temperature = 0.3;
    const evaluated: Array<{ fresh: AppConfig; temperature: number }> = [];
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig(fresh => { evaluated.push({ fresh, temperature }); return { temperature }; }); });
    temperature = 0.9;
    await act(async () => { release(); await saving; });
    // The preview and the native save each evaluate the patch against the same live snapshot.
    expect(evaluated.map(entry => entry.temperature)).toEqual([0.3, 0.9]);
    expect(evaluated.every(entry => entry.fresh === base.cfg)).toBe(true);
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(expected.memory);
  });
  it('expands against an in-place edit of the same snapshot made while the native save waits', async () => {
    const cfg = savedProfileConfig();
    const key = profileTargetKey('a.gguf');
    const edited = structuredClone(cfg);
    edited.settings_profiles!.applied[key].system_prompt = 'Edited while saving';
    const expected = await saveNow(edited, { temperature: 0.3 });
    const { base, release, hook } = waitingStore(cfg);
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig({ temperature: 0.3 }); });
    base.getConfig()!.settings_profiles!.applied[key].system_prompt = 'Edited while saving';
    await act(async () => { release(); await saving; });
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(base.cfg!.settings_profiles!.applied[key]).toMatchObject({ profile_id: 'saved-profile', system_prompt: 'Edited while saving', settings: { temperature: 0.3 } });
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBe(expected.memory);
  });
  it('assigns a session appended to a caller-owned session list while the native save waits', async () => {
    const definition = (id: string, model: string, temperature: number) => ({ id, name: id, enabled: false,
      models: { primary_model: model, mmproj: '', draft_model: '' }, gpu: emptyGpuPlacement(), execution: { temperature } });
    const cfg = savedProfileConfig();
    const first = definition('first', 'first.gguf', 0.4);
    const second = definition('second', 'second.gguf', 0.6);
    const expected = await saveNow(cfg, { sessions: [first, second] });
    const { base, release, hook } = waitingStore(cfg);
    const patch: Partial<AppConfig> = { sessions: [first] };
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig(patch); });
    patch.sessions!.push(second);
    await act(async () => { release(); await saving; });
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(base.cfg!.sessions).toEqual([first, second]);
    const library = base.cfg!.settings_profiles!;
    expect(library.applied['session:second']).toMatchObject({ model: 'second.gguf', settings: { temperature: 0.6 } });
    expect(library.entries.find(entry => entry.id === library.applied['session:second'].profile_id)).toMatchObject({ settings: { temperature: 0.6 } });
  });
  it('expands against an array length changed in place on the same snapshot while the native save waits', async () => {
    const cfg = savedProfileConfig();
    const key = profileTargetKey('a.gguf');
    const edited = structuredClone(cfg);
    edited.lora_adapters.length = 1;
    const expected = await saveNow(edited, { temperature: 0.3 });
    const { base, release, hook } = waitingStore(cfg);
    let saving!: Promise<AppConfig>;
    await act(async () => { saving = hook.result.current.store.updateConfig({ temperature: 0.3 }); });
    // A sparse length change keeps the same own keys as the empty array.
    base.getConfig()!.lora_adapters.length = 1;
    await act(async () => { release(); await saving; });
    expect(base.cfg).toStrictEqual(expected.cfg);
    expect(base.cfg!.settings_profiles!.applied[key].settings.lora_adapters).toHaveLength(1);
  });
  it('re-expands the native save callback again after its snapshot changes in place', async () => {
    const base = createTestStore(savedProfileConfig());
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await hook.result.current.store.updateConfig({ temperature: 0.3 }); });
    const patch = vi.mocked(base.updateConfig).mock.calls[0][0] as (fresh: AppConfig) => Partial<AppConfig>;
    const live = base.cfg!;
    const revision = live.settings_profiles!.revision;
    live.temperature = 0.5;
    live.settings_profiles!.applied[profileTargetKey('a.gguf')].settings.temperature = 0.5;
    expect(patch(live)).toMatchObject({ temperature: 0.3, settings_profiles: { revision: revision + 1 } });
  });
  it('rejects a conflicting profile library before writing model memory or calling the native save', async () => {
    const base = createTestStore({ active_model: 'a.gguf' });
    const cfg = { ...base.cfg!, active_model: '/models/Example.gguf' };
    const application = materializeProfileApplication(cfg, '', captureProfile(cfg, 'Saved', 'model', ''));
    const conflicting = { ...emptyProfileLibrary(), entries: [defaultSettingsProfile()], applied: {
      'model:/models/example.gguf': application, 'model:/models/Example.gguf': { ...application, system_prompt: 'Different' } } };
    const before = structuredClone(base.cfg);
    const hook = renderHook(() => useExecutionStore(base));
    const patch = { active_model: 'b.gguf', settings_profiles: conflicting };
    await act(async () => { await expect(hook.result.current.store.updateConfig(patch)).rejects.toThrow('Conflicting saved settings'); });
    expect(base.updateConfig).not.toHaveBeenCalled();
    expect(localStorage.getItem(MODEL_EXECUTION_KEY)).toBeNull();
    expect(base.cfg).toStrictEqual(before);
    expect(hook.result.current.store.actionError).toContain('Conflicting saved settings');
    // Unusable model memory must not mask the profile conflict.
    const write = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full'); });
    try {
      await act(async () => { await expect(hook.result.current.store.updateConfig(patch)).rejects.toThrow('Conflicting saved settings'); });
      expect(write).not.toHaveBeenCalled();
      expect(base.updateConfig).not.toHaveBeenCalled();
    } finally { write.mockRestore(); }
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
  it('keeps the departing model snapshot and rolls back the new selection after a native save failure', async () => {
    const base = createTestStore({ active_model: 'a.gguf', temperature: 0.3 });
    const save = base.updateConfig;
    base.updateConfig = vi.fn().mockRejectedValueOnce(new Error('disk full')).mockImplementation(save);
    const hook = renderHook(() => useExecutionStore(base));
    await act(async () => { await expect(hook.result.current.store.updateConfig({ active_model: 'b.gguf', temperature: 0.9 })).rejects.toThrow('disk full'); });
    const memory = JSON.parse(localStorage.getItem(MODEL_EXECUTION_KEY)!).models;
    expect(memory['a.gguf']).toMatchObject({ temperature: 0.3 });
    expect(memory).not.toHaveProperty('b.gguf');
    expect(base.cfg).toMatchObject({ active_model: 'a.gguf', temperature: 0.3 });
    expect(hook.result.current.store.actionError).toContain('disk full');
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
    expect(base.cfg!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([profile]);
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
    expect(base.cfg?.settings_profiles).toEqual(ensureProfileLibrary(library));
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
    expect(base.cfg!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toHaveLength(1);
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
    expect(base.cfg!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual([source]);
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
