import { beforeEach, describe, expect, it } from 'vitest';
import type { PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import type { ServingPerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { benchmarkReport } from './benchmarkReport';
import { performanceMarkdown } from './performanceMarkdown';
import { withoutCancelledTrials } from './benchmarkCancellation';
import { defined } from '../../testing/assertDefined';
import { servingBenchmark } from '../../testing/servingBenchmark';
import {
  PERFORMANCE_HISTORY_KEY, isPerformanceRecord, performanceCsv, readPerformanceHistory, savePerformanceRecord,
} from './performanceRecords.ts';

function row(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return { ...defined(servingBenchmark().result.rows[0]), ...overrides };
}

function record(overrides: Partial<ServingPerformanceBenchmarkRecord> = {}): ServingPerformanceBenchmarkRecord {
  const saved = servingBenchmark();
  saved.model = 'C:/models/test.gguf';
  saved.result.provenance!.recorded_model_label = 'test.gguf';
  return { ...saved, ...overrides };
}

describe('performance history and export', () => {
  beforeEach(() => localStorage.clear());

  it.each(['complete', 'partial', 'cancelled', 'failed'] as const)('round-trips fresh-input evidence and rejects reused inputs in %s history', status => {
    const saved = servingBenchmark();
    saved.result.status = status;
    saved.request.request_usage = true;
    saved.request.concurrencies = saved.result.provenance!.workload.concurrencies = [1, 2];
    saved.result.rows.push({ ...defined(saved.result.rows[0]), id: 'parallel', concurrency: 2,
      finish_reasons: ['stop', 'stop'], input_sha256_by_request: ['b'.repeat(64), 'c'.repeat(64)] });
    expect(savePerformanceRecord(saved)).toEqual([saved]);
    expect(readPerformanceHistory()).toEqual([saved]);
    const mutations: Array<(record: ServingPerformanceBenchmarkRecord) => void> = [
      record => { Object.assign(record.request, { warmup: true }); Object.assign(record.result.provenance!.workload, { warmup: true }); },
      record => { Reflect.deleteProperty(record.result.provenance!.workload, 'prompt_nonce'); },
      record => { record.result.provenance!.workload.prompt_nonce += '\n'; },
      record => { record.result.provenance!.workload.inputs[0]!.sha256 = 'f'.repeat(64); },
      record => { Reflect.deleteProperty(defined(record.result.rows[0]), 'input_sha256_by_request'); },
      record => { defined(record.result.rows[1]).input_sha256_by_request = ['b'.repeat(64), 'b'.repeat(64)]; },
      record => { defined(record.result.rows[1]).input_sha256_by_request = ['a'.repeat(64), 'b'.repeat(64)]; },
      record => { defined(record.result.rows[1]).input_sha256_by_request = ['b'.repeat(64), `${'c'.repeat(64)}\n`]; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(saved);
      mutate(changed);
      expect(isPerformanceRecord(changed)).toBe(false);
    }
  });

  it('accepts only local schema 3 and method 5, including for unfinished records', () => {
    for (const status of ['complete', 'partial', 'cancelled', 'failed'] as const) {
      const saved = servingBenchmark();
      saved.result.status = status;
      expect(isPerformanceRecord(saved)).toBe(true);
      for (const version of [1, 2, 4]) {
        expect(isPerformanceRecord({ ...saved, schemaVersion: version })).toBe(false);
      }
      Object.assign(saved.request.method, { version: 4 });
      Object.assign(saved.result.provenance!.method, { version: 4 });
      expect(isPerformanceRecord(saved)).toBe(false);
    }
  });

  it('round-trips early completion without inventing token counts or rates', () => {
    const saved = servingBenchmark();
    expect(savePerformanceRecord(saved)).toEqual([saved]);
    const bytes = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
    expect(readPerformanceHistory()).toEqual([saved]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    const report = benchmarkReport(readPerformanceHistory());
    const values = defined(report.rows[0]);
    const value = (key: string) => values[report.columns.findIndex(column => column.key === key)];
    expect(value('method')).toBe('openai-chat-serving@5');
    expect(value('output_bytes_per_second.median')).toBe(60);
    expect(value('e2e_ms.median')).toBe(200);
    for (const key of ['prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms', 'reported_tokens_per_second']) {
      expect(value(`${key}.median`)).toBeNull();
    }
  });

  it.each(['complete', 'partial', 'cancelled', 'failed'] as const)('preserves negotiated usage without changing frozen workload in %s history', status => {
    const saved = servingBenchmark();
    saved.result.status = status;
    saved.request.request_usage = true;
    expect(savePerformanceRecord(saved)).toEqual([saved]);
    expect(readPerformanceHistory()).toEqual([saved]);
    const changedWarmup = structuredClone(saved);
    Object.assign(changedWarmup.result.provenance!.workload, { warmup: true });
    expect(isPerformanceRecord(changedWarmup)).toBe(false);
    const invalidUsage = structuredClone(saved);
    Object.assign(invalidUsage.result.provenance!.workload, { request_usage: null });
    expect(isPerformanceRecord(invalidUsage)).toBe(false);
    const unrequested = structuredClone(saved);
    unrequested.request.request_usage = false;
    unrequested.result.provenance!.workload.request_usage = true;
    unrequested.result.provenance!.execution.settings.splice(2, 0, {
      target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null,
    });
    expect(isPerformanceRecord(unrequested)).toBe(false);
  });

  it.each(['complete', 'partial', 'cancelled', 'failed'] as const)('enforces the exact request descriptors and output cap in %s history', status => {
    const mutations: Array<(saved: ServingPerformanceBenchmarkRecord) => void> = [
      saved => { saved.request.request_usage = saved.result.provenance!.workload.request_usage = true; },
      saved => { defined(saved.result.provenance!.execution.settings[0]).value = 127; },
      saved => { defined(saved.result.provenance!.execution.settings[0]).unit = null; },
      saved => { defined(saved.result.provenance!.execution.settings[0]).scope = ['serve']; },
      saved => { defined(saved.result.provenance!.execution.settings[0]).role = 'context.total_tokens'; },
      saved => { defined(saved.result.provenance!.execution.settings[1]).value = false; },
      saved => { defined(saved.result.provenance!.execution.settings[2]).value = 1; },
      saved => { saved.result.provenance!.execution.settings.reverse(); },
      saved => { saved.result.provenance!.execution.settings.unshift({ target: 'request', scope: [], name: 'ignore_eos', value: true, unit: null, role: null }); },
      saved => { saved.result.provenance!.execution.settings.unshift({ target: 'request', scope: [], name: 'min_tokens', value: 128, unit: 'tokens', role: null }); },
      saved => { saved.result.provenance!.execution.settings.splice(2, 0, { target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null }); },
      saved => { Object.assign(defined(saved.result.rows[0]), { content_bytes: 12 }); },
      saved => { saved.request.max_output_tokens = saved.result.provenance!.workload.max_output_tokens = defined(saved.result.rows[0]).max_output_tokens = 129; },
    ];
    const valid = servingBenchmark();
    valid.result.status = status;
    expect(isPerformanceRecord(valid)).toBe(true);
    for (const mutate of mutations) {
      const damaged = structuredClone(valid);
      mutate(damaged);
      expect(isPerformanceRecord(damaged)).toBe(false);
    }
  });

  it.each(['complete', 'partial', 'cancelled', 'failed'] as const)('requires usage and timing evidence for rates in %s history', status => {
    const valid = servingBenchmark();
    valid.result.status = status;
    valid.request.request_usage = valid.result.provenance!.workload.request_usage = true;
    valid.result.provenance!.execution.settings.splice(2, 0, {
      target: 'request', scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null,
    });
    Object.assign(defined(valid.result.rows[0]), { usage_status: 'complete', reported_prompt_tokens: 10,
      reported_completion_tokens: 3, prefill_tokens_per_second: 500, decode_tokens_per_second: 10, tpot_ms: 100 });
    expect(isPerformanceRecord(valid)).toBe(true);
    const mutations: Partial<PerformanceBenchmarkRow>[] = [
      { first_output_ms: null }, { reported_prompt_tokens: null, usage_status: 'partial' },
      { reported_completion_tokens: null, usage_status: 'partial' },
      { usage_status: 'missing' }, { usage_status: 'invalid' }, { usage_status: 'partial' },
      { prefill_tokens_per_second: Infinity }, { decode_tokens_per_second: 0 }, { tpot_ms: -1 },
    ];
    for (const mutation of mutations) {
      const changed = structuredClone(valid);
      Object.assign(defined(changed.result.rows[0]), mutation);
      expect(isPerformanceRecord(changed)).toBe(false);
    }
  });

  it('retains independently available prompt usage without inventing generation metrics', () => {
    const saved = servingBenchmark();
    Object.assign(defined(saved.result.rows[0]), {
      usage_status: 'partial', reported_prompt_tokens: 10, prefill_tokens_per_second: 500,
    });
    expect(isPerformanceRecord(saved)).toBe(true);
    expect(savePerformanceRecord(saved)).toEqual([saved]);
    expect(readPerformanceHistory()).toEqual([saved]);
  });

  it.each(['missing', 'invalid', 'partial'] as const)('retains nullable %s usage for a zero-byte completion', usage_status => {
    const saved = servingBenchmark();
    Object.assign(defined(saved.result.rows[0]), { first_output_ms: null, output_bytes: 0, usage_status });
    expect(savePerformanceRecord(saved)).toEqual([saved]);
    expect(readPerformanceHistory()).toEqual([saved]);
  });

  it('never reads pre-cutover browser history and retains every unique current run', () => {
    const oldBytes = JSON.stringify([servingBenchmark()]);
    localStorage.setItem('aiolm-performance-history.v1', oldBytes);
    expect(readPerformanceHistory()).toEqual([]);
    for (let index = 0; index < 22; index++) {
      const next = record();
      next.id = next.request.run_id = next.result.run_id = `perf-${index}`;
      savePerformanceRecord(next);
    }
    const saved = readPerformanceHistory();
    expect(saved).toHaveLength(22);
    expect(defined(saved[0]).id).toBe('perf-21');
    expect(saved[saved.length - 1]?.id).toBe('perf-0');
    savePerformanceRecord(defined(saved[0]));
    expect(readPerformanceHistory()).toHaveLength(22);
    expect(localStorage.getItem('aiolm-performance-history.v1')).toBe(oldBytes);
  });

  it('rejects damaged records without discarding valid failed runs', () => {
    const failed = record();
    failed.result = { ...failed.result, status: 'failed', rows: [], message: 'model cannot load' };
    const damaged = record();
    Object.assign(defined(damaged.result.rows[0]), { tpot_ms: 'bad' });
    const damagedDevice = { ...record(), device: { cpu: { bad: true } } };
    const damagedProfile = { ...record(), request: { ...record().request, context_profile: { toString: null } } };
    const damagedStatus = { ...record(), result: { ...record().result, status: { toString: null } } };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([null, { schemaVersion: 1 }, damaged, damagedDevice, damagedProfile, damagedStatus, failed]));
    expect(readPerformanceHistory()).toEqual([failed]);
  });

  it.each(['{unreadable-history', '{"futureFormat":"retained"}'])('preserves unreadable browser history on save and permits saving after recovery: %s', original => {
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    expect(() => savePerformanceRecord(record())).toThrow();
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
    expect(readPerformanceHistory()).toEqual([]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, '[]');
    expect(savePerformanceRecord(record())).toEqual([record()]);
    expect(readPerformanceHistory()).toEqual([record()]);
  });

  it('updates only a matching valid run and preserves rejected and future-schema entries on subsequent saves', () => {
    const future = { schemaVersion: 99, id: 'serving', recovery: { original: 'retained' } };
    const damaged = { schemaVersion: 3, id: 'damaged', result: { rows: 'unreadable' } };
    const cancelled = record({ id: 'cancelled', request: { ...record().request, run_id: 'cancelled' },
      result: { ...record().result, run_id: 'cancelled', status: 'cancelled', rows: [] } });
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([record(), future, damaged, cancelled]));
    const updated = record({ model: 'models/updated.gguf' });
    expect(savePerformanceRecord(updated)).toEqual([updated]);
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY)!)).toEqual([updated, future, damaged, cancelled]);
    const newer = record({ id: 'newer', request: { ...record().request, run_id: 'newer' }, result: { ...record().result, run_id: 'newer' } });
    savePerformanceRecord(newer);
    expect(readPerformanceHistory()).toEqual([newer, updated]);
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY)!)).toEqual([newer, updated, future, damaged, cancelled]);
  });

  it('exports failure status but omits empty cancellations without leaking paths or logs', () => {
    const failed = record();
    failed.result = { ...failed.result, status: 'failed', rows: [], message: 'cannot load C:/private/models/test.gguf' };
    const cancelled = { ...failed, result: { ...failed.result, status: 'cancelled' as const } };
    const csv = performanceCsv([record(), failed, cancelled]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain('"test.gguf"');
    expect(lines[2]).toContain('"Failed"');
    expect(csv).not.toContain('"Cancelled"');
    expect(performanceMarkdown(cancelled, 'en')).toBe('');
    expect(csv).not.toMatch(/C:|private|models\/|cannot load|--api-key|run_id|effective_args|sha256/);
    for (const line of lines.slice(1)) expect(line.match(/"(?:[^"]|"")*"/g)).toHaveLength(defined(lines[0]).split(',').length);
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('NaN');
  });

  it('omits interrupted trials from cancelled persistence and exports while keeping completed measurements', () => {
    const cancelled = record();
    cancelled.result = { ...cancelled.result, status: 'cancelled', rows: [
      row(),
      row({ id: 'interrupted', input_bytes: 16384, failed: true, error: 'benchmark cancelled' }),
    ] };
    const empty = { ...cancelled, id: 'empty', request: { ...cancelled.request, run_id: 'empty' }, result: { ...cancelled.result, run_id: 'empty', rows: cancelled.result.rows.slice(1) } };
    const completed = { ...cancelled, result: withoutCancelledTrials(cancelled.result) };
    expect(savePerformanceRecord(completed)).toEqual([completed]);
    expect(readPerformanceHistory()).toEqual([completed]);
    expect(benchmarkReport([cancelled, empty]).rows).toHaveLength(1);
    expect(performanceCsv([cancelled, empty])).not.toContain('16384');
    const markdown = performanceMarkdown(cancelled, 'en');
    expect(markdown).toContain('4096');
    expect(markdown).not.toContain('16384');
    expect(markdown).toContain('N/A');
    expect(cancelled.result.rows).toHaveLength(2);
  });

  it('escapes quoted model names and neutralizes spreadsheet formulas without mutating records', () => {
    const saved = record({ model: '=SUM("1",2)' });
    saved.result.provenance!.recorded_model_label = '=SUM("1",2)';
    expect(performanceCsv([saved])).toContain('"\'=SUM(""1"",2)"');
    expect(saved.model).toBe('=SUM("1",2)');
  });

  it.each(['C:\\synthetic\\models\\한글.gguf', '\\\\example\\models\\한글.gguf', '/synthetic/models/한글.gguf'])('exports the frozen model label, never a private path: %s', model => {
    const saved = record({ model });
    saved.result.provenance!.recorded_model_label = '한글.gguf';
    const csv = performanceCsv([saved], 'ko');
    expect(csv).toContain('"모델","측정 시각"');
    expect(csv).toContain('"한글.gguf"');
    expect(csv).not.toMatch(/synthetic|example|models|\\|\/synthetic/);
  });
});
