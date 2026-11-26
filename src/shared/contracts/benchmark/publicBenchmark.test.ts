// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import { summarizeServingPoints } from './aggregation';
import type { PerformanceBenchmarkProvenance, PerformanceBenchmarkResult } from '../../api/types';
import type { BenchmarkModelMetadata } from '@aiolm/benchmark-contracts';
import { defined } from '../../../testing/assertDefined';
import { servingBenchmark } from '../../../testing/servingBenchmark';

const submissionId = '00000000-0000-4000-8000-000000000001';
const sample = (snapshot: PerformanceBenchmarkProvenance = provenance()) => {
  const record = servingBenchmark();
  record.result.provenance = snapshot;
  return record;
};
const gpu = (name: string) => ({ name, vendor: 'Example GPU vendor', vram_mb: 8192, driver: 'driver 1.0', integrated: false });
function provenance(): PerformanceBenchmarkProvenance {
  const p = servingBenchmark().result.provenance!;
  p.model = { format: 'gguf', status: 'sha256', sha256: 'b'.repeat(64), size_bytes: 123456 };
  p.environment = {
    scope: 'aiolm_host', os: 'linux', arch: 'x86_64', cpu: { name: 'Example CPU', logical_cores: 16 },
    installed_gpus: [gpu('GPU A'), gpu('GPU B')],
    execution: { mode: 'selected', selected_gpus: [gpu('GPU B')], devices: ['private-stable-id'], selection_complete: true },
    detection: 'private detector diagnostic',
  };
  return p;
}

const metadata = (): BenchmarkModelMetadata => ({
  format: 'GGUF', name: 'Example Instruct', architecture: 'example', size_label: '8B',
  quantization: 'Q4_K_M', file_type: 15, quantized_by: 'Example Quantizer',
  repository: 'example-distributor/Example-8B-GGUF', base_models: ['example-author/Example-8B'],
  artifact: 'weights/Example-8B-Q4_K_M.gguf', source: 'gguf+huggingface',
});

describe('public benchmark boundary', () => {
  it.each(['hf-safetensors', 'mlx', 'gguf'] as const)('publishes the frozen engine and %s model identity without local arguments', format => {
    const record = sample();
    record.result.provenance!.runtime = { name: 'vllm', version: '0.30.0', backend: 'metal', build: '0.30.0', variant: 'vllm-metal', plugin_version: '0.30.0' };
    record.result.provenance!.model.format = format;
    record.result.args = ['/private/python', '--api-key', 'private-secret'];
    record.result.engine_args = ['/private/engine', '--api-key', 'private-engine-secret'];
    const result = toPublicBenchmark(record, submissionId);
    expect(result.schema_version).toBe(4);
    expect(result.method.version).toBe(5);
    expect(result.runtime).toEqual(record.result.provenance!.runtime);
    expect(result.model.format).toBe(format);
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects incomplete runs and failed measurements without changing the local record', () => {
    for (const status of ['partial', 'failed', 'cancelled'] as const) {
      const record = sample();
      const result: PerformanceBenchmarkResult = { ...record.result, status };
      expect(() => toPublicBenchmark({ ...record, result }, submissionId)).toThrow('Only completed benchmarks');
      expect(result.status).toBe(status);
    }
    const record = sample();
    const failed: PerformanceBenchmarkResult = { ...record.result, rows: [{ ...defined(record.result.rows[0]), error: 'request failed' }] };
    expect(() => toPublicBenchmark({ ...record, result: failed }, submissionId)).toThrow('successful measurements');
    expect(() => toPublicBenchmark({ ...record, result: { ...record.result, rows: [] } }, submissionId)).toThrow();
  });

  it('publishes the physical core count beside the thread count and leaves an uncollected one out', () => {
    const p = provenance();
    p.environment.cpu.physical_cores = 8;
    const published = toPublicBenchmark(sample(p), submissionId).environment?.cpu;
    expect(published).toEqual({ name: 'Example CPU', logical_cores: 16, physical_cores: 8 });

    // A machine that does not report the count publishes null, which is not the
    // same claim as "this processor has no separate physical cores".
    p.environment.cpu.physical_cores = null;
    expect(toPublicBenchmark(sample(p), submissionId).environment?.cpu.physical_cores).toBeNull();

    // A measurement taken before the count was collected stays as it was
    // archived rather than being filled in from the machine reading it now.
    delete p.environment.cpu.physical_cores;
    expect(toPublicBenchmark(sample(p), submissionId).environment?.cpu).not.toHaveProperty('physical_cores');

    for (const invalid of [0, -2, 1.5]) {
      p.environment.cpu.physical_cores = invalid;
      expect(() => toPublicBenchmark(sample(p), submissionId)).toThrow();
    }
  });


  it('shares only the RAM capacity captured with the measurement and validates its unit', () => {
    const p = provenance();
    p.environment.system_memory_bytes = 64 * 1024 ** 3;
    expect(toPublicBenchmark(sample(p), submissionId).environment?.system_memory_bytes).toBe(64 * 1024 ** 3);
    delete p.environment.system_memory_bytes;
    expect(toPublicBenchmark(sample(p), submissionId).environment).not.toHaveProperty('system_memory_bytes');
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      p.environment.system_memory_bytes = invalid;
      expect(() => toPublicBenchmark(sample(p), submissionId)).toThrow();
    }
  });
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

  it('keeps absent model metadata absent and accepts an explicit null', () => {
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
    Object.assign(defined(source.result.provenance!.environment.execution.selected_gpus[0]), { stable_id: 'private-gpu-id', secret: 'private-token' });
    const result = toPublicBenchmark(source, submissionId);
    expect(JSON.stringify(result)).not.toMatch(/private|owner|fingerprint|stable_id|diagnostic/);
    expect(result.environment?.execution.selected_gpus.map(item => item.name)).toEqual(['GPU B']);
    expect(result.measurements.rows[0]).toMatchObject({ failed: false, output_bytes: 12, tpot_ms: null, peak_memory_bytes: null });
    expect(source.result.args).toContain('PRIVATE-CREDENTIAL');
    expect(result.model.sha256).toBe('b'.repeat(64));
  });

  it('copies exactly the serving row fields and leaves private and removed fields behind', () => {
    const record = sample();
    const row = defined(record.result.rows[0]);
    Object.assign(row, { content_bytes: 12, reported_cached_tokens: 0, local_path: '/private/row' });
    const before = structuredClone(record);
    const published = defined(toPublicBenchmark(record, submissionId).measurements.rows[0]);
    expect(Object.keys(published).sort()).toEqual([
      'input_bytes', 'max_output_tokens', 'concurrency', 'repetition', 'input_sha256_by_request',
      'first_output_ms', 'e2e_ms', 'output_bytes', 'reported_prompt_tokens', 'reported_completion_tokens',
      'prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms', 'usage_status', 'finish_reasons',
      'peak_memory_bytes', 'timing_source', 'failed',
    ].sort());
    expect(published.input_sha256_by_request).not.toBe(row.input_sha256_by_request);
    expect(published.finish_reasons).not.toBe(row.finish_reasons);
    expect(record).toEqual(before);
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
    defined(p.environment.installed_gpus[0]).driver = 'C:\\private\\driver';
    const source = sample(p);
    const result = toPublicBenchmark(source, submissionId);
    expect(result.environment?.cpu.name).toBeNull(); expect(defined(result.environment?.installed_gpus[0]).driver).toBeNull();
  });

  it('rejects unknown public fields, malformed identifiers, nonfinite metrics and inconsistent hashes', () => {
    const valid = toPublicBenchmark(sample(), submissionId);
    expect(validatePublicBenchmark(valid)).toBe(valid);
    expect(() => validatePublicBenchmark({ ...valid, args: ['secret'] })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, runtime: { ...valid.runtime, path: '/private' } })).toThrow();
    expect(() => validatePublicBenchmark(JSON.parse(JSON.stringify(valid).replace('"schema_version":4', '"schema_version":4,"__proto__":{"secret":"private"}')))).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, constructor: 'private' })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, submission_id: 'private-id' })).toThrow();
    expect(() => validatePublicBenchmark({ ...valid, model: { status: 'sha256', sha256: null, size_bytes: 1 } })).toThrow();
    defined(valid.measurements.rows[0]).first_output_ms = Number.POSITIVE_INFINITY;
    expect(() => validatePublicBenchmark(valid)).toThrow();
  });

  it('reuses identical aggregation for the public evidence without private trial identifiers', () => {
    const result = toPublicBenchmark(sample(), submissionId);
    const row = defined(result.measurements.rows[0]);
    expect(summarizeServingPoints([row])[0]).toMatchObject({
      samples: 1, first_output_ms: { median: 20, min: 20, max: 20, samples: 1 },
      output_bytes_per_second: { median: 60, min: 60, max: 60, samples: 1 },
    });
  });
});
