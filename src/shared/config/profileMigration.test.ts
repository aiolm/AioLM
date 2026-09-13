import { describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { emptyGpuPlacement } from '../runtime/sessionUtils';
import { applySettingsProfile, captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey } from './settingsProfiles';
import { migrateProfileLibrary } from './profileMigration';
import { applyDefaultProfile } from './profileAssignments';

const key = 'aiolm-model-profiles';
function storageWith(values: Record<string, unknown> = {}) {
  const original = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, JSON.stringify(value)]));
  return { getItem: vi.fn((name: string): string | null => original[name] ?? null), setItem: vi.fn(), removeItem: vi.fn(), original };
}
const server = { id: 'server-a', name: 'Shared name', backend: 'cpu', build: 'b100', ctx_size: 2048, runtime_defaults: ['ngl'], ngl: 12 };
const generation = { id: 'generation-a', name: 'Shared name', temperature: 0.3, system_prompt: '  Saved prompt.\n', chat_options: { stop: ['stale'], seed: 5 }, stop_strings: [' end ', '\n\n'] };

describe('profile library migration', () => {
  it.each([2, 3, 4])('preserves every version %s profile without cross-product expansion or renaming', version => {
    const loading = Array.from({ length: 24 }, (_, index) => ({ id: `load-${index}`, name: `Loading ${index}`, backend: 'cpu', build: 'b100', active_model: `missing-${index}.gguf`, mmproj: '', ctx_size: 4096, ngl: 0, threads: 4, flash_attn: 'auto' }));
    const storage = storageWith({
      [key]: { version, server: [server, { ...server, id: 'unused-server', ctx_size: 65536 }], model: [
        { ...generation, modelPath: 'models/a.gguf' }, { ...generation, id: 'unused-generation', modelPath: 'missing.gguf', temperature: 1.2 },
      ], activeServerIds: { 'models/a.gguf': server.id }, activeModelIds: { 'models/a.gguf': generation.id } },
      'aiolm.loading-profiles.v1': loading,
    });
    const first = migrateProfileLibrary({ ...testConfig, active_model: 'models/a.gguf' }, storage);
    const again = migrateProfileLibrary({ ...testConfig, active_model: 'models/a.gguf' }, storage);
    expect(first).toEqual(again);
    expect(first.entries.filter(entry => entry.legacy)).toHaveLength(28);
    expect(first.entries.slice(0, 4).map(entry => entry.name)).toEqual(['Shared name', 'Shared name', 'Shared name', 'Shared name']);
    expect(first.entries[1].settings.ctx_size).toBe(65536);
    expect(first.entries[3]).toMatchObject({ model_key: profileTargetKey('missing.gguf'), scope: 'model', settings: { temperature: 1.2 } });
    expect(first.entries[27]).toMatchObject({ model_key: profileTargetKey('missing-23.gguf'), settings: { threads: 4 } });
    expect(first.entries[0]).toMatchObject({ scope: 'global', legacy: true });
    expect(first.entries[0].settings).not.toHaveProperty('temperature');
    expect(first.entries[2].settings).not.toHaveProperty('ctx_size');
    expect(first.revision).toBe(0);
    expect(first.legacy_imported).toBe(true);
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('preserves explicit empty stops and missing stop fields separately without altering stop text', () => {
    const storage = storageWith({ [key]: { version: 4, server: [], model: [
      generation,
      { ...generation, id: 'empty', stop_strings: [] },
      { id: 'absent', name: 'Absent', chat_options: { stop: 'literal\n stop ' } },
      { id: 'unset', name: 'Unset' },
    ] } });
    const { entries } = migrateProfileLibrary(testConfig, storage);
    expect(entries[0].settings.chat_options).toEqual({ stop: [' end ', '\n\n'], seed: 5 });
    expect(entries[1].settings.chat_options).toEqual({ seed: 5 });
    expect(entries[2].settings.chat_options).toEqual({ stop: 'literal\n stop ' });
    expect(entries[3].settings).not.toHaveProperty('chat_options');
    expect(entries[0].system_prompt).toBe('  Saved prompt.\n');
    expect(entries[3]).not.toHaveProperty('system_prompt');
  });

  it('keeps current, remembered and session execution values while resolving target prompts once', () => {
    const currentPath = 'models/a.gguf';
    const rememberedPath = 'models/b.gguf';
    const sessionPath = 'models/c.gguf';
    const storage = storageWith({
      [key]: { version: 4, server: [server], model: [generation, { ...generation, id: 'session-prompt', system_prompt: 'Session prompt' }], activeModelId: generation.id,
        activeServerIds: { [currentPath]: server.id }, activeModelIds: { [currentPath]: generation.id, [rememberedPath]: generation.id } },
      'aiolm-model-execution': { version: 1, models: { [rememberedPath]: { temperature: 0.6, ctx_size: 16384, chat_options: { stop: ['remembered'] }, mmproj: 'remembered-projector.gguf' } } },
    });
    const cfg = { ...testConfig, active_model: currentPath, temperature: 0.9, ctx_size: 8192, chat_options: { stop: ['current'] }, sessions: [
      { id: 'saved-session', name: 'Saved', enabled: false, models: { primary_model: sessionPath, mmproj: 'session-projector.gguf', draft_model: '' }, gpu: emptyGpuPlacement(),
        execution: { temperature: 1.1, chat_options: { stop: ['session'] } }, model_profile_id: 'session-prompt' },
      { id: 'deleted-reference', name: 'Deleted', enabled: true, models: { primary_model: currentPath, mmproj: '', draft_model: '' }, gpu: emptyGpuPlacement(), model_profile_id: 'deleted' },
    ] };
    const before = structuredClone(cfg);
    const library = migrateProfileLibrary(cfg, storage);
    expect(library.applied[profileTargetKey(currentPath)]).toMatchObject({ settings: { temperature: 0.9, ctx_size: 8192, chat_options: { stop: ['current'] } }, system_prompt: generation.system_prompt });
    expect(library.applied[profileTargetKey(rememberedPath)]).toMatchObject({ model: rememberedPath, profile_id: expect.any(String), settings: { temperature: 0.6, ctx_size: 16384, chat_options: { stop: ['remembered'] }, mmproj: 'remembered-projector.gguf' }, system_prompt: generation.system_prompt });
    expect(library.applied['session:saved-session']).toMatchObject({ model: sessionPath, settings: { temperature: 1.1, mmproj: 'session-projector.gguf', chat_options: { stop: ['session'] } }, system_prompt: 'Session prompt' });
    expect(library.applied['session:deleted-reference'].system_prompt).toBe('');
    expect(cfg).toEqual(before);
    storage.getItem.mockReturnValue(null);
    expect(migrateProfileLibrary({ ...cfg, settings_profiles: library }, storage)).toEqual(library);
  });

  it('resolves only selected pairs for inactive models without copying the current private settings', () => {
    const storage = storageWith({ [key]: { version: 3, server: [server], model: [generation], activeServerIds: { 'missing.gguf': server.id }, activeModelIds: { 'missing.gguf': generation.id } } });
    const library = migrateProfileLibrary({ ...testConfig, mmproj: 'current-only.gguf' }, storage);
    const application = library.applied[profileTargetKey('missing.gguf')];
    expect(application).toMatchObject({ settings: { ctx_size: 2048, temperature: 0.3, chat_options: { stop: generation.stop_strings } }, system_prompt: generation.system_prompt });
    expect(application.settings).not.toHaveProperty('mmproj');
    expect(application.settings.runtime_defaults).toEqual(['ngl']);
  });

  it('retains incomplete legacy runtime metadata without applying it to the current runtime', () => {
    const storage = storageWith({ [key]: { version: 4, server: [{ id: 'old', name: 'Old', backend: 'vulkan', ctx_size: 8192 }], model: [] } });
    const [profile] = migrateProfileLibrary(testConfig, storage).entries;
    expect(profile.settings.active_backend).toBe('vulkan');
    expect(profile.coverage).not.toContain('active_backend');
    expect(applySettingsProfile(testConfig, profile)).toMatchObject({ active_backend: testConfig.active_backend, active_build: testConfig.active_build, ctx_size: 8192 });
    expect(profile.settings).not.toHaveProperty('temperature');
  });

  it('preserves raw-only legacy tuning and sidecars before removing managed arguments', () => {
    const storage = storageWith({ [key]: { version: 4, server: [{ id: 'raw', name: 'Raw', threads: 4,
      server_args: ['--threads', '8', '--ctx-size=8192', '--spec-draft-model', 'draft.gguf', '--reasoning-preserve', '--seed', '5', '--api-key', 'synthetic-secret'] }], model: [] },
      'aiolm-model-execution': { version: 1, models: { 'other.gguf': { server_args: ['--threads', '6'] } } },
    });
    const library = migrateProfileLibrary(testConfig, storage);
    expect(library.entries[0].settings).toMatchObject({ threads: 4, ctx_size: 8192, spec_draft_model: 'draft.gguf', reasoning_preserve: 'on', server_args: ['--seed', '5'] });
    expect(library.entries[0].coverage).toContain('ctx_size');
    expect(library.applied[profileTargetKey('other.gguf')].settings).toMatchObject({ threads: 6, server_args: [] });
    expect(storage.original[key]).toContain('synthetic-secret');
  });

  it('preserves an existing library and applied snapshots, retries deterministically, and never increments its revision', () => {
    const existing = captureProfile(testConfig, 'New profile', 'model', 'New prompt');
    const application = materializeProfileApplication(testConfig, 'Already saved', existing);
    const saved = { ...emptyProfileLibrary(), revision: 8, entries: [existing], applied: { [profileTargetKey(testConfig.active_model)]: application } };
    const storage = storageWith({ [key]: { version: 4, server: [server], model: [generation] } });
    const migrated = migrateProfileLibrary({ ...testConfig, settings_profiles: saved }, storage);
    expect(migrated.revision).toBe(8);
    expect(migrated.entries).toHaveLength(3);
    expect(migrated.applied[profileTargetKey(testConfig.active_model)]).toEqual(application);
    expect(saved.entries).toHaveLength(1);
    expect(migrateProfileLibrary({ ...testConfig, settings_profiles: { ...migrated, legacy_imported: false } }, storage)).toEqual(migrated);
    storage.getItem.mockImplementation(() => { throw new Error('Storage denied'); });
    expect(migrateProfileLibrary({ ...testConfig, settings_profiles: migrated }, storage)).toEqual(migrated);
  });

  it('initializes a clean installation with only Default and preserves existing duplicate source IDs', () => {
    const blank = { ...testConfig, active_model: '' };
    expect(migrateProfileLibrary(blank, storageWith())).toEqual({ ...emptyProfileLibrary(), entries: [defaultSettingsProfile()], default_profile_id: defaultSettingsProfile().id,
      applied: { 'model:': applyDefaultProfile(blank, emptyProfileLibrary()).application }, legacy_imported: true });
    const library = migrateProfileLibrary(testConfig, storageWith({ [key]: { version: 4, server: [server, server], model: [generation, generation] } }));
    expect(new Set(library.entries.filter(entry => entry.legacy).map(entry => entry.id)).size).toBe(4);
  });

  it('repairs an empty imported library and names preserved snapshots without importing again', () => {
    const application = { model: testConfig.active_model, settings: profileSettingsSnapshot(testConfig), system_prompt: 'Saved prompt' };
    const library = { ...emptyProfileLibrary(), revision: 12, legacy_imported: true, applied: { saved: application } };
    const storage = { getItem: vi.fn(() => { throw new Error('Legacy storage must not be read'); }) };
    const repaired = migrateProfileLibrary({ ...testConfig, temperature: 1.7, settings_profiles: library }, storage);
    expect(repaired.entries[0]).toEqual(defaultSettingsProfile());
    expect(repaired.applied.saved).toMatchObject(application);
    expect(repaired.applied.saved.profile_id).toBeTruthy();
    const recovered = repaired.entries.find(entry => entry.id === repaired.applied.saved.profile_id);
    expect(recovered).toMatchObject({ scope: 'model', settings: { temperature: testConfig.temperature }, system_prompt: 'Saved prompt' });
    expect(repaired.revision).toBe(12);
    expect(library.entries).toEqual([]);
    expect(storage.getItem).not.toHaveBeenCalled();
  });

  it.each([
    { [key]: { version: 9, server: [], model: [] } },
    { [key]: { version: 4, server: [server, { ...server, ctx_size: 'bad' }], model: [generation] } },
    { [key]: { version: 4, server: [], model: [{ ...generation, stop_strings: [8] }] } },
    { 'aiolm.loading-profiles.v1': { entries: [] } },
    { 'aiolm-model-execution': { version: 2, models: {} } },
  ])('rejects invalid input without writing or deleting any source', values => {
    const storage = storageWith(values);
    expect(() => migrateProfileLibrary(testConfig, storage)).toThrow('original data has been preserved');
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(storage.removeItem).not.toHaveBeenCalled();
  });

  it('propagates unreadable storage and malformed JSON before marking an import complete', () => {
    expect(() => migrateProfileLibrary(testConfig, { getItem: () => '{' })).toThrow('original data has been preserved');
    expect(() => migrateProfileLibrary(testConfig, { getItem: () => { throw new Error('Storage denied'); } })).toThrow('Storage denied');
    expect(() => migrateProfileLibrary({ ...testConfig, settings_profiles: { ...emptyProfileLibrary(), version: 2 as 1 } }, storageWith())).toThrow('profile library');
  });
});
