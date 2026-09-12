import { beforeEach, describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { executionSnapshot, rememberExecution, restoreExecution, previewExecution, MODEL_EXECUTION_KEY } from './modelExecutionState';
import { loadProfiles, createModelProfile, saveModelProfile, saveServerProfile, saveProfileSelection } from '../profiles/modelProfiles';

describe('model execution memory', () => {
  beforeEach(() => localStorage.clear());
  it('restores independent runtime, sampling, adapters and inheritance for each model', () => {
    const a = { ...testConfig, active_model: 'C:\\models\\A.gguf', active_backend: 'vulkan', active_build: 'b77', ctx_size: 8192, temperature: 0.4, runtime_defaults: ['top_k'], mmproj: 'a-vision.gguf', lora_adapters: [{ path: 'a-lora.gguf', scale: 0.5, enabled: true }] };
    const b = { ...testConfig, active_model: 'C:/models/b.gguf', ctx_size: 2048, temperature: 1.2 };
    rememberExecution(a); rememberExecution(b);
    expect(restoreExecution(b, 'c:/models/a.gguf')).toMatchObject({ active_backend: 'vulkan', active_build: 'b77', ctx_size: 8192, temperature: 0.4, runtime_defaults: ['top_k'], mmproj: 'a-vision.gguf', lora_adapters: a.lora_adapters });
    expect(restoreExecution(a, b.active_model)).toMatchObject({ ctx_size: 2048, temperature: 1.2, mmproj: '', lora_adapters: [] });
  });
  it('keeps execution memory separate from mutable shared profiles and remembers both model selections', () => {
    const a = { ...testConfig, active_model: 'a.gguf', temperature: 0.2 };
    const initial = loadProfiles(a, a.active_model);
    saveServerProfile(initial.server[0]); saveModelProfile(initial.model[0]);
    saveProfileSelection(initial.activeServerId, a.active_model, initial.activeModelId);
    const creative = createModelProfile({ ...a, temperature: 1.2 }, 'Creative');
    saveModelProfile(creative);
    saveProfileSelection(initial.activeServerId, 'b.gguf', creative.id);
    rememberExecution(a);
    saveModelProfile({ ...initial.model[0], temperature: 0.9 });
    expect(restoreExecution(testConfig, 'a.gguf').temperature).toBe(0.2);
    expect(loadProfiles(a, 'a.gguf').activeModelId).toBe(initial.activeModelId);
    expect(loadProfiles(a, 'b.gguf').activeModelId).toBe(creative.id);
  });
  it('does not restore app settings, ports, sessions or credentials from a snapshot', () => {
    const input = { ...testConfig, api_key: 'secret', server_args: ['--api-key', 'private', '--threads', '4'] };
    const captured = executionSnapshot(input);
    expect(captured).not.toHaveProperty('api_key'); expect(captured).not.toHaveProperty('models_dir'); expect(captured).not.toHaveProperty('port'); expect(captured).not.toHaveProperty('sessions');
    expect(captured.server_args).toEqual(['--threads', '4']);
    localStorage.setItem(MODEL_EXECUTION_KEY, JSON.stringify({ version: 1, models: { 'a.gguf': { ...captured, port: 9999, api_key: 'injected' } } }));
    expect(restoreExecution(testConfig, 'a.gguf')).not.toHaveProperty('api_key');
    expect(restoreExecution(testConfig, 'a.gguf')).not.toHaveProperty('port');
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
