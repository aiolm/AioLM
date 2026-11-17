import { isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import { benchmarkHistoryDelete, benchmarkHistoryList, type BenchmarkHistoryPage, type PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory.ts';
import { deletePerformanceRecord, readPerformanceHistory, savePerformanceRecord } from './performanceRecords.ts';
import { reconcileAcceptedBenchmarks } from '../../shared/sharing/benchmarkOutbox.ts';
import { takeBenchmarkMaintenanceWarnings } from '../../shared/sharing/desktopBenchmarkStorage.ts';
import { visibleBenchmarkRecords } from './benchmarkCancellation';

const visiblePage = (page: BenchmarkHistoryPage): BenchmarkHistoryPage => ({ ...page, records: visibleBenchmarkRecords(page.records) });

export function loadBenchmarkHistoryPage(offset = 0, limit = 50): Promise<BenchmarkHistoryPage> {
  if (isNativeRuntimeAvailable()) return benchmarkHistoryList(offset, limit).then(visiblePage);
  const records = readPerformanceHistory();
  return Promise.resolve({ records: records.slice(offset, offset + limit), total: records.length, next_offset: offset + limit < records.length ? offset + limit : null });
}

export async function initializeBenchmarkHistory(): Promise<BenchmarkHistoryPage> {
  if (!isNativeRuntimeAvailable()) return loadBenchmarkHistoryPage();
  let reconciliationFailed = false;
  try { await reconcileAcceptedBenchmarks(); } catch { reconciliationFailed = true; }
  const page = await loadBenchmarkHistoryPage();
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

/** Native deletion is owned by the history store. */
export async function deleteBenchmarkHistoryRecord(runId: string): Promise<void> {
  if (isNativeRuntimeAvailable()) await benchmarkHistoryDelete(runId);
  else deletePerformanceRecord(runId);
}

export async function loadAllBenchmarkHistory(): Promise<PerformanceBenchmarkRecord[]> {
  const records = new Map<string, PerformanceBenchmarkRecord>();
  // Browser storage already provides the complete snapshot; paging would parse it again.
  if (!isNativeRuntimeAvailable()) {
    for (const record of readPerformanceHistory()) records.set(record.id, record);
    return [...records.values()];
  }
  let offset: number | null = 0;
  while (offset !== null) {
    const page = await loadBenchmarkHistoryPage(offset, 100);
    for (const record of page.records) records.set(record.id, record);
    if (page.next_offset !== null && page.next_offset <= offset) throw new Error('Invalid benchmark history page.');
    offset = page.next_offset;
  }
  return [...records.values()];
}
