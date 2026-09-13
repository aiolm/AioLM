import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import type { SessionDefinition } from '../api/types';
import {
  ExecutionConflictError, executionChanges, executionConfig, executionSettings,
  mergeExecutionChanges, serverSettingsChanged, sessionExecutionSettings, settingsForSession,
} from './executionSettings';

const session: SessionDefinition = {
  id: 'work', name: 'Work session', enabled: false,
  models: { primary_model: 'work.gguf', mmproj: 'projector.gguf', draft_model: 'draft.gguf' },
  gpu: { gpu_ids: ['gpu-a'], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
  model_profile_id: 'profile-work',
};

describe('execution settings boundaries', () => {
  it('copies execution values without accepting application fields or credentials', () => {
    const source = { ...structuredClone(testConfig), api_key: 'synthetic-token',
      port: 9999, models_dir: 'unrelated-models', sessions: [session],
      chat_options: { stop: ['end'] }, lora_adapters: [{ path: 'adapter.gguf', scale: 0.5, enabled: true }] };
    const snapshot = executionSettings(source);
    for (const key of ['api_key', 'port', 'models_dir', 'sessions', 'config_version', 'iters', 'stop_existing_sessions_on_load']) {
      expect(snapshot).not.toHaveProperty(key);
    }
    (snapshot.chat_options.stop as string[]).push('done');
    snapshot.lora_adapters[0].scale = 1;
    expect(source.chat_options.stop).toEqual(['end']);
    expect(source.lora_adapters[0].scale).toBe(0.5);
    expect(executionConfig(testConfig, source)).toMatchObject({ port: testConfig.port, models_dir: testConfig.models_dir });
  });

  it('stores model and GPU bindings once while retaining session metadata', () => {
    const edited = { ...structuredClone(testConfig), active_model: 'updated.gguf', mmproj: '', spec_draft_model: '',
      temperature: 0.3, gpu: { ...session.gpu, gpu_ids: ['gpu-b'] } };
    const saved = settingsForSession(session, edited);
    expect(saved).toMatchObject({ id: 'work', name: 'Work session', enabled: false, model_profile_id: 'profile-work',
      models: { primary_model: 'updated.gguf', mmproj: '', draft_model: '' }, gpu: { gpu_ids: ['gpu-b'] }, execution: { temperature: 0.3 } });
    for (const key of ['active_model', 'mmproj', 'spec_draft_model', 'gpu', 'port', 'sessions']) {
      expect(sessionExecutionSettings(edited)).not.toHaveProperty(key);
    }
    saved.gpu.gpu_ids.push('gpu-c');
    expect(edited.gpu.gpu_ids).toEqual(['gpu-b']);
    expect(session.models.primary_model).toBe('work.gguf');
  });
});

describe('concurrent execution edits', () => {
  it('merges edited fields into current settings while retaining unrelated newer values', () => {
    const base = structuredClone(testConfig);
    const draft = { ...base, temperature: 0.2, port: 9999, models_dir: 'ignored-draft-folder' };
    const current = { ...base, ctx_size: 16384, port: 9123, models_dir: 'current-models', sessions: [session] };
    const merged = mergeExecutionChanges(base, draft, current);
    expect(merged).toMatchObject({ temperature: 0.2, ctx_size: 16384, port: 9123, models_dir: 'current-models', sessions: [session] });
    expect(executionChanges(base, draft)).toEqual({ temperature: 0.2 });
    expect(current.temperature).toBe(base.temperature);
  });

  it('rejects overlapping edits with the conflicting fields and leaves inputs intact', () => {
    const base = structuredClone(testConfig);
    const draft = { ...base, ctx_size: 8192, temperature: 0.2 };
    const current = { ...base, ctx_size: 16384, temperature: 0.4 };
    let failure: unknown;
    try { mergeExecutionChanges(base, draft, current); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ExecutionConflictError);
    expect((failure as ExecutionConflictError).fields).toEqual(['ctx_size', 'temperature']);
    expect(current.ctx_size).toBe(16384);
    expect(draft.ctx_size).toBe(8192);
  });

  it('accepts a concurrent edit that already reached the same value', () => {
    const base = structuredClone(testConfig);
    expect(mergeExecutionChanges(base, { ...base, temperature: 0.2 }, { ...base, temperature: 0.2, port: 9123 }))
      .toMatchObject({ temperature: 0.2, port: 9123 });
  });

  it('keeps nested edited values independent of later draft changes', () => {
    const base = structuredClone(testConfig);
    const draft = { ...base, chat_options: { stop: ['done'] } };
    const merged = mergeExecutionChanges(base, draft, base);
    draft.chat_options.stop.push('later');
    expect(merged.chat_options.stop).toEqual(['done']);
  });
});

describe('restart requirements', () => {
  it('allows request delivery when saving an omitted GPU placement as the empty product default', () => {
    const base = { ...structuredClone(testConfig), gpu: undefined };
    const saved = { ...base, temperature: 0.2, gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none' as const, tensor_split: [], draft_gpu_id: null } };
    expect(serverSettingsChanged(base, saved)).toBe(false);
    expect(serverSettingsChanged(saved, base)).toBe(false);
    expect(base.gpu).toBeUndefined();
  });

  it.each([
    { gpu_ids: ['gpu-a'] }, { main_gpu: 'gpu-a' }, { split_mode: 'layer' as const },
    { tensor_split: [0.5, 0.5] }, { draft_gpu_id: 'gpu-b' },
  ])('requires a restart for an actual GPU placement change %j', patch => {
    const base = { ...structuredClone(testConfig), gpu: undefined };
    const changed = { ...base, gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none' as const, tensor_split: [], draft_gpu_id: null, ...patch } };
    expect(serverSettingsChanged(base, changed)).toBe(true);
    expect(serverSettingsChanged(changed, base)).toBe(true);
  });

  it('allows request settings and request defaults to apply without a server restart', () => {
    const base = { ...structuredClone(testConfig), runtime_defaults: ['threads', 'temperature'] };
    const draft = { ...base, temperature: 0.2, top_p: 0.8, top_k: 10, reasoning_effort: 'high',
      chat_options: { stop: ['done'] }, runtime_defaults: ['top_p', 'threads'] };
    expect(serverSettingsChanged(base, draft)).toBe(false);
    expect(base.runtime_defaults).toEqual(['threads', 'temperature']);
    expect(draft.runtime_defaults).toEqual(['top_p', 'threads']);
  });

  it.each([
    { active_model: 'another.gguf' }, { mmproj: 'vision.gguf' }, { ctx_size: 16384 },
    { active_build: 'another-build' }, { sleep_idle_seconds: 60 },
    { runtime_defaults: ['threads'] }, { reasoning: 'off' },
  ])('requires a restart for server changes %j', patch => {
    expect(serverSettingsChanged(testConfig, { ...testConfig, ...patch })).toBe(true);
  });
});
