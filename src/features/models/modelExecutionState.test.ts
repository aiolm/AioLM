import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { executionSnapshot, rememberExecution, restoreExecution, previewExecution, MODEL_EXECUTION_KEY } from './modelExecutionState';
import { captureProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from '../../shared/config/settingsProfiles';

describe('model execution memory', () => {
  beforeEach(() => localStorage.clear());
  it('restores independent runtime, sampling, adapters and inheritance for each model', () => {
    const a = { ...testConfig, active_model: 'C:\\models\\A.gguf', active_backend: 'vulkan', active_build: 'b77', ctx_size: 8192, temperature: 0.4, runtime_defaults: ['top_k'], mmproj: 'a-vision.gguf', lora_adapters: [{ path: 'a-lora.gguf', scale: 0.5, enabled: true }] };
    const b = { ...testConfig, active_model: 'C:/models/b.gguf', ctx_size: 2048, temperature: 1.2 };
    rememberExecution(a); rememberExecution(b);
    expect(restoreExecution(b, 'c:/models/a.gguf')).toMatchObject({ active_backend: 'vulkan', active_build: 'b77', ctx_size: 8192, temperature: 0.4, runtime_defaults: ['top_k'], mmproj: 'a-vision.gguf', lora_adapters: a.lora_adapters });
    expect(restoreExecution(a, b.active_model)).toMatchObject({ ctx_size: 2048, temperature: 1.2, mmproj: '', lora_adapters: [] });
  });
  it('restores an applied snapshot independently of changed profile originals and stale local memory', () => {
    const a = { ...testConfig, active_model: 'a.gguf', temperature: 0.2 };
    const original = captureProfile(a, 'Brief', 'global', 'Saved prompt');
    const library = { ...emptyProfileLibrary(), revision: 1, entries: [{ ...original, settings: { temperature: 0.9 } }], applied: { [profileTargetKey(a.active_model)]: materializeProfileApplication(a, 'Saved prompt', original) } };
    rememberExecution({ ...a, temperature: 1.2 });
    const cfg = { ...testConfig, settings_profiles: library };
    expect(restoreExecution(cfg, 'a.gguf').temperature).toBe(0.2);
    const read = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Cache unavailable'); });
    try { expect(previewExecution(cfg, 'a.gguf').temperature).toBe(0.2); } finally { read.mockRestore(); }
  });
  it('does not restore app settings, ports, sessions or credentials from a snapshot', () => {
    const input = { ...testConfig, api_key: 'secret', server_args: ['--api-key', 'private', '--threads', '4'] };
    const captured = executionSnapshot(input);
    expect(captured).not.toHaveProperty('api_key'); expect(captured).not.toHaveProperty('models_dir'); expect(captured).not.toHaveProperty('port'); expect(captured).not.toHaveProperty('sessions');
    expect(captured.server_args).toEqual([]);
    localStorage.setItem(MODEL_EXECUTION_KEY, JSON.stringify({ version: 1, models: { 'a.gguf': { ...captured, port: 9999, api_key: 'injected' } } }));
    expect(restoreExecution(testConfig, 'a.gguf')).not.toHaveProperty('api_key');
    expect(restoreExecution(testConfig, 'a.gguf')).not.toHaveProperty('port');
  });
  it('uses the current model settings when an older applied snapshot still exists', () => {
    const application = materializeProfileApplication({ ...testConfig, temperature: 0.2 }, 'Saved', captureProfile(testConfig, 'Saved', 'model', 'Saved'));
    const cfg = { ...testConfig, temperature: 0.7, settings_profiles: { ...emptyProfileLibrary(), applied: { [profileTargetKey(testConfig.active_model)]: application } } };
    expect(restoreExecution(cfg, testConfig.active_model).temperature).toBe(0.7);
  });
  it('does not consult legacy profile selections for a model without saved settings', () => {
    localStorage.setItem('aiolm-model-profiles', '{invalid');
    expect(restoreExecution({ ...testConfig, temperature: 0.6 }, 'new.gguf').temperature).toBe(0.6);
  });
  it('previews an unseen model without copying another model sidecars or writing memory', () => {
    const a = { ...testConfig, active_model: 'a.gguf', mmproj: 'a-projector.gguf', spec_type: 'draft', spec_draft_model: 'a-draft.gguf', lora_adapters: [{ path: 'a-adapter.gguf', scale: 1, enabled: true }] };
    const before = localStorage.length;
    expect(previewExecution(a, 'b.gguf')).toMatchObject({ active_model: 'b.gguf', mmproj: '', spec_draft_model: '', spec_type: 'none', lora_adapters: [] });
    expect(localStorage.length).toBe(before);
    rememberExecution({ ...a, active_model: 'b.gguf', mmproj: 'b-projector.gguf' });
    expect(previewExecution(a, 'b.gguf').mmproj).toBe('b-projector.gguf');
  });
});
