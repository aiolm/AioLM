import { beforeEach, describe, expect, it } from 'vitest';
import { publicModelSource, toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import { localBenchmarkProfileSource, publicBenchmarkProfileSource, validateBenchmarkProfileSource } from './configuration';
import { summarizeServingPoints } from './aggregation';
import { PERFORMANCE_HISTORY_KEY, isPerformanceRecord, readPerformanceHistory, recordedBenchmarkModelLabel, savePerformanceRecord, type ServingPerformanceBenchmarkRecord } from '../../../features/bench/performanceRecords';

const submission = '00000000-0000-4000-8000-000000000025';
function serving(): ServingPerformanceBenchmarkRecord {
  return {
    schemaVersion: 2, id: 'serving-run', createdAt: 1000, model: '/private/live-label',
    request: { run_id: 'serving-run', method: { id: 'openai-chat-serving', version: 1 }, context_profile: 'novel_en',
      prompt_bytes: [4096], max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: true, request_usage: false },
    result: { run_id: 'serving-run', status: 'complete', args: ['/private/program', '--api-key', '[REDACTED]'],
      rows: [{ id: 'trial-1', input_bytes: 4096, max_output_tokens: 128, concurrency: 1, repetition: 1,
        first_output_ms: 50, first_content_ms: 100, first_reasoning_ms: 50, e2e_ms: 200,
        content_bytes: 6, reasoning_bytes: 6, output_bytes: 12,
        reported_prompt_tokens: null, reported_completion_tokens: null, reported_cached_tokens: null,
        usage_status: 'missing', finish_reasons: ['not_reported'], peak_memory_bytes: null, timing_source: 'client', failed: false, error: null }],
      provenance: { schema_version: 2, app_version: '0.3.5', method: { id: 'openai-chat-serving', version: 1 },
        workload: { corpus: 'novel_en', corpus_version: 1, inputs: [{ bytes: 4096, sha256: 'a'.repeat(64) }],
          max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: true, request_usage: false, cache_policy: 'as_configured' },
        runtime: { name: null, version: null, backend: null, build: null, variant: null, plugin_version: null },
        model: { format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null },
        recorded_model_label: 'Frozen model display',
        environment: { scope: 'aiolm_host', os: 'linux', arch: 'aarch64', cpu: { name: 'Example CPU', logical_cores: 8 },
          installed_gpus: [], execution: { mode: 'unknown', selected_gpus: [], devices: [], selection_complete: false }, detection: 'private diagnostic' },
        execution: { topology: 'attached', memory_scope: 'unavailable', settings: [
          { target: 'launch', scope: ['serve'], name: 'threads', value: null, unit: 'threads', role: null },
          { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
          { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
          { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
        ] },
      },
    },
  };
}

describe('frozen serving benchmark snapshots', () => {
  beforeEach(() => localStorage.clear());

  it.each(['llama.cpp', 'vllm', 'mlx-vlm', 'sglang', null])('publishes %s with unknown model, usage and setting values', name => {
    const record = serving();
    record.result.provenance!.runtime.name = name;
    const before = structuredClone(record);
    const published = toPublicBenchmark(record, submission);
    expect(published.schema_version).toBe(3);
    expect(published.runtime).toEqual({ name, version: null, backend: null, build: null, variant: null, plugin_version: null });
    expect(published.model).toEqual({ format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null });
    expect(published.execution).toEqual(record.result.provenance!.execution);
    expect(published.workload).toEqual(record.result.provenance!.workload);
    expect(published.measurements.rows[0]).toMatchObject({ output_bytes: 12, reported_completion_tokens: null, usage_status: 'missing' });
    expect(validatePublicBenchmark(published)).toBe(published);
    expect(JSON.stringify(published)).not.toMatch(/private|trial-1|serving-run|recorded_model_label|detection|args/);
    expect(record).toEqual(before);
  });

  it('publishes exact 200k output evidence and rejects unequal requests even when their total matches', () => {
    const record = serving();
    record.request.method.version = 2;
    record.request.max_output_tokens = 204800;
    record.request.concurrencies = [2];
    record.request.request_usage = true;
    const provenance = record.result.provenance!;
    provenance.method.version = 2;
    provenance.workload.max_output_tokens = 204800;
    provenance.workload.concurrencies = [2];
    provenance.workload.request_usage = true;
    provenance.execution.settings = [
      { target: 'request', scope: [], name: 'ignore_eos', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'max_tokens', value: 204800, unit: 'tokens', role: null },
      { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
    ];
    Object.assign(record.result.rows[0], {
      max_output_tokens: 204800, concurrency: 2, reported_completion_tokens: 409600,
      reported_completion_tokens_by_request: [204800, 204800], usage_status: 'partial',
      finish_reasons: ['length', 'stop'],
    });
    expect(isPerformanceRecord(record)).toBe(true);
    const published = toPublicBenchmark(record, submission);
    expect(summarizeServingPoints(published.measurements.rows)[0].reported_tokens_per_second?.median).toBe(2048000);
    expect(validatePublicBenchmark(published)).toBe(published);
    record.result.status = 'partial';
    record.request.max_output_tokens = provenance.workload.max_output_tokens = 131072;
    provenance.execution.settings[1].value = 131072;
    Object.assign(record.result.rows[0], {
      max_output_tokens: 131072, reported_completion_tokens: 262144, reported_completion_tokens_by_request: [65536, 196608],
    });
    expect(isPerformanceRecord(record)).toBe(false);
    record.result.rows[0].reported_completion_tokens_by_request = [131072, 131071];
    record.result.rows[0].reported_completion_tokens = 262143;
    expect(isPerformanceRecord(record)).toBe(false);
    delete record.result.rows[0].reported_completion_tokens_by_request;
    expect(isPerformanceRecord(record)).toBe(false);
  });

  it('keeps the recorded display label independent of live model presentation', () => {
    const record = serving();
    record.model = '/private/replaced-model';
    expect(recordedBenchmarkModelLabel(record)).toBe('Frozen model display');
    delete record.result.provenance;
    expect(recordedBenchmarkModelLabel(record)).toBe('');
    record.result.rows = [];
    record.result.status = 'failed';
    expect(isPerformanceRecord(record)).toBe(true);
  });

  it('retains completed batches and configured workload on partial replay without manufacturing rows', () => {
    const record = serving();
    record.result.status = 'partial';
    record.request.prompt_bytes.push(16384);
    record.result.provenance!.workload.inputs.push({ bytes: 16384, sha256: 'b'.repeat(64) });
    const bytes = JSON.stringify([record]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const replayed = readPerformanceHistory();
    expect(replayed).toEqual([record]);
    expect(summarizeServingPoints(replayed[0].result.rows as typeof record.result.rows)).toEqual([
      expect.objectContaining({ input_bytes: 4096, samples: 1, output_bytes_per_second: { median: 60, min: 60, max: 60, samples: 1 },
        reported_tokens_per_second: null }),
    ]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    expect(() => toPublicBenchmark(record, submission)).toThrow('Only completed benchmarks');
    record.result.rows = [];
    expect(isPerformanceRecord(record)).toBe(true);
    record.result.status = 'complete';
    expect(isPerformanceRecord(record)).toBe(false);
  });

  it('saves new history without rewriting rejected or legacy bytes on reads', () => {
    const record = serving();
    expect(isPerformanceRecord(record)).toBe(true);
    expect(savePerformanceRecord(record)).toEqual([record]);
    const bytes = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
    expect(readPerformanceHistory()).toEqual([record]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    for (const mutate of [
      (r: ServingPerformanceBenchmarkRecord) => { r.result.rows[0].output_bytes = 99; },
      (r: ServingPerformanceBenchmarkRecord) => { r.result.rows[0].reported_completion_tokens = Number.MAX_SAFE_INTEGER + 1; },
      (r: ServingPerformanceBenchmarkRecord) => { r.result.rows[0].input_bytes = 16384; },
      (r: ServingPerformanceBenchmarkRecord) => { r.result.rows.push(structuredClone(r.result.rows[0])); },
      (r: ServingPerformanceBenchmarkRecord) => { r.result.provenance!.runtime.name = '/private/runtime'; },
    ]) {
      const damaged = serving(); mutate(damaged);
      expect(isPerformanceRecord(damaged)).toBe(false);
    }
  });

  it('hides empty cancellation operations and keeps completed cancellation rows unmodified', () => {
    const record = serving(); record.result.status = 'cancelled';
    const empty = structuredClone(record); empty.id = empty.request.run_id = empty.result.run_id = 'empty'; empty.result.rows = [];
    const bytes = JSON.stringify([record, empty]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    expect(readPerformanceHistory()).toEqual([record]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('uses only safe inspected source identities and permits GGUF metadata for an arbitrary engine', () => {
    const record = serving(); const p = record.result.provenance!;
    p.runtime.name = 'sglang';
    p.model = { format: 'gguf', status: 'sha256', sha256: 'c'.repeat(64), size_bytes: 123,
      repository: 'example/model', revision: 'd'.repeat(40), metadata: { format: 'GGUF', name: 'Example model', architecture: null,
        size_label: null, quantization: 'Q4_K_M', file_type: 15, quantized_by: null, repository: null, artifact: null, base_models: [], source: 'gguf' } };
    expect(toPublicBenchmark(record, submission).model).toMatchObject({ source: { kind: 'huggingface', repository: 'example/model', revision: 'd'.repeat(40) }, metadata: { format: 'GGUF' } });
    for (const repository of ['/private/model', 'example/../model', 'example/model?token=secret']) expect(publicModelSource({ ...p.model, repository })).toBeUndefined();
    for (const revision of ['D'.repeat(40), 'main', 'd'.repeat(39)]) expect(publicModelSource({ ...p.model, revision })).toBeUndefined();
    p.model.format = 'hf-safetensors'; p.model.status = 'unidentified'; p.model.sha256 = null;
    expect(toPublicBenchmark(record, submission).model).not.toHaveProperty('metadata');
  });

  it('refuses a changed workload or incomplete grid rather than filling missing observations', () => {
    const record = serving(); record.request.max_output_tokens = 256;
    expect(() => toPublicBenchmark(record, submission)).toThrow('frozen provenance');
    record.request.max_output_tokens = 128; record.result.rows = [];
    expect(() => toPublicBenchmark(record, submission)).toThrow();
  });

  it('projects configuration only using the actual schema version and frozen identity', () => {
    const record = serving();
    const source = localBenchmarkProfileSource(record);
    expect(source).toMatchObject({ source_schema_version: 3, source_omissions: false, runtime: { name: null } });
    expect(publicBenchmarkProfileSource({ id: 'public-run', benchmark: toPublicBenchmark(record, submission) }, 'public-run')).toEqual(source);
    expect(() => publicBenchmarkProfileSource({ id: 'other', benchmark: toPublicBenchmark(record, submission) }, 'public-run')).toThrow();
    expect(() => validateBenchmarkProfileSource({ runtime: source.runtime, execution: source.execution })).toThrow();
    expect(() => validateBenchmarkProfileSource({ schema_version: 3, runtime: { ...source.runtime, private_path: '/private' }, execution: source.execution })).toThrow();
    const legacy = validateBenchmarkProfileSource({ schema_version: 1,
      runtime: { name: 'llama.cpp', version: null, backend: null, build: null },
      execution: { context_size: 4096, parallel: 2, settings: null } });
    expect(legacy).toMatchObject({ source_schema_version: 1, source_omissions: true,
      execution: { topology: 'unknown', settings: [
        { target: 'launch', scope: [], name: 'ctx-size', value: 4096, unit: 'tokens', role: 'context.total_tokens' },
        { target: 'launch', scope: [], name: 'parallel', value: 2, unit: 'count', role: 'concurrency.capacity' },
      ] } });
  });
});
