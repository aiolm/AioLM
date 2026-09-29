import type { Locale } from '../../shared/i18n/i18n';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths.ts';
import { formatBytes } from '../../shared/lib/units.ts';
import { formatRecordedRuntimeVersion, formatRuntimeVersion } from '../../shared/runtime/runtimeUtils.ts';
import { benchmarkCopy } from './benchmarkCopy.ts';
import { withoutCancelledTrials } from './benchmarkCancellation';
import { summarizePerformanceRows, type PerformanceBenchmarkRecord, type PerformanceSummary } from './performanceRecords.ts';

type Copy = ReturnType<typeof benchmarkCopy>;

/** Labels the benchmark screen has no string for: it never prints a bare message or an empty-record note. */
const labels: Record<Locale, { message: string; noMeasurements: string }> = {
  en: { message: 'Message', noMeasurements: 'No measurements were recorded.' },
  ko: { message: '메시지', noMeasurements: '기록된 측정 결과가 없습니다.' },
  ja: { message: 'メッセージ', noMeasurements: '記録された測定結果はありません。' },
  zh: { message: '消息', noMeasurements: '没有记录到测量结果。' },
};

/** Server errors can be whole log dumps; keep copied descriptions concise. */
const MAX_TEXT = 200;
// Drive-letter and UNC paths. A backslash-separated directory may contain spaces; a
// slash-separated one may not, so a path never swallows the prose that follows it.
const WINDOWS_PATH = /(?<![A-Za-z0-9])(?:[A-Za-z]:[\\/]+|\\\\+(?=[^\\\s]))(?:[^\\/:*?"<>|]+\\+|[^\\/\s:*?"<>|]+\/+)*([^\\/:*?"<>|\s]*)/g;
const POSIX_PATH = /(?<![\w.~:/\\-])\/(?:[^/\s:*?"<>|]+\/)+([^/\s:*?"<>|]*)/g;
const ESCAPES: Record<string, string> = { '\\': '\\\\', '`': '\\`', '*': '\\*', '[': '\\[', ']': '\\]', '|': '\\|', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/**
 * One line of inert Markdown for text that came from a model file, a runtime or a server.
 * Line breaks are collapsed so the text cannot open a block or end a table row, local
 * directories are reduced to the file name, and the characters that start inline
 * Markdown, HTML or a table cell are escaped.
 */
function markdownText(value: string): string {
  const chars = [...normalizeDisplayText(value).replace(/[\s\p{Cc}]+/gu, ' ').trim()];
  const clipped = chars.length > MAX_TEXT ? `${chars.slice(0, MAX_TEXT - 1).join('')}…` : chars.join('');
  return clipped.replace(WINDOWS_PATH, '$1').replace(POSIX_PATH, '$1').replace(/[\\`*[\]|&<>]/g, (char) => ESCAPES[char]);
}

const fixed = (value: number | null | undefined, unavailable: string, digits = 1) =>
  value == null || !Number.isFinite(value) ? unavailable : value.toFixed(digits);

interface Column { label: string; numeric: boolean; cell: (row: PerformanceSummary) => string }

/** Same columns, precision and missing-value rules as the result tables on the benchmark screen. */
function table(rows: PerformanceSummary[], batch: boolean, copy: Copy, locale: Locale): string[] {
  const count = (value: number) => value.toLocaleString(locale);
  const unit = (label: string, unitLabel: string) => `${label} (${unitLabel})`;
  const columns: Column[] = [
    { label: copy.test, numeric: false, cell: (row) => `${count(row.prompt_tokens)} / ${count(row.generation_length)}${row.error ? ` · ${copy.failed}: ${markdownText(row.error)}` : ''}` },
    ...(batch ? [{ label: copy.concurrency, numeric: true, cell: (row: PerformanceSummary) => `${row.concurrency}×` }] : []),
    { label: copy.repeat, numeric: true, cell: (row) => String(row.samples) },
    { label: unit(copy.ttft, copy.milliseconds), numeric: true, cell: (row) => fixed(row.ttft_ms, copy.unavailable) },
    { label: unit(copy.tpot, copy.milliseconds), numeric: true, cell: (row) => fixed(row.tpot_ms, copy.unavailable, 2) },
    { label: unit(copy.pp, copy.tokens), numeric: true, cell: (row) => fixed(row.pp_tps, copy.unavailable) },
    { label: unit(copy.tg, copy.tokens), numeric: true, cell: (row) => `${fixed(row.tg_tps, copy.unavailable)}${row.samples > 1 && row.tg_stddev != null ? ` ± ${fixed(row.tg_stddev, copy.unavailable)}` : ''}` },
    ...(batch ? [{ label: copy.speedup, numeric: true, cell: (row: PerformanceSummary) => row.speedup == null ? copy.unavailable : `${row.speedup.toFixed(2)}×` }] : []),
    { label: unit(copy.e2e, copy.seconds), numeric: true, cell: (row) => row.error ? copy.unavailable : fixed(row.e2e_ms / 1000, copy.unavailable, 2) },
    { label: unit(copy.throughput, copy.tokens), numeric: true, cell: (row) => fixed(row.total_tps, copy.unavailable) },
    { label: copy.memory, numeric: true, cell: (row) => row.peak_memory_bytes == null || !Number.isFinite(row.peak_memory_bytes) ? copy.unavailable : formatBytes(row.peak_memory_bytes) },
  ];
  return [
    `| ${columns.map((column) => column.label).join(' | ')} |`,
    `| ${columns.map((column) => column.numeric ? '---:' : '---').join(' | ')} |`,
    ...rows.map((row) => `| ${columns.map((column) => column.cell(row)).join(' | ')} |`),
  ];
}

/**
 * Markdown for pasting one benchmark result into an issue, chat or note. Only measured
 * values appear; anything the run did not produce reads as unavailable. The full model
 * path, launch arguments and machine identifiers stay out of the summary.
 */
export function performanceMarkdown(record: PerformanceBenchmarkRecord, locale: Locale): string {
  const copy = benchmarkCopy(locale);
  const { request } = record;
  const result = withoutCancelledTrials(record.result);
  if (result.status === 'cancelled' && !result.rows.length) return '';
  const count = (value: number) => value.toLocaleString(locale);
  const summary = summarizePerformanceRows(result.rows);
  const measured = summary.reduce((sum, row) => sum + row.samples, 0);
  const concurrencies = [...new Set([1, ...request.batch_sizes])];
  const planned = new Set(request.prompt_lengths).size * concurrencies.length * request.repetitions;
  const status = { complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[result.status];
  const runtime = formatRecordedRuntimeVersion(result.runtime_version, record.build ? formatRuntimeVersion(record.build) : '');

  const workload = [
    `- ${copy.corpus}: ${copy[request.context_profile]}`,
    `- ${copy.promptLengths}: ${request.prompt_lengths.map(count).join(' / ')}`,
    `- ${copy.generation}: ${count(request.generation_length)}`,
    `- ${copy.batchSizes}: ${concurrencies.map((value) => `${value}×`).join(' / ')}`,
    `- ${copy.repetitions}: ${request.repetitions}`,
    `- ${copy.warmup}: ${request.warmup ? copy.enabled : copy.disabled}`,
    `- ${copy.totalTests}: ${count(measured)} / ${count(planned)}`,
    ...(result.context_size > 0 ? [`- ${copy.contextSize}: ${count(result.context_size)}`] : []),
    ...(result.parallel > 0 ? [`- ${copy.parallel}: ${count(result.parallel)}`] : []),
  ];
  const results = [[copy.single, summary.filter((row) => row.concurrency === 1), false], [copy.batch, summary.filter((row) => row.concurrency > 1), true]] as const;

  const blocks = [
    `# ${copy.title} · ${markdownText(modelDisplayName(record.model)) || copy.unavailable}`,
    [status, markdownText(record.backend), markdownText(runtime)].filter(Boolean).join(' · '),
    ...(result.message ? [`${labels[locale].message}: ${markdownText(result.message)}`] : []),
    workload.join('\n'),
    ...results.filter(([, rows]) => rows.length > 0).map(([title, rows, batch]) => [`## ${title}`, '', ...table([...rows], batch, copy, locale)].join('\n')),
    summary.length > 0 ? copy.metricsHint : labels[locale].noMeasurements,
  ];
  return `${blocks.join('\n\n')}\n`;
}
