import { invoke, isNativeRuntimeAvailable } from '../../shared/api/transport';
import { modelDisplayName } from '../../shared/lib/displayPaths';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkReport } from './benchmarkReport';
import { performanceCsv, type PerformanceBenchmarkRecord } from './performanceRecords';

type ExportScope = 'selected' | 'all';
export type BenchmarkExportFormat = 'xlsx' | 'csv';

function exportFileName(records: PerformanceBenchmarkRecord[], scope: ExportScope, format: BenchmarkExportFormat): string {
  const record = scope === 'selected' ? records[0] : undefined;
  // Use local time, matching the result history shown in the app.
  const date = new Date(record?.createdAt ?? Date.now());
  const pad = (value: number) => String(value).padStart(2, '0');
  const timestamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
  if (scope === 'all') return `aiolm-benchmarks-all_${timestamp}.${format}`;

  const name = modelDisplayName(record?.model ?? '').normalize('NFC').replace(/\.gguf$/i, '')
    .replace(/[<>:"/\\|?*\p{Cc}\p{Cf}]/gu, '-')
    .replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^[. -]+|[. -]+$/g, '');
  // Leave room for the prefix and timestamp even with four-byte Unicode characters.
  const model = [...name].slice(0, 48).join('') || 'model';
  return `aiolm-benchmark_${model}_${timestamp}.${format}`;
}

export async function exportBenchmarkResults(
  records: PerformanceBenchmarkRecord[], scope: ExportScope, format: BenchmarkExportFormat = 'xlsx', locale: Locale = 'en',
): Promise<'saved' | 'cancelled' | 'download-started'> {
  const fileName = exportFileName(records, scope, format);
  let blob: Blob;
  if (format === 'xlsx') {
    const { benchmarkWorkbook } = await import('./benchmarkWorkbook');
    const contents = await benchmarkWorkbook(benchmarkReport(records, locale));
    if (isNativeRuntimeAvailable()) {
      return await invoke<boolean>('benchmark_export_xlsx', { contents: Array.from(contents), fileName }) ? 'saved' : 'cancelled';
    }
    blob = new Blob([new Uint8Array(contents)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  } else {
    const contents = performanceCsv(records, locale);
    if (isNativeRuntimeAvailable()) {
      return await invoke<boolean>('benchmark_export_csv', { contents, fileName }) ? 'saved' : 'cancelled';
    }
    blob = new Blob(['\uFEFF', contents], { type: 'text/csv;charset=utf-8' });
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  try { link.click(); }
  finally {
    link.remove();
    // Give the browser time to consume the URL before releasing its contents.
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  return 'download-started';
}
