import type { Locale } from '../../shared/i18n/i18n';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { summarizePerformanceRows } from '../../shared/contracts/benchmark/aggregation';
import { benchmarkCopy } from './benchmarkCopy';
import { inferenceMetricCopy } from '../../shared/i18n/inferenceMetricCopy';
import { visibleBenchmarkRecords } from './benchmarkCancellation';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

export interface BenchmarkReport {
  sheetName: string;
  columns: Array<{ label: string; width: number; numFmt?: string }>;
  rows: Array<Array<string | number | null>>;
}

const labels = {
  en: { date: 'Measured at' },
  ko: { date: '측정 시각' },
  ja: { date: '測定日時' },
  zh: { date: '测量时间' },
};

/** Same local clock as the history selector, with a sortable spreadsheet representation. */
function measuredAt(value: number): string {
  const date = new Date(value);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function basename(value: string): string {
  return normalizeDisplayText(modelDisplayName(value)).split(/[\\/]/).pop()?.replace(/[\p{Cc}\p{Cf}]/gu, '').trim() ?? '';
}

const finite = (value: number | null | undefined) => value != null && Number.isFinite(value) ? value : null;

/** Export the visible summary measurements, without raw arguments, logs, paths or internal identifiers. */
export function benchmarkReport(records: PerformanceBenchmarkRecord[], locale: Locale = 'en'): BenchmarkReport {
  const copy = benchmarkCopy(locale);
  const text = labels[locale];
  const numeric = (label: string, width = 14, numFmt = '#,##0.0') => ({ label, width, numFmt });
  const unit = (label: string, suffix: string) => `${label} (${suffix})`;
  const columns: BenchmarkReport['columns'] = [
    { label: copy.shareModel, width: 42 },
    { label: text.date, width: 22 },
    { label: copy.shareBackend, width: 14 },
    { label: copy.corpus, width: 20 },
    numeric(copy.promptLengths, 14, '#,##0'),
    numeric(copy.generation, 14, '#,##0'),
    numeric(copy.concurrency, 12, '0'),
    numeric(copy.repeat, 12, '0'),
    numeric(unit(copy.ttft, copy.milliseconds)),
    numeric(unit(copy.tpot, copy.milliseconds), 14, '0.00'),
    numeric(unit(copy.pp, copy.tokens), 26),
    numeric(unit(copy.tg, copy.tokens), 26),
    numeric(unit(inferenceMetricCopy(locale).decodeDeviation, copy.tokens), 26),
    numeric(copy.speedup, 14, '0.00"×"'),
    numeric(unit(copy.e2e, copy.seconds), 14, '0.00'),
    numeric(unit(copy.throughput, copy.tokens), 18),
    numeric(unit(copy.memory, 'GiB'), 18, '0.00'),
    { label: copy.shareStatus, width: 14 },
  ];
  const rows: BenchmarkReport['rows'] = [];
  for (const record of visibleBenchmarkRecords(records)) {
    const { request, result } = record;
    const context = [basename(record.model), measuredAt(record.createdAt), basename(record.backend), copy[request.context_profile]];
    const status = { complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[result.status];
    const summaries = summarizePerformanceRows(result.rows);
    if (!summaries.length) {
      rows.push([...context, ...Array<null>(columns.length - context.length - 1).fill(null), status]);
      continue;
    }
    for (const row of summaries) {
      rows.push([
        ...context, row.prompt_tokens, row.generation_length, row.concurrency, row.samples,
        finite(row.ttft_ms), finite(row.tpot_ms), finite(row.pp_tps), finite(row.tg_tps),
        row.samples > 1 ? finite(row.tg_stddev) : null,
        row.concurrency > 1 ? finite(row.speedup) : null,
        row.error ? null : finite(row.e2e_ms / 1000), finite(row.total_tps),
        row.peak_memory_bytes == null ? null : finite(row.peak_memory_bytes / 1024 ** 3),
        row.error ? copy.failed : status,
      ]);
    }
  }
  return { sheetName: copy.shareResults, columns, rows };
}
