import { describe, expect, it } from 'vitest';
import { benchmarkSettingsProfile, localBenchmarkProfileSource, publicBenchmarkProfileSource, type BenchmarkProfileSource } from './benchmarkProfile';
import { applySettingsProfile } from '../../shared/config/settingsProfiles';
import { testConfig } from '../../testing/appStore';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

const source = (args: string[] = []): BenchmarkProfileSource => ({
  runtime: { name: 'llama.cpp', version: 'b123', backend: 'cpu', build: 'b123' },
  execution: { context_size: 32768, parallel: 4, settings: {
    gpu_layers: 0, threads: 12, threads_batch: 16, flash_attention: 'off',
    cache_type_k: 'q8_0', cache_type_v: 'f16', split_mode: 'none', tensor_split: null,
  }, effective_args: args },
});

describe('benchmark settings profiles', () => {
  it('restores a Metal benchmark into vLLM profiles without selecting another installation', () => {
    const local = { backend: 'metal', build: '0.30.0', result: {
      provider: 'vllm', runtime_version: '0.30.0', runtime_accelerator: 'metal', runtime_variant: 'vllm-metal', runtime_plugin_version: '0.30.0',
      context_size: 8192, parallel: 1, status: 'complete', args: ['--max-model-len', '8192'],
    } } as PerformanceBenchmarkRecord;
    const projected = localBenchmarkProfileSource(local);
    expect(projected.runtime).toMatchObject({ name: 'vllm', variant: 'vllm-metal', plugin_version: '0.30.0' });
    const { profile } = benchmarkSettingsProfile(projected, 'metal');
    expect(profile.provider).toBe('vllm');
    expect(profile.settings).toEqual({ provider_options: { vllm: { max_model_len: 8192 } } });
  });
  it('imports only vLLM options and preserves explicit false flags independently of llama.cpp settings', () => {
    const python: BenchmarkProfileSource = { runtime: { name: 'vllm', version: '0.31.0', backend: 'cuda', build: '0.31.0' },
      execution: { context_size: 8192, parallel: 2, settings: null, effective_args: ['--max-model-len', '8192', '--enable-prefix-caching=false', '--unknown-option', 'discard'] } };
    const { profile, omitted } = benchmarkSettingsProfile(python, 'vllm-1');
    expect(profile.provider).toBe('vllm');
    expect(profile.settings).toEqual({ provider_options: { vllm: { max_model_len: 8192, enable_prefix_caching: false } } });
    expect(profile.settings).not.toHaveProperty('ctx_size');
    expect(profile.settings).not.toHaveProperty('active_runtime');
    expect(omitted).toBe(true);
  });
  it('restores measured settings, ordered portable options and inherited defaults without capturing another profile', () => {
    const { profile, omitted } = benchmarkSettingsProfile(source([
      '--ctx-size', '8192', '--batch-size=1024', '-ub', '256', '--threads', '8',
      '--threads-batch', '24', '--no-webui', '--rope-scaling', 'yarn', '--reasoning-budget', '-1',
    ]), 'public-1');
    expect(omitted).toBe(false);
    const applied = applySettingsProfile({ ...testConfig, batch_size: 999, active_backend: 'vulkan',
      spec_draft_model: '/synthetic/old-draft.gguf', server_args: ['--unknown', 'old'], temperature: 1.5,
      gpu: { gpu_ids: ['synthetic-device'], main_gpu: 'synthetic-device', split_mode: 'row', tensor_split: [1], draft_gpu_id: null } }, profile);
    expect(applied).toMatchObject({ active_model: testConfig.active_model, ctx_size: 32768, parallel: 4,
      ngl: 0, threads: 12, batch_size: 1024, ubatch_size: 256, active_backend: 'vulkan', active_build: 'b123',
      spec_draft_model: '', gpu: { gpu_ids: [], main_gpu: null },
      server_args: ['--no-webui', '--rope-scaling', 'yarn', '--threads-batch', '16'] });
    expect(applied.runtime_defaults).toContain('temperature');
    expect(applied.runtime_defaults).not.toContain('ctx_size');
    expect(applied.runtime_defaults).not.toContain('batch_size');
    expect(profile.settings).not.toHaveProperty('active_model');
  });

  it('reports options it cannot reproduce and excludes network, device, file and unknown arguments', () => {
    const { profile, omitted } = benchmarkSettingsProfile(source([
      '--rpc', 'remote-machine', '--device', 'synthetic-device', '--unknown', 'value',
      '--model', 'model.gguf', '--flash-attn', 'unsupported', '--batch-size', 'NaN',
    ]), 'public-2');
    expect(omitted).toBe(true);
    expect(profile.settings.server_args).toEqual(['--threads-batch', '16']);
    expect(profile.settings.runtime_defaults).toContain('batch_size');
    expect(profile.settings.flash_attn).toBe('off');
    expect(JSON.stringify(profile)).not.toContain('remote-machine');
    expect(JSON.stringify(profile)).not.toContain('synthetic-device');
  });

  it('keeps null fields inherited in old records and rejects missing allocations or malformed metadata', () => {
    const legacy = source();
    legacy.execution.settings = null;
    const profile = benchmarkSettingsProfile(legacy, 'old-1').profile;
    expect(profile.settings.runtime_defaults).toContain('ngl');
    expect(profile.settings.runtime_defaults).toContain('threads');
    legacy.runtime.build = null;
    const missingRuntime = benchmarkSettingsProfile(legacy, 'old-2');
    expect(missingRuntime.profile.settings).not.toHaveProperty('active_backend');
    expect(missingRuntime.profile.settings).not.toHaveProperty('active_build');
    expect(missingRuntime.omitted).toBe(true);
    expect(() => publicBenchmarkProfileSource({ id: 'other', benchmark: source() }, 'public-1')).toThrow();
    expect(() => benchmarkSettingsProfile({ ...source(), execution: { ...source().execution, context_size: 0 } }, 'old')).toThrow();
    expect(() => publicBenchmarkProfileSource({ id: 'public-1', benchmark: { ...source(), execution: {
      ...source().execution, effective_args: ['--model', '/private/model.gguf'],
    } } }, 'public-1')).toThrow();
    expect(() => publicBenchmarkProfileSource({ id: 'public-1', benchmark: { ...source(), runtime: {
      ...source().runtime, models_dir: '/private',
    } } }, 'public-1')).toThrow();
  });

  it('restores GPU split proportions from older launch arguments without importing device identities', () => {
    const older = source(['-sm', 'row', '-ts', '1,2.5']);
    older.execution.settings = null;
    const { profile, omitted } = benchmarkSettingsProfile(older, 'older-gpu');
    expect(omitted).toBe(false);
    expect(profile.settings.gpu).toEqual({ gpu_ids: [], main_gpu: null, split_mode: 'row', tensor_split: [1, 2.5], draft_gpu_id: null });
    expect(() => benchmarkSettingsProfile(older, 'x'.repeat(111))).toThrow();
  });

  it('imports local run settings even when measurements failed, while removing private launch values', () => {
    const local = { backend: 'cpu', build: 'b123', result: {
      context_size: 32768, parallel: 4, status: 'failed',
      args: ['-m', '/synthetic/models/model.gguf', '--api-key', 'synthetic-secret', '--batch-size', '1024'],
    } } as PerformanceBenchmarkRecord;
    const { profile } = benchmarkSettingsProfile(localBenchmarkProfileSource(local), 'local-1');
    expect(profile.settings.batch_size).toBe(1024);
    expect(profile.settings.ctx_size).toBe(32768);
    expect(JSON.stringify(profile)).not.toContain('synthetic-secret');
    expect(JSON.stringify(profile)).not.toContain('/synthetic');
  });
});
