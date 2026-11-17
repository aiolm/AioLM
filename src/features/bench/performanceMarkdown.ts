import type { Locale } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { benchmarkCopy } from './benchmarkCopy';
import { benchmarkReport } from './benchmarkReport';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';

const notes: Record<Locale, string> = {
  en: 'Per-point medians of client-observed timings; token metrics are engine-reported and empty when unreported.',
  ko: 'Per-point medians of client-observed timings; token metrics are engine-reported and empty when unreported.',
  ja: 'Per-point medians of client-observed timings; token metrics are engine-reported and empty when unreported.',
  zh: 'Per-point medians of client-observed timings; token metrics are engine-reported and empty when unreported.',
};
const ESCAPES: Record<string, string> = { '\\': '\\\\', '`': '\\`', '*': '\\*', '[': '\\[', ']': '\\]', '|': '\\|', '&': '&amp;', '<': '&lt;', '>': '&gt;' };

/** Inert table/heading text without truncating the frozen data, including public settings. */
function markdownText(value: string): string {
  return normalizeDisplayText(value).replace(/[\r\n\p{Cc}\p{Cf}]/gu, ' ').replace(/[\\`*[\]|&<>]/g, char => ESCAPES[char] ?? char);
}

/** Exactly the same frozen identity and aggregate cells as CSV and XLSX, with Markdown escaping. */
export function performanceMarkdown(record: PerformanceBenchmarkRecord, locale: Locale): string {
  const copy = benchmarkCopy(locale);
  const report = benchmarkReport([record], locale);
  const [firstRow] = report.rows;
  if (!firstRow) return '';
  const text = (value: string | number | null | undefined) => value == null ? copy.unavailable : markdownText(String(value));
  return [
    `# ${copy.title} · ${text(firstRow[0]) || copy.unavailable}`,
    '',
    `| ${report.columns.map(column => markdownText(column.label)).join(' | ')} |`,
    `| ${report.columns.map(column => column.numFmt ? '---:' : '---').join(' | ')} |`,
    ...report.rows.map(row => `| ${row.map(text).join(' | ')} |`),
    '', notes[locale], '',
  ].join('\n');
}
