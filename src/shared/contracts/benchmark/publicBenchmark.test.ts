import { describe, expect, it } from 'vitest';
import { toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import { summarizePublicBenchmarkRows } from './aggregation';
import type { PerformanceBenchmarkProvenance, PerformanceBenchmarkResult } from '../../api/types';
import type { BenchmarkModelMetadata } from '@aiolm/benchmark-contracts';

const submissionId = '00000000-0000-4000-8000-000000000001';
const sample = (provenance?: PerformanceBenchmarkProvenance) => ({
  backend: 'cuda', build: 'b1234', model: '/private/models/owner-secret.gguf', device: { fingerprint: 'owner-device-identifier' },
  request: { run_id: 'owner-private-id', context_profile: 'novel_en' as const, prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 1, warmup: true },
  result: {
    run_id: 'owner-private-id', status: 'partial', message: '/private/secret.log failed', args: ['--api-key', 'private-token', '-m', '/private/secret.gguf'],
    runtime_version: '1234', context_size: 4096, parallel: 2, provenance,
    rows: [{ id: 'private-trial-id', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1,
      completion_tokens: 128, cached_tokens: 0, ttft_ms: 40, tpot_ms: 10, pp_tps: 100, tg_tps: 100,
      e2e_ms: 1400, total_tps: 95, peak_memory_bytes: null, timing_source: 'client', error: '/private/failed-host' }],
  } satisfies PerformanceBenchmarkResult,
});
const gpu = (name: string) => ({ name, vendor: 'Example GPU vendor', vram_mb: 8192, driver: 'driver 1.0', integrated: false });
function provenance(): PerformanceBenchmarkProvenance {
  return {
    schema_version: 1, app_version: '0.1.9', method: { id: 'cold-prompt-serving', version: 1 },
    corpus: { profile: 'novel_en', version: 1, sha256: 'a'.repeat(64) }, model: { status: 'sha256', sha256: 'b'.repeat(64), size_bytes: 123456 },
    environment: { os: 'linux', arch: 'x86_64', cpu: { name: 'Example CPU', logical_cores: 16 }, installed_gpus: [gpu('GPU A'), gpu('GPU B')],
      execution: { mode: 'selected', selected_gpus: [gpu('GPU B')], devices: ['private-stable-id'], selection_complete: true }, detection: 'private detector diagnostic' },
  };
}

const metadata = (): BenchmarkModelMetadata => ({
  format: 'GGUF', name: 'Example Instruct', architecture: 'example', size_label: '8B',
  quantization: 'Q4_K_M', file_type: 15, quantized_by: 'Example Quantizer',
  repository: 'example-distributor/Example-8B-GGUF', base_models: ['example-author/Example-8B'],
  artifact: 'weights/Example-8B-Q4_K_M.gguf', source: 'gguf+huggingface',
});

describe('public benchmark boundary', () => {
  it('preserves exact public model metadata without copying native-only fields', () => {
    const p = provenance();
    p.model.metadata = metadata();
    Object.assign(p.model.metadata, { local_path: '/private/renamed.gguf', access_token: 'private-token' });
    const result = toPublicBenchmark(sample(p), submissionId);
    expect(result.model.metadata).toEqual(metadata());
    expect(JSON.stringify(result.model)).not.toMatch(/private|local_path|access_token/);
    expect(p.model.metadata).toHaveProperty('local_path');
    expect(result.model.metadata?.base_models).not.toBe(p.model.metadata.base_models);
  });

  it('keeps missing model metadata absent on old records and accepts an explicit null', () => {
    const result = toPublicBenchmark(sample(provenance()), submissionId);
    expect(result.model).not.toHaveProperty('metadata');
    result.model.metadata = null;
    expect(validatePublicBenchmark(result)).toBe(result);
  });

  it('drops private model labels, origins and artifact paths without inventing a distributor', () => {
    const p = provenance();
    p.model.metadata = { ...metadata(), name: 'C:\\private\\model.gguf', quantized_by: 'person@example.test',
      repository: 'https://example.test/private', artifact: '../private/model.gguf',
      base_models: ['example-author/Example-8B', 'example-author/Example-8B', '/private/model', 'example/../model'],
    };
    expect(toPublicBenchmark(sample(p), submissionId).model.metadata).toMatchObject({
      name: null, quantized_by: null, repository: null, artifact: null,
      base_models: ['example-author/Example-8B'], source: 'gguf',
    });
  });

  it.each([
    { repository: 'https://huggingface.co/example/model' },
    { repository: 'example/../model' },
    { repository: 'example/model?token=secret' },
    { artifact: '/private/model.gguf' },
    { artifact: '../model.gguf' },
    { artifact: 'weights/../../model.gguf' },
    { artifact: 'C:\\private\\model.gguf' },
    { artifact: 'weights/model.gguf?token=secret' },
    { base_models: Array(9).fill('example/model') },
    { file_type: 65536 },
    { name: 'bad\nlabel' },
    { local_path: '/private/model.gguf' },
    { source: 'filename' },
    { source: 'gguf', artifact: 'model.gguf' },
    { repository: null, artifact: 'model.gguf' },
  ])('rejects unsafe or unsupported public model metadata: %j', (invalid) => {
    const result = toPublicBenchmark(sample(provenance()), submissionId);
    expect(() => validatePublicBenchmark({ ...result, model: { ...result.model, metadata: { ...metadata(), ...invalid } } })).toThrow();
  });

  it('copies only the public allowlist, including nested hardware and raw trials', () => {
    const source = sample(provenance());
    Object.assign(source.result.provenance!.environment.execution.selected_gpus[0], { stable_id: 'private-gpu-id', secret: 'private-token' });
    const result = toPublicBenchmark(source, submissionId);
    expect(JSON.stringify(result)).not.toMatch(/private|owner|fingerprint|stable_id|diagnostic/);
    expect(result.environment?.execution.selected_gpus.map(item => item.name)).toEqual(['GPU B']);
    expect(result.measurements.rows[0]).toMatchObject({ failed: true, tg_tps: 100, peak_memory_bytes: null });
    expect(source.result.args).toContain('private-token');
    expect(result.model.sha256).toBe('b'.repeat(64));
  });

  it('keeps legacy identity, method and environment unknown instead of using current hardware', () => {
    const result = toPublicBenchmark(sample(), submissionId);
    expect(result.environment).toBeNull();
    expect(result.method).toBeNull();
    expect(result.app_version).toBeNull();
    expect(result.model).toEqual({ status: 'unidentified', sha256: null, size_bytes: null });
    expect(result.workload.corpus_version).toBeNull();
    expect(result.execution.settings).toBeNull();
  });

  it('records CPU and multiple selected GPUs without substituting the first installed GPU', () => {
    const p = provenance();
    p.environment.execution = { mode: 'cpu', selected_gpus: [], devices: [], selection_complete: true };
    expect(toPublicBenchmark(sample(p), submissionId).environment?.execution).toEqual({ mode: 'cpu', selected_gpus: [], selection_complete: true });
    p.environment.execution = { mode: 'selected', selected_gpus: [gpu('GPU B'), gpu('GPU A')], devices: ['first-private', 'second-private'], selection_complete: true };
    expect(toPublicBenchmark(sample(p), submissionId).environment?.execution.selected_gpus.map(item => item.name)).toEqual(['GPU B', 'GPU A']);
  });

  it('drops paths, URLs, credentials and diagnostic newlines from description fields', () => {
    const p = provenance();
    p.environment.cpu.name = 'owner@example.test';
    p.environment.installed_gpus[0].driver = 'C:\\private\\driver';
    const source = sample(p);
    source.result.runtime_version = 'version 1234\nbuild at /private/build';
    source.build = 'https://private.test';
    const result = toPublicBenchmark(source, submissionId);
    expect(result.runtime.version).toBeNull(); expect(result.runtime.build).toBeNull();
    expect(result.environment?.cpu.name).toBeNull(); expect(result.environment?.installed_gpus[0].driver).toBeNull();
  });

  it('rejects unknown public fields, malformed identifiers, nonfinite metrics and inconsistent hashes', () => {
    const valid = toPublicBenchmark(sample(), submissionId);
    expect(validatePublicBenchmark(valid)).toBe(valid);
    expect(() => validatePublicBenchmark({ ...valid, args: ['secret'] })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, runtime: { ...valid.runtime, path: '/private' } })).toThrow();
    expect(() => validatePublicBenchmark(JSON.parse(JSON.stringify(valid).replace('"schema_version":1', '"schema_version":1,"__proto__":{"secret":"private"}')))).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, constructor: 'private' })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, submission_id: 'private-id' })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, model: { status: 'sha256', sha256: null, size_bytes: 1 } })).toThrow();
    valid.measurements.rows[0].tg_tps = Number.POSITIVE_INFINITY;
    expect(() => validatePublicBenchmark(valid)).toThrow();
  });

  it('reuses identical metric aggregation for public rows without private trial identifiers', () => {
    const result = toPublicBenchmark(sample(), submissionId);
    const base = { ...result.measurements.rows[0], failed: false, tg_tps: 100 };
    const rows = summarizePublicBenchmarkRows([base, { ...base, concurrency: 2, tg_tps: 180 }, { ...base, repetition: 2, failed: true }]);
    expect(rows.find(row => row.concurrency === 2)?.speedup).toBe(1.8);
    expect(rows.find(row => row.error)?.samples).toBe(0);
  });

  it('preserves explicit runtime automatic and inherited thread settings as minus one', () => {
    const p = provenance();
    p.execution_config = { gpu_layers: -1, threads: -1, threads_batch: -1, flash_attention: null, cache_type_k: null, cache_type_v: null, split_mode: null, tensor_split: null };
    const result = toPublicBenchmark(sample(p), submissionId);
    expect(result.execution.settings).toMatchObject({ gpu_layers: -1, threads: -1, threads_batch: -1 });
    result.execution.settings!.threads = -2;
    expect(() => validatePublicBenchmark(result)).toThrow();
  });
});
