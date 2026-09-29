import { beforeEach, describe, expect, it } from 'vitest';
import type { PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import { benchmarkReport } from './benchmarkReport';
import { performanceMarkdown } from './performanceMarkdown';
import {
  PERFORMANCE_HISTORY_KEY, performanceCsv, readPerformanceHistory, savePerformanceRecord,
  summarizePerformanceRows, type PerformanceBenchmarkRecord,
} from './performanceRecords.ts';

function row(overrides: Partial<PerformanceBenchmarkRow> = {}): PerformanceBenchmarkRow {
  return {
    id: 'single-1', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1,
    completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10,
    pp_tps: 10240, tg_tps: 100, e2e_ms: 1370, total_tps: 93.43,
    peak_memory_bytes: null, timing_source: 'client', ...overrides,
  };
}

function record(overrides: Partial<PerformanceBenchmarkRecord> = {}): PerformanceBenchmarkRecord {
  return {
    schemaVersion: 1, id: 'perf-1', createdAt: Date.UTC(2026, 8, 12),
    model: 'C:/models/test.gguf', backend: 'vulkan', build: 'b10840',
    request: { run_id: 'perf-1', prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 1, context_profile: 'novel_ko', warmup: true },
    result: { run_id: 'perf-1', rows: [row()], status: 'complete', args: ['--ctx-size', '2304', '--parallel', '2'], runtime_version: '10840', context_size: 2304, parallel: 2 },
    ...overrides,
  };
}

describe('performance benchmark aggregation', () => {
  it('computes speedup only from an identical input/output/method baseline', () => {
    const summaries = summarizePerformanceRows([
      row({ id: 'single-4k', prompt_tokens: 4096, tg_tps: 10 }),
      row(), row({ id: 'batch', concurrency: 2, tg_tps: 180 }),
      row({ id: 'batch-16k', prompt_tokens: 16384, concurrency: 2, tg_tps: 90 }),
      row({ id: 'batch-output', generation_length: 256, concurrency: 2, tg_tps: 90 }),
      row({ id: 'batch-server', timing_source: 'server', concurrency: 2, tg_tps: 90 }),
    ]);
    expect(summaries.find((item) => item.id === '1024|128|2|client|')?.speedup).toBe(1.8);
    expect(summaries.filter((item) => item.concurrency === 2 && item.id !== '1024|128|2|client|').every((item) => item.speedup === null)).toBe(true);
  });

  it('preserves repeat samples, ignores replayed events, and uses sample deviation and peak RAM', () => {
    const first = row({ peak_memory_bytes: 1000, tg_tps: 80 });
    const second = row({ id: 'single-2', repetition: 2, peak_memory_bytes: 1500, tg_tps: 120 });
    const [summary] = summarizePerformanceRows([first, first, second]);
    expect(summary.samples).toBe(2);
    expect(summary.tg_tps).toBe(100);
    expect(summary.tg_stddev).toBeCloseTo(Math.sqrt(800));
    expect(summary.peak_memory_bytes).toBe(1500);
    expect(summary.speedup).toBe(1);
  });

  it('does not report missing timing or failed trials as zero speed', () => {
    const summaries = summarizePerformanceRows([
      row(), row({ id: 'single-2', repetition: 2, tg_tps: null }),
      row({ id: 'failed', concurrency: 2, error: 'connection closed', tg_tps: 0 }),
    ]);
    expect(summaries[0].tg_tps).toBeNull();
    expect(summaries[0].tg_stddev).toBeNull();
    expect(summaries[0].speedup).toBeNull();
    expect(summaries[1].samples).toBe(0);
    expect(summaries[1].tg_tps).toBeNull();
    expect(summaries[1].speedup).toBeNull();
  });

  it('withholds cache-contaminated speedup comparisons', () => {
    const summaries = summarizePerformanceRows([row(), row({ id: 'cached', concurrency: 2, cached_tokens: 32, tg_tps: 180 })]);
    expect(summaries[1].speedup).toBeNull();
  });
});

describe('performance history and export', () => {
  beforeEach(() => localStorage.clear());

  it('retains every unique run without touching engine history', () => {
    localStorage.setItem('aiolm-benchmark-history.v1', '["legacy"]');
    for (let index = 0; index < 22; index++) {
      const next = record();
      next.id = next.request.run_id = next.result.run_id = `perf-${index}`;
      savePerformanceRecord(next);
    }
    const saved = readPerformanceHistory();
    expect(saved).toHaveLength(22);
    expect(saved[0].id).toBe('perf-21');
    expect(saved[saved.length - 1]?.id).toBe('perf-0');
    savePerformanceRecord(saved[0]);
    expect(readPerformanceHistory()).toHaveLength(22);
    expect(localStorage.getItem('aiolm-benchmark-history.v1')).toBe('["legacy"]');
  });

  it('rejects damaged records without discarding valid or failed runs', () => {
    const failed = record();
    failed.result = { ...failed.result, status: 'failed', rows: [], message: 'model cannot load' };
    const damaged = record();
    damaged.result.rows = [{ ...row(), tg_tps: 'bad' } as unknown as PerformanceBenchmarkRow];
    const damagedDevice = { ...record(), device: { cpu: { bad: true } } };
    const damagedProfile = { ...record(), request: { ...record().request, context_profile: { toString: null } } };
    const damagedStatus = { ...record(), result: { ...record().result, status: { toString: null } } };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([null, { schemaVersion: 1 }, damaged, damagedDevice, damagedProfile, damagedStatus, failed]));
    expect(readPerformanceHistory()).toEqual([failed]);
  });

  it('exports failure status but omits empty cancellations without leaking paths or logs', () => {
    const failed = record();
    failed.result = { ...failed.result, status: 'failed', rows: [], message: 'cannot load C:/private/models/test.gguf' };
    const cancelled = { ...failed, result: { ...failed.result, status: 'cancelled' as const } };
    const csv = performanceCsv([record(), failed, cancelled]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('Peak process RAM (GiB)');
    expect(lines[1]).toContain('"test.gguf"');
    expect(lines[2]).toContain('"Failed"');
    expect(csv).not.toContain('"Cancelled"');
    expect(performanceMarkdown(cancelled, 'en')).toBe('');
    expect(csv).not.toMatch(/C:|private|models\/|cannot load|--ctx-size|run_id|effective_args|sha256|perf-1/);
    for (const line of lines.slice(1)) expect(line.match(/"(?:[^"]|"")*"/g)).toHaveLength(lines[0].split(',').length);
    expect(lines[0].split(',')).toHaveLength(18);
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('NaN');
  });

  it('omits interrupted trials from cancelled history and exports while keeping completed measurements', () => {
    const cancelled = record();
    cancelled.result = { ...cancelled.result, status: 'cancelled', rows: [
      row(), // Missing RAM is legitimate and does not invalidate a completed measurement.
      row({ id: 'interrupted', prompt_tokens: 16384, completion_tokens: 3, error: 'benchmark cancelled', tg_tps: null }),
    ] };
    const empty = { ...cancelled, id: 'empty', request: { ...cancelled.request, run_id: 'empty' }, result: { ...cancelled.result, run_id: 'empty', rows: cancelled.result.rows.slice(1) } };
    const bytes = JSON.stringify([cancelled, empty]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const visible = readPerformanceHistory();
    expect(visible).toHaveLength(1);
    expect(visible[0].result.rows).toEqual([row()]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    expect(benchmarkReport([cancelled, empty]).rows).toHaveLength(1);
    expect(performanceCsv([cancelled, empty])).not.toContain('16384');
    const markdown = performanceMarkdown(cancelled, 'en');
    expect(markdown).toContain('| 1,024 / 128 |');
    expect(markdown).not.toContain('16,384');
    expect(markdown).toContain('N/A'); // Genuine missing RAM is still represented honestly.
    expect(cancelled.result.rows).toHaveLength(2);
  });

  it('escapes quoted model names and neutralizes spreadsheet formulas without mutating records', () => {
    const saved = record({ model: '=SUM("1",2)' });
    const csv = performanceCsv([saved]);
    expect(csv).toContain('"\'=SUM(""1"",2)"');
    expect(saved.model).toBe('=SUM("1",2)');
  });

  it('shares numeric aggregates and unit conversions between CSV and the workbook', () => {
    const saved = record();
    saved.result.rows = [
      row({ tg_tps: 80, peak_memory_bytes: 1024 ** 3 }),
      row({ id: 'repeat', repetition: 2, tg_tps: 120, peak_memory_bytes: 2 * 1024 ** 3 }),
      row({ id: 'concurrent', concurrency: 2, tg_tps: 180 }),
      row({ id: 'failed', concurrency: 4, error: '/private/models/test.gguf failed', tg_tps: 0 }),
    ];
    const report = benchmarkReport([saved]);
    expect(report.rows).toHaveLength(3);
    const [single, batch, failure] = report.rows;
    expect(single.slice(4, 12)).toEqual([1024, 128, 1, 2, 100, 10, 10240, 100]);
    expect(single[12]).toBeCloseTo(Math.sqrt(800));
    expect(single[14]).toBe(1.37);
    expect(single[16]).toBe(2);
    expect(batch[13]).toBe(1.8);
    expect(failure.slice(8, 17)).toEqual(Array(9).fill(null));
    expect(failure[17]).toBe('Failed');
    expect(performanceCsv([saved]).trim().split('\r\n')).toHaveLength(4);
  });

  it.each(['C:\\synthetic\\models\\한글.gguf', '\\\\example\\models\\한글.gguf', '/synthetic/models/한글.gguf'])('exports only the model basename for %s', model => {
    const csv = performanceCsv([record({ model })], 'ko');
    expect(csv).toContain('"모델","측정 시각"');
    expect(csv).toContain('"한글.gguf"');
    expect(csv).not.toMatch(/synthetic|example|models|\\|\/synthetic/);
  });
});
