import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBenchmarkHistoryRecord, loadAllBenchmarkHistory, migrateBenchmarkHistory, type BenchmarkHistoryStore } from './benchmarkRepository';
import { PERFORMANCE_HISTORY_KEY, type PerformanceBenchmarkRecord } from './performanceRecords';
import * as transport from '../../shared/api/transport';

function record(index: number): PerformanceBenchmarkRecord {
  return { schemaVersion: 1, id: `legacy-${index}`, createdAt: index, model: '/models/sample.gguf', backend: 'cpu', build: 'b1',
    request: { run_id: `legacy-${index}`, context_profile: 'novel_en', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
    result: { run_id: `legacy-${index}`, rows: [], status: 'partial', args: [], runtime_version: '1', context_size: 4096, parallel: 1 } };
}

describe('benchmark history deletion', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(transport, 'isNativeRuntimeAvailable').mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it('removes only the selected browser result and preserves unrelated unreadable entries', async () => {
    const unknown = { schemaVersion: 99, original: 'retained' };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([record(2), unknown, record(1)]));
    await deleteBenchmarkHistoryRecord('legacy-2');
    await deleteBenchmarkHistoryRecord('legacy-2');
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY)!)).toEqual([unknown, record(1)]);
    expect(await loadAllBenchmarkHistory()).toEqual([record(1)]);
  });

  it('preserves the original history if browser persistence fails', async () => {
    const original = JSON.stringify([record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    await expect(deleteBenchmarkHistoryRecord('legacy-1')).rejects.toThrow('storage unavailable');
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
  });

  it('does not replace unreadable browser history with an empty history', async () => {
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, '{unreadable');
    await expect(deleteBenchmarkHistoryRecord('legacy-1')).rejects.toThrow();
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe('{unreadable');
  });

  it('delegates native deletion without modifying the preserved legacy backup', async () => {
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(true);
    const invoke = vi.spyOn(transport, 'invoke').mockResolvedValue(undefined);
    const original = JSON.stringify([record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    await deleteBenchmarkHistoryRecord('legacy-1');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('benchmark_history_delete', { runId: 'legacy-1' });
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
    invoke.mockRejectedValueOnce(new Error('active run'));
    await expect(deleteBenchmarkHistoryRecord('legacy-1')).rejects.toThrow('active run');
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
  });
});

describe('native benchmark history migration', () => {
  beforeEach(() => localStorage.clear());

  it('imports every valid legacy record and preserves the original bytes after success', async () => {
    const records = Array.from({ length: 31 }, (_, index) => record(index));
    const bytes = JSON.stringify(records, null, 2);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const store: BenchmarkHistoryStore = { import: vi.fn(async () => records.length), list: vi.fn(async () => ({ records: records.slice(0, 2), total: 31, next_offset: 2 })) };
    const page = await migrateBenchmarkHistory(store);
    expect(store.import).toHaveBeenCalledWith(records);
    expect(page.next_offset).toBe(2);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('leaves legacy records untouched when native persistence fails and retries safely', async () => {
    const bytes = JSON.stringify([record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const store: BenchmarkHistoryStore = { import: vi.fn().mockRejectedValueOnce(new Error('disk unavailable')).mockResolvedValue(1), list: vi.fn(async () => ({ records: [record(1)], total: 1, next_offset: null })) };
    await expect(migrateBenchmarkHistory(store)).rejects.toThrow('disk unavailable');
    expect(store.list).not.toHaveBeenCalled();
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
    expect((await migrateBenchmarkHistory(store)).records).toEqual([record(1)]);
  });

  it('migrates histories larger than one native import page without truncation', async () => {
    const records = Array.from({ length: 251 }, (_, index) => record(index));
    const bytes = JSON.stringify(records);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const store: BenchmarkHistoryStore = { import: vi.fn(async records => records.length), list: vi.fn(async () => ({ records: records.slice(0, 50), total: records.length, next_offset: 50 })) };
    await migrateBenchmarkHistory(store);
    expect(vi.mocked(store.import).mock.calls.map(call => call[0].length)).toEqual([100, 100, 51]);
    expect(vi.mocked(store.import).mock.calls.flatMap(call => call[0])).toEqual(records);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('imports readable records and reports corrupt legacy data without deleting it', async () => {
    const bytes = JSON.stringify([{ schemaVersion: 999 }, record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const store: BenchmarkHistoryStore = { import: vi.fn(async () => 1), list: vi.fn(async () => ({ records: [record(1)], total: 1, next_offset: null })) };
    const page = await migrateBenchmarkHistory(store);
    expect(store.import).toHaveBeenCalledWith([record(1)]);
    expect(page.warnings).toHaveLength(1);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('omits empty native cancellations without losing the cursor to older measurements', async () => {
    const cancelled = record(2);
    cancelled.result.status = 'cancelled';
    const older = record(1);
    const store: BenchmarkHistoryStore = { import: vi.fn(async () => 0), list: vi.fn(async () => ({ records: [cancelled, older], total: 5, next_offset: 2 })) };
    const page = await migrateBenchmarkHistory(store);
    expect(page.records).toEqual([older]);
    expect(page.next_offset).toBe(2);
    expect(cancelled.result.status).toBe('cancelled');
  });
});
