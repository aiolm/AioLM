import type { LegacyPerformanceBenchmarkResult, PerformanceBenchmarkResult } from '../../shared/api/types';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';

/** A cancelled run only presents completed measurements, including legitimately unknown metrics.
 * Earlier app versions persisted the interrupted trial as an error row before checking cancellation.
 * Other terminal states keep failed trials and their diagnostics.
 */
export function withoutCancelledTrials<T extends PerformanceBenchmarkResult | LegacyPerformanceBenchmarkResult>(result: T): T {
  if (result.status !== 'cancelled') return result;
  const rows = result.rows.filter(row => !row.error && !('failed' in row && row.failed));
  return rows.length === result.rows.length ? result : { ...result, rows };
}

/** Empty cancellations are operations, not measurement results. Original history bytes stay intact on read. */
export function visibleBenchmarkRecords(records: PerformanceBenchmarkRecord[]): PerformanceBenchmarkRecord[] {
  return records.flatMap(record => {
    const result = withoutCancelledTrials(record.result);
    if (result.status === 'cancelled' && !result.rows.length) return [];
    return [result === record.result ? record : { ...record, result } as PerformanceBenchmarkRecord];
  });
}
