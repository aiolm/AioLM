import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteBenchmarkHistoryRecord, initializeBenchmarkHistory, loadAllBenchmarkHistory, loadBenchmarkHistoryPage, rememberBenchmarkResult } from './benchmarkRepository';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { PERFORMANCE_HISTORY_KEY } from './performanceRecords';
import * as transport from '../../shared/api/transport';
import { servingBenchmark } from '../../testing/servingBenchmark';
import { reconcileAcceptedBenchmarks } from '../../shared/sharing/benchmarkOutbox';
import { takeBenchmarkMaintenanceWarnings } from '../../shared/sharing/desktopBenchmarkStorage';

vi.mock('../../shared/sharing/benchmarkOutbox', () => ({ reconcileAcceptedBenchmarks: vi.fn(async () => 0) }));
vi.mock('../../shared/sharing/desktopBenchmarkStorage', () => ({ takeBenchmarkMaintenanceWarnings: vi.fn(() => []) }));

function record(index: number): PerformanceBenchmarkRecord {
  const saved = servingBenchmark();
  saved.id = saved.request.run_id = saved.result.run_id = `serving-${index}`;
  saved.createdAt = index;
  return saved;
}

describe('benchmark history storage', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(transport, 'isNativeRuntimeAvailable').mockReturnValue(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it('stores and reloads a complete serving record without changing its nullable observations', async () => {
    const saved = servingBenchmark();
    expect(await rememberBenchmarkResult(saved)).toMatchObject({ records: [saved], total: 1, next_offset: null });
    const bytes = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
    expect(await loadAllBenchmarkHistory()).toEqual([saved]);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('removes only the selected browser result and preserves unrelated unreadable entries', async () => {
    const unknown = { schemaVersion: 99, original: 'retained' };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([record(2), unknown, record(1)]));
    await deleteBenchmarkHistoryRecord('serving-2');
    await deleteBenchmarkHistoryRecord('serving-2');
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY)!)).toEqual([unknown, record(1)]);
    expect(await loadAllBenchmarkHistory()).toEqual([record(1)]);
  });

  it('preserves the original history if browser persistence fails', async () => {
    const original = JSON.stringify([record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    await expect(deleteBenchmarkHistoryRecord('serving-1')).rejects.toThrow('storage unavailable');
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
  });

  it('does not replace unreadable browser history with an empty history', async () => {
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, '{unreadable');
    await expect(deleteBenchmarkHistoryRecord('serving-1')).rejects.toThrow();
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe('{unreadable');
  });

  it('delegates native deletion without modifying browser history', async () => {
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(true);
    const invoke = vi.spyOn(transport, 'invoke').mockResolvedValue(undefined);
    const original = JSON.stringify([record(1)]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    await deleteBenchmarkHistoryRecord('serving-1');
    expect(invoke).toHaveBeenCalledExactlyOnceWith('benchmark_history_delete', { runId: 'serving-1' });
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
    invoke.mockRejectedValueOnce(new Error('active run'));
    await expect(deleteBenchmarkHistoryRecord('serving-1')).rejects.toThrow('active run');
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
  });

  it('reads one browser snapshot for a large export while preserving order, duplicate resolution and original bytes', async () => {
    const records = Array.from({ length: 251 }, (_, index) => record(index));
    const replacement = { ...record(150), model: '/models/replacement' };
    const cancelled = record(500);
    cancelled.result.status = 'cancelled';
    cancelled.result.rows = [];
    const bytes = JSON.stringify([...records, { schemaVersion: 99, original: 'retained' }, cancelled, replacement]);
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, bytes);
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const expected = [...records];
    expected[150] = replacement;

    expect(await loadAllBenchmarkHistory()).toEqual(expected);
    expect(getItem).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(bytes);
  });

  it('reads fresh browser history after save and deletion on later exports', async () => {
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([record(1)]));
    expect(await loadAllBenchmarkHistory()).toEqual([record(1)]);
    await rememberBenchmarkResult(record(2));
    expect(await loadAllBenchmarkHistory()).toEqual([record(2), record(1)]);
    await deleteBenchmarkHistoryRecord('serving-1');
    expect(await loadAllBenchmarkHistory()).toEqual([record(2)]);
  });

  it('keeps native exports paginated with duplicate resolution and cursor validation', async () => {
    vi.mocked(transport.isNativeRuntimeAvailable).mockReturnValue(true);
    const cancelled = record(2);
    cancelled.result.status = 'cancelled';
    cancelled.result.rows = [];
    const replacement = { ...record(1), model: '/models/replacement' };
    const invoke = vi.spyOn(transport, 'invoke')
      .mockResolvedValueOnce({ records: [record(1), cancelled], total: 4, next_offset: 2 })
      .mockResolvedValueOnce({ records: [record(3), replacement], total: 4, next_offset: null });

    expect(await loadAllBenchmarkHistory()).toEqual([replacement, record(3)]);
    expect(invoke.mock.calls).toEqual([
      ['benchmark_history_list', { offset: 0, limit: 100 }],
      ['benchmark_history_list', { offset: 2, limit: 100 }],
    ]);
    invoke.mockResolvedValueOnce({ records: [], total: 2, next_offset: 0 });
    await expect(loadAllBenchmarkHistory()).rejects.toThrow('Invalid benchmark history page.');
  });
});

describe('native benchmark history initialization', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.spyOn(transport, 'isNativeRuntimeAvailable').mockReturnValue(true);
    vi.mocked(reconcileAcceptedBenchmarks).mockReset().mockResolvedValue(0);
    vi.mocked(takeBenchmarkMaintenanceWarnings).mockReset().mockReturnValue([]);
  });
  afterEach(() => vi.restoreAllMocks());

  it('lists native history without reading or importing browser history', async () => {
    localStorage.setItem('aiolm-performance-history.v1', JSON.stringify([record(1)]));
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const invoke = vi.spyOn(transport, 'invoke').mockResolvedValue({ records: [record(2)], total: 1, next_offset: null });
    expect(await initializeBenchmarkHistory()).toEqual({ records: [record(2)], total: 1, next_offset: null });
    expect(reconcileAcceptedBenchmarks).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('benchmark_history_list', { offset: 0, limit: 50 });
    expect(getItem).not.toHaveBeenCalled();
  });

  it('keeps reconciliation recovery and maintenance warnings alongside native file warnings', async () => {
    vi.mocked(reconcileAcceptedBenchmarks).mockRejectedValueOnce(new Error('disk unavailable'));
    vi.mocked(takeBenchmarkMaintenanceWarnings).mockReturnValueOnce(['Acknowledgement retained']);
    vi.spyOn(transport, 'invoke').mockResolvedValue({ records: [record(1)], total: 1, next_offset: null, warnings: ['Unreadable journal'] });
    expect(await initializeBenchmarkHistory()).toEqual({
      records: [record(1)], total: 1, next_offset: null, warnings: [
        'Unreadable journal', 'Acknowledgement retained',
        'Local copies of uploaded results could not be updated. Recovery data is retained.',
      ],
    });
  });

  it('omits empty native cancellations without losing the cursor to older measurements', async () => {
    const cancelled = record(2);
    cancelled.result.status = 'cancelled';
    cancelled.result.rows = [];
    const older = record(1);
    vi.spyOn(transport, 'invoke').mockResolvedValue({ records: [cancelled, older], total: 5, next_offset: 2 });
    const page = await loadBenchmarkHistoryPage();
    expect(page.records).toEqual([older]);
    expect(page.next_offset).toBe(2);
    expect(cancelled.result.status).toBe('cancelled');
  });
});
