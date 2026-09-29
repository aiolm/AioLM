import type { PerformanceBenchmarkRequest, PerformanceBenchmarkResult, PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import { normalizeDisplayText } from '../../shared/lib/displayPaths.ts';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkReport } from './benchmarkReport';
import type { BenchmarkReceipt } from '../../shared/sharing/benchmarkClient.ts';
import { visibleBenchmarkRecords } from './benchmarkCancellation';

export const PERFORMANCE_HISTORY_KEY = 'aiolm-performance-history.v1';
export { summarizePerformanceRows } from '../../shared/contracts/benchmark/aggregation.ts';
export type { PerformanceSummary } from '../../shared/contracts/benchmark/aggregation.ts';

/** Hardware context retained with each measurement; no machine or owner identifiers. */
export interface BenchmarkDevice {
  fingerprint: string;
  os: string;
  arch: string;
  cpu: string;
  cpuThreads: number;
  gpu?: string;
  gpuVendor?: string;
  gpuVramMb?: number;
}

export interface PerformanceBenchmarkRecord {
  localState?: 'recovery' | 'cached';
  remoteReceipt?: BenchmarkReceipt & { destination: string };
  acknowledgedAt?: number;
  schemaVersion: 1;
  id: string;
  createdAt: number;
  model: string;
  backend: string;
  build: string;
  request: PerformanceBenchmarkRequest;
  result: PerformanceBenchmarkResult;
  device?: BenchmarkDevice;
}

const isFiniteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isPositiveInteger = (value: unknown): value is number => isFiniteNonnegative(value) && Number.isInteger(value) && value > 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isDevice(value: unknown): value is BenchmarkDevice {
  return isObject(value)
    && ['fingerprint', 'os', 'arch', 'cpu'].every((key) => typeof value[key] === 'string')
    && isFiniteNonnegative(value.cpuThreads)
    && ['gpu', 'gpuVendor'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.gpuVramMb === undefined || isFiniteNonnegative(value.gpuVramMb));
}

function isRow(value: unknown): value is PerformanceBenchmarkRow {
  return isObject(value) && typeof value.id === 'string'
    && ['prompt_tokens', 'generation_length', 'concurrency', 'repetition'].every((key) => isPositiveInteger(value[key]))
    && ['completion_tokens', 'cached_tokens', 'e2e_ms'].every((key) => isFiniteNonnegative(value[key]))
    && ['ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'total_tps', 'peak_memory_bytes'].every((key) => value[key] === null || isFiniteNonnegative(value[key]))
    && (value.timing_source === 'client' || value.timing_source === 'server')
    && (value.error == null || typeof value.error === 'string');
}

export function isPerformanceRecord(value: unknown): value is PerformanceBenchmarkRecord {
  if (!isObject(value) || value.schemaVersion !== 1 || typeof value.id !== 'string'
      || !isFiniteNonnegative(value.createdAt) || value.createdAt > 8.64e15
      || !['model', 'backend', 'build'].every((key) => typeof value[key] === 'string')
      || (value.device !== undefined && !isDevice(value.device))) return false;
  const request = value.request;
  const result = value.result;
  if (!isObject(request) || !isObject(result)) return false;
  return typeof request.run_id === 'string'
    && Array.isArray(request.prompt_lengths) && request.prompt_lengths.length > 0 && request.prompt_lengths.every(isPositiveInteger)
    && Array.isArray(request.batch_sizes) && request.batch_sizes.every(isPositiveInteger)
    && isPositiveInteger(request.generation_length) && isPositiveInteger(request.repetitions)
    && typeof request.context_profile === 'string'
    && ['code_python', 'code_mixed', 'novel_ko', 'novel_en', 'novel_ja'].includes(request.context_profile)
    && typeof request.warmup === 'boolean' && typeof result.run_id === 'string'
    && result.run_id === request.run_id && value.id === request.run_id
    && Array.isArray(result.rows) && result.rows.every(isRow)
    && typeof result.status === 'string' && ['complete', 'partial', 'cancelled', 'failed'].includes(result.status)
    && Array.isArray(result.args) && result.args.every((item: unknown) => typeof item === 'string')
    && typeof result.runtime_version === 'string'
    && isFiniteNonnegative(result.context_size) && isFiniteNonnegative(result.parallel)
    && (result.message == null || typeof result.message === 'string');
}

export function inspectLegacyPerformanceHistory(): { records: PerformanceBenchmarkRecord[]; rejected: number; unreadable: boolean } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? '[]');
    if (!Array.isArray(value)) return { records: [], rejected: 0, unreadable: true };
    const records = value.filter(isPerformanceRecord);
    return { records, rejected: value.length - records.length, unreadable: false };
  } catch { return { records: [], rejected: 0, unreadable: true }; }
}

export function readPerformanceHistory(): PerformanceBenchmarkRecord[] {
  return visibleBenchmarkRecords(inspectLegacyPerformanceHistory().records);
}

/** Throws on unavailable/full storage so the UI can keep the result and offer export. */
export function savePerformanceRecord(record: PerformanceBenchmarkRecord): PerformanceBenchmarkRecord[] {
  const next = [...visibleBenchmarkRecords([record]), ...readPerformanceHistory().filter((item) => item.id !== record.id)];
  localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify(next));
  return next;
}

/** Delete only the selected valid record, preserving unrelated or unreadable entries. */
export function deletePerformanceRecord(id: string): void {
  const stored = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
  if (stored === null) return;
  const entries: unknown = JSON.parse(stored);
  if (!Array.isArray(entries)) throw new Error('Benchmark history is not readable.');
  const remaining = entries.filter(entry => !isPerformanceRecord(entry) || entry.id !== id);
  if (remaining.length !== entries.length) localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify(remaining));
}

function csvCell(value: unknown): string {
  const text = normalizeDisplayText(String(value ?? ''));
  // Quoting alone does not stop spreadsheets from evaluating a leading formula.
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** The same concise, path-free table is used for both CSV and Excel exports. */
export function performanceCsv(records: PerformanceBenchmarkRecord[], locale: Locale = 'en'): string {
  const report = benchmarkReport(records, locale);
  const rows = [report.columns.map(column => column.label), ...report.rows];
  return `${rows.map(row => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
