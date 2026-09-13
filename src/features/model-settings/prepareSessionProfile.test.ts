import { describe, expect, it, vi } from 'vitest';
import { createTestStore, testConfig } from '../../testing/appStore';
import type { AppConfig, SessionDefinition } from '../../shared/api/types';
import { profileTargetKey, saveSettingsProfile } from '../../shared/config/settingsProfiles';
import { defaultSessionDefinition } from '../../shared/runtime/sessionUtils';
import { profileLibrary } from './profileEditor';
import { prepareSessionProfile } from './prepareSessionProfile';

function fixture() {
  const definition: SessionDefinition = { id: 'work', name: 'Work', enabled: false,
    models: { primary_model: 'models/work.gguf', mmproj: '', draft_model: '' },
    gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
    execution: { ctx_size: 8192, temperature: 0.2 } };
  const other = { ...structuredClone(definition), id: 'other', name: 'Other', models: { ...definition.models, primary_model: 'models/other.gguf' } };
  const config: AppConfig = { ...structuredClone(testConfig), sessions: [definition, other], stop_existing_sessions_on_load: false };
  config.settings_profiles = profileLibrary(config);
  return { config, definition, other };
}

describe('session profile preparation', () => {
  it.each(['default', 'work'])('uses the latest saved profile for %s without changing profiles or other targets', async id => {
    const { config, definition, other } = fixture();
    const target = id === 'default' ? { ...defaultSessionDefinition(config), id: 'default' } : definition;
    const key = profileTargetKey(target.models.primary_model, id);
    const library = config.settings_profiles!;
    const application = library.applied[key];
    const selected = library.entries.find(profile => profile.id === application.profile_id)!;
    const updated = saveSettingsProfile(selected, { ...config, ...selected.settings, active_model: target.models.primary_model,
      ctx_size: 16384, ngl: 9, mmproj: 'models/projector.gguf', runtime_defaults: [] }, 'Latest saved prompt');
    library.entries = library.entries.map(profile => profile.id === selected.id ? updated : profile);
    const before = structuredClone(config);
    const store = createTestStore(config);
    const result = await prepareSessionProfile(store, target);
    expect(result).toMatchObject({ active_model: target.models.primary_model, ctx_size: 16384, ngl: 9, mmproj: 'models/projector.gguf' });
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(store.cfg!.settings_profiles!.entries).toEqual(before.settings_profiles!.entries);
    expect(store.cfg!.settings_profiles!.applied[key]).toMatchObject({ profile_id: selected.id, profile_revision: updated.revision,
      system_prompt: 'Latest saved prompt', settings: { ctx_size: 16384, ngl: 9, mmproj: 'models/projector.gguf' } });
    for (const [otherKey, snapshot] of Object.entries(before.settings_profiles!.applied)) {
      if (otherKey !== key) expect(store.cfg!.settings_profiles!.applied[otherKey]).toEqual(snapshot);
    }
    expect(store.cfg!.sessions!.find(item => item.id === other.id)).toEqual(other);
    if (id === 'work') expect(store.cfg!.active_model).toBe(before.active_model);
  });

  it('uses current session metadata from the save transaction instead of an older caller snapshot', async () => {
    const { config, definition } = fixture();
    config.sessions![0] = { ...definition, name: 'Latest name' };
    const store = createTestStore(config);
    await prepareSessionProfile(store, { ...definition, name: 'Old name' });
    expect(store.cfg!.sessions!.find(item => item.id === definition.id)?.name).toBe('Latest name');
  });

  it('rejects a failed save without mutating the existing configuration', async () => {
    const { config, definition } = fixture();
    const store = createTestStore(config);
    const before = structuredClone(store.cfg);
    vi.mocked(store.updateConfig).mockImplementationOnce(async patch => {
      if (typeof patch === 'function') patch(store.cfg!);
      throw new Error('Synthetic persistence failure');
    });
    await expect(prepareSessionProfile(store, definition)).rejects.toThrow('Synthetic persistence failure');
    expect(store.cfg).toEqual(before);
  });

  it('does not recreate a session removed while its profile save was queued', async () => {
    const { config, definition } = fixture();
    const store = createTestStore(config);
    let save!: () => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise((resolve, reject) => {
      save = () => {
        try { resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch)); }
        catch (error) { reject(error); }
      };
    }));
    const pending = prepareSessionProfile(store, definition);
    store.cfg!.sessions = store.cfg!.sessions!.filter(item => item.id !== definition.id);
    const afterRemoval = structuredClone(store.cfg);
    save();
    await expect(pending).rejects.toThrow('The selected session was removed');
    expect(store.cfg).toEqual(afterRemoval);
  });

  it('persists a new session that has never had a saved definition', async () => {
    const { config, definition } = fixture();
    const store = createTestStore(config);
    const created = { ...structuredClone(definition), id: 'new-session', name: 'New session' };
    await prepareSessionProfile(store, created);
    expect(store.cfg!.sessions!.find(item => item.id === created.id)).toMatchObject({ id: created.id, name: created.name, models: created.models });
    expect(store.cfg!.settings_profiles!.applied[profileTargetKey(created.models.primary_model, created.id)].profile_id).toBeTruthy();
  });
});
