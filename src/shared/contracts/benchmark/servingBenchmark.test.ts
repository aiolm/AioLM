import { beforeEach, describe, expect, it } from 'vitest';
import { publicModelSource, toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import { localBenchmarkProfileSource, publicBenchmarkProfileSource, validateBenchmarkProfileSource } from './configuration';
import { summarizeServingPoints } from './aggregation';
import type { ServingPerformanceBenchmarkRecord } from '../../api/benchmarkHistory';
import { PERFORMANCE_HISTORY_KEY, isPerformanceRecord, readPerformanceHistory, recordedBenchmarkModelLabel, savePerformanceRecord } from '../../../features/bench/performanceRecords';
import { defined } from '../../../testing/assertDefined';
import { servingBenchmark as serving } from '../../../testing/servingBenchmark';
import { createPublicationBody, parseStoredPublicationBody } from './publication';

const submission = '00000000-0000-4000-8000-000000000025';

describe('frozen serving benchmark snapshots', () => {
  beforeEach(() => localStorage.clear());
  it('retains Cold Prompt input evidence and negotiated usage through reviewed publication', () => {
    const record = serving();
    record.request.request_usage = true;
    expect(isPerformanceRecord(record)).toBe(true);
    const published = toPublicBenchmark(record, submission);
    expect(published.schema_version).toBe(4);
    expect(published.method.version).toBe(5);
    expect(published.workload).toEqual(record.result.provenance!.workload);
    expect(defined(published.measurements.rows[0]).input_sha256_by_request).toEqual(defined(record.result.rows[0]).input_sha256_by_request);
    const body = createPublicationBody({ benchmark: published, description_md: '' });
    expect(parseStoredPublicationBody(body.body).benchmark).toEqual(published);
    expect(body.body).not.toMatch(/PRIVATE|private|synthetic|diagnostic|args|recorded_model_label/);
  });

  it.each([1, 128])('preserves the supported %i-token request cap', cap => {
    const record = serving();
    record.request.max_output_tokens = record.result.provenance!.workload.max_output_tokens = cap;
    defined(record.result.provenance!.execution.settings[0]).value = cap;
    defined(record.result.rows[0]).max_output_tokens = cap;
    expect(isPerformanceRecord(record)).toBe(true);
    expect(toPublicBenchmark(record, submission).workload.max_output_tokens).toBe(cap);
  });

  it.each([0, 129])('rejects a request cap of %i without changing the record', cap => {
    const record = serving();
    record.request.max_output_tokens = record.result.provenance!.workload.max_output_tokens = cap;
    defined(record.result.provenance!.execution.settings[0]).value = cap;
    defined(record.result.rows[0]).max_output_tokens = cap;
    const before = structuredClone(record);
    expect(isPerformanceRecord(record)).toBe(false);
    expect(() => toPublicBenchmark(record, submission)).toThrow();
    expect(record).toEqual(before);
  });

  it('publishes per-request rates with their frozen usage evidence', () => {
    const record = serving();
    record.request.request_usage = record.result.provenance!.workload.request_usage = true;
    record.result.provenance!.execution.settings.splice(2, 0, {
      target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null,
    });
    Object.assign(defined(record.result.rows[0]), {
      reported_prompt_tokens: 50, reported_completion_tokens: 11, usage_status: 'complete',
      prefill_tokens_per_second: 2500, decode_tokens_per_second: 1000 / 18, tpot_ms: 18,
    });
    expect(isPerformanceRecord(record)).toBe(true);
    expect(toPublicBenchmark(record, submission).measurements.rows[0]).toMatchObject({
      prefill_tokens_per_second: 2500, decode_tokens_per_second: 1000 / 18, tpot_ms: 18,
      reported_prompt_tokens: 50, reported_completion_tokens: 11, usage_status: 'complete',
    });
  });



  it.each(['llama.cpp', 'vllm', 'mlx-vlm', 'sglang', null])('publishes %s with unknown model, usage and setting values', name => {
    const record = serving();
    record.result.provenance!.runtime.name = name;
    const before = structuredClone(record);
    const published = toPublicBenchmark(record, submission);
    expect(published.schema_version).toBe(4);
    expect(published.runtime).toEqual({ name, version: null, backend: null, build: null, variant: null, plugin_version: null });
    expect(published.model).toEqual({ format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null });
    expect(published.execution).toEqual(record.result.provenance!.execution);
    expect(published.workload).toEqual(record.result.provenance!.workload);
    expect(published.measurements.rows[0]).toMatchObject({ output_bytes: 12, reported_completion_tokens: null, usage_status: 'missing' });
    expect(validatePublicBenchmark(published)).toBe(published);
    expect(JSON.stringify(published)).not.toMatch(/private|trial-1|serving-run|recorded_model_label|detection|args/);
    expect(record).toEqual(before);
  });


  it('keeps the recorded display label independent of live model presentation', () => {
    const record = serving();
    record.model = '/private/replaced-model';
    expect(recordedBenchmarkModelLabel(record)).toBe('Serving model');
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
    expect(summarizeServingPoints(defined(replayed[0]).result.rows)).toEqual([
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

  it('saves new history without rewriting stored bytes on reads', () => {
    const record = serving();
    expect(isPerformanceRecord(record)).toBe(true);
    expect(savePerformanceRecord(record)).toEqual([record]);
    const bytes = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
    expect(readPerformanceHistory()).toEqual([record]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    for (const mutate of [
      (r: ServingPerformanceBenchmarkRecord) => { defined(r.result.rows[0]).reported_completion_tokens = Number.MAX_SAFE_INTEGER + 1; },
      (r: ServingPerformanceBenchmarkRecord) => { defined(r.result.rows[0]).input_bytes = 16384; },
      (r: ServingPerformanceBenchmarkRecord) => { r.result.rows.push(structuredClone(defined(r.result.rows[0]))); },
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
    expect(source).toMatchObject({ source_schema_version: 4, source_omissions: false, runtime: { name: 'Example engine' } });
    expect(publicBenchmarkProfileSource({ id: 'public-run', benchmark: toPublicBenchmark(record, submission) }, 'public-run')).toEqual(source);
    expect(() => publicBenchmarkProfileSource({ id: 'other', benchmark: toPublicBenchmark(record, submission) }, 'public-run')).toThrow();
    expect(() => validateBenchmarkProfileSource({ runtime: source.runtime, execution: source.execution })).toThrow();
    expect(() => validateBenchmarkProfileSource({ schema_version: 4, runtime: { ...source.runtime, private_path: '/private' }, execution: source.execution })).toThrow();
    for (const schema_version of [1, 2, 3]) {
      expect(() => validateBenchmarkProfileSource({ schema_version, runtime: source.runtime, execution: source.execution })).toThrow('Unsupported');
    }
  });
});
