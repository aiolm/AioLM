import { invoke, isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import type { BenchmarkModelIdentity } from '../../shared/api/types.ts';
import { inspectLegacyPerformanceHistory, readPerformanceHistory, savePerformanceRecord, type PerformanceBenchmarkRecord } from './performanceRecords.ts';
import { reconcileAcceptedBenchmarks } from '../../shared/sharing/benchmarkOutbox.ts';
import { takeBenchmarkMaintenanceWarnings } from '../../shared/sharing/desktopBenchmarkStorage.ts';

export interface BenchmarkHistoryPage {
  records: PerformanceBenchmarkRecord[];
  total: number;
  next_offset: number | null;
  warnings?: string[];
}

export interface BenchmarkHistoryStore {
  list(offset: number, limit: number): Promise<BenchmarkHistoryPage>;
  import(records: PerformanceBenchmarkRecord[]): Promise<number>;
}

const nativeStore: BenchmarkHistoryStore = {
  list: (offset, limit) => invoke('benchmark_history_list', { offset, limit }),
  import: records => invoke('benchmark_history_import', { records }),
};

export function loadBenchmarkHistoryPage(offset = 0, limit = 50): Promise<BenchmarkHistoryPage> {
  if (isNativeRuntimeAvailable()) return nativeStore.list(offset, limit);
  const records = readPerformanceHistory();
  return Promise.resolve({ records: records.slice(offset, offset + limit), total: records.length, next_offset: offset + limit < records.length ? offset + limit : null });
}

/** Keep the original localStorage bytes. Native imports are idempotent and never overwrite a native run. */
export async function migrateBenchmarkHistory(store: BenchmarkHistoryStore = nativeStore): Promise<BenchmarkHistoryPage> {
  const legacy = inspectLegacyPerformanceHistory();
  for (let offset = 0; offset < legacy.records.length; offset += 100) await store.import(legacy.records.slice(offset, offset + 100));
  const page = await store.list(0, 50);
  if (legacy.unreadable || legacy.rejected) return { ...page, warnings: [...page.warnings ?? [], 'Some legacy records could not be imported. The original local history is retained.'] };
  return page;
}

export async function initializeBenchmarkHistory(): Promise<BenchmarkHistoryPage> {
  if (!isNativeRuntimeAvailable()) return loadBenchmarkHistoryPage();
  let reconciliationFailed = false;
  try { await reconcileAcceptedBenchmarks(); } catch { reconciliationFailed = true; }
  const page = await migrateBenchmarkHistory();
  const warnings = [...page.warnings ?? [], ...takeBenchmarkMaintenanceWarnings()];
  if (reconciliationFailed) warnings.push('Local copies of uploaded results could not be updated. Recovery data is retained.');
  return warnings.length ? { ...page, warnings } : page;
}

/** Native measurement persistence belongs to the runner, including intermediate trials. */
export function rememberBenchmarkResult(record: PerformanceBenchmarkRecord): Promise<BenchmarkHistoryPage> {
  if (isNativeRuntimeAvailable()) return loadBenchmarkHistoryPage();
  const records = savePerformanceRecord(record);
  return Promise.resolve({ records: records.slice(0, 50), total: records.length, next_offset: records.length > 50 ? 50 : null });
}

export async function loadAllBenchmarkHistory(): Promise<PerformanceBenchmarkRecord[]> {
  const records = new Map<string, PerformanceBenchmarkRecord>();
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await loadBenchmarkHistoryPage(offset, 100);
    for (const record of page.records) records.set(record.id, record);
    if (page.next_offset !== null && page.next_offset <= offset) throw new Error('Invalid benchmark history page.');
    offset = page.next_offset;
  }
  return [...records.values()];
}

export const identifyBenchmarkModel = (path: string) => invoke<BenchmarkModelIdentity>('benchmark_identify_model', { path });
