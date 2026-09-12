import type { PerformanceBenchmarkRequest, PerformanceBenchmarkResult, PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import { normalizeDisplayText } from '../../shared/lib/displayPaths.ts';

export const PERFORMANCE_HISTORY_KEY = 'aiolm-performance-history.v1';
export const PERFORMANCE_HISTORY_LIMIT = 20;

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

export interface PerformanceSummary extends PerformanceBenchmarkRow {
  samples: number;
  /** Sample standard deviation; unavailable with fewer than two measured trials. */
  tg_stddev: number | null;
  speedup: number | null;
}

const numericMetrics = ['ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'total_tps', 'peak_memory_bytes'] as const;
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
    && numericMetrics.every((key) => value[key] === null || isFiniteNonnegative(value[key]))
    && (value.timing_source === 'client' || value.timing_source === 'server')
    && (value.error == null || typeof value.error === 'string');
}

function isRecord(value: unknown): value is PerformanceBenchmarkRecord {
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

export function readPerformanceHistory(): PerformanceBenchmarkRecord[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter(isRecord).slice(0, PERFORMANCE_HISTORY_LIMIT) : [];
  } catch { return []; }
}

/** Throws on unavailable/full storage so the UI can keep the result and offer export. */
export function savePerformanceRecord(record: PerformanceBenchmarkRecord): PerformanceBenchmarkRecord[] {
  const next = [record, ...readPerformanceHistory().filter((item) => item.id !== record.id)].slice(0, PERFORMANCE_HISTORY_LIMIT);
  localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify(next));
  return next;
}

const measured = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const mean = (values: Array<number | null>): number | null => {
  // A missing sample makes the aggregate unmeasured too; never turn unknown into zero.
  if (values.length === 0 || !values.every(measured)) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

function stddev(values: Array<number | null>): number | null {
  const average = mean(values);
  if (average === null || values.length < 2 || !values.every(measured)) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

/** Group only identical workloads and timing methods. Failed rows never become speed samples. */
export function summarizePerformanceRows(rows: PerformanceBenchmarkRow[]): PerformanceSummary[] {
  const groups = new Map<string, PerformanceBenchmarkRow[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const key = [row.prompt_tokens, row.generation_length, row.concurrency, row.timing_source, row.error ?? ''].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const summaries = [...groups.values()].map((group): PerformanceSummary => {
    const first = group[0];
    const usable = group.filter((row) => !row.error);
    const result: PerformanceSummary = {
      ...first,
      id: [first.prompt_tokens, first.generation_length, first.concurrency, first.timing_source, first.error ?? ''].join('|'),
      repetition: 0,
      samples: usable.length,
      completion_tokens: mean(usable.map((row) => row.completion_tokens)) ?? 0,
      cached_tokens: mean(usable.map((row) => row.cached_tokens)) ?? 0,
      e2e_ms: mean(usable.map((row) => row.e2e_ms)) ?? first.e2e_ms,
      tg_stddev: stddev(usable.map((row) => row.tg_tps)),
      speedup: null,
    };
    for (const key of numericMetrics) result[key] = mean(usable.map((row) => row[key]));
    const memory = usable.map((row) => row.peak_memory_bytes);
    result.peak_memory_bytes = memory.length > 0 && memory.every(measured) ? Math.max(...memory) : null;
    return result;
  }).sort((a, b) => a.prompt_tokens - b.prompt_tokens || a.concurrency - b.concurrency || a.generation_length - b.generation_length);

  for (const row of summaries) {
    const baseline = summaries.find((candidate) => candidate.concurrency === 1 && !candidate.error
      && candidate.prompt_tokens === row.prompt_tokens && candidate.generation_length === row.generation_length
      && candidate.timing_source === row.timing_source);
    if (!row.error && row.cached_tokens === 0 && baseline?.cached_tokens === 0
        && row.tg_tps !== null && baseline.tg_tps !== null && baseline.tg_tps > 0) {
      row.speedup = row.tg_tps / baseline.tg_tps;
    }
  }
  return summaries;
}

function csvCell(value: unknown): string {
  const text = normalizeDisplayText(String(value ?? ''));
  // Quoting alone does not stop spreadsheets from evaluating a leading formula.
  const safe = /^[\s]*[=+@-]/.test(text) ? `'${text}` : text;
  return `"${safe.replace(/"/g, '""')}"`;
}

/** Export raw trials and failed/empty runs, together with their actual server configuration. */
export function performanceCsv(records: PerformanceBenchmarkRecord[]): string {
  const columns = ['run_id', 'created_at', 'model', 'backend', 'build', 'runtime_version', 'status', 'message',
    'context_profile', 'warmup', 'requested_prompt_lengths', 'requested_generation_length', 'requested_batch_sizes', 'repetitions',
    'context_size', 'parallel', 'effective_args', 'device', 'cpu', 'gpu',
    'trial_id', 'prompt_tokens', 'generation_length', 'concurrency', 'repetition', 'completion_tokens', 'cached_tokens',
    'ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'e2e_ms', 'total_tps', 'peak_process_ram_bytes', 'timing_source', 'trial_error'];
  const lines = [columns.join(',')];
  for (const record of records) {
    const { request, result } = record;
    for (const row of result.rows.length > 0 ? result.rows : [null]) {
      lines.push([
        record.id, new Date(record.createdAt).toISOString(), record.model, record.backend, record.build,
        result.runtime_version, result.status, result.message,
        request.context_profile, request.warmup, request.prompt_lengths.join(';'), request.generation_length,
        request.batch_sizes.join(';'), request.repetitions, result.context_size, result.parallel, JSON.stringify(result.args),
        record.device?.fingerprint, record.device?.cpu, record.device?.gpu,
        row?.id, row?.prompt_tokens, row?.generation_length, row?.concurrency, row?.repetition,
        row?.completion_tokens, row?.cached_tokens, row?.ttft_ms, row?.tpot_ms, row?.pp_tps, row?.tg_tps,
        row?.e2e_ms, row?.total_tps, row?.peak_memory_bytes, row?.timing_source, row?.error,
      ].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
