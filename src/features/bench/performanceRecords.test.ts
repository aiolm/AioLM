import { beforeEach, describe, expect, it } from 'vitest';
import type { PerformanceBenchmarkRow } from '../../shared/api/types.ts';
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

  it('retains the newest 20 unique runs without touching engine history', () => {
    localStorage.setItem('aiolm-benchmark-history.v1', '["legacy"]');
    for (let index = 0; index < 22; index++) {
      const next = record();
      next.id = next.request.run_id = next.result.run_id = `perf-${index}`;
      savePerformanceRecord(next);
    }
    const saved = readPerformanceHistory();
    expect(saved).toHaveLength(20);
    expect(saved[0].id).toBe('perf-21');
    expect(saved[saved.length - 1]?.id).toBe('perf-2');
    savePerformanceRecord(saved[0]);
    expect(readPerformanceHistory()).toHaveLength(20);
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

  it('exports empty failures, actual arguments, raw trials, and empty unknown metrics', () => {
    const failed = record();
    failed.result = { ...failed.result, status: 'cancelled', rows: [], message: 'cancelled while loading' };
    const csv = performanceCsv([record(), failed]);
    const lines = csv.trim().split('\r\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('peak_process_ram_bytes');
    expect(lines[1]).toContain('"2304","2","[""--ctx-size"",""2304"",""--parallel"",""2""]"');
    expect(lines[2]).toContain('"cancelled","cancelled while loading"');
    for (const line of lines.slice(1)) expect(line.match(/"(?:[^"]|"")*"/g)).toHaveLength(lines[0].split(',').length);
    expect(csv).not.toContain('undefined');
    expect(csv).not.toContain('NaN');
  });

  it('escapes multiline cells and neutralizes spreadsheet formulas without mutating records', () => {
    const saved = record({ model: '=SUM(1,2)' });
    saved.result.message = 'one "quote"\nand another line';
    const csv = performanceCsv([saved]);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"one ""quote""\nand another line"');
    expect(saved.model).toBe('=SUM(1,2)');
  });
});
