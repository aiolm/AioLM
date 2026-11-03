import type { LegacyPerformanceBenchmarkRequest, LegacyPerformanceBenchmarkResult, LegacyPerformanceBenchmarkRow, PerformanceBenchmarkRequest, PerformanceBenchmarkResult } from '../../shared/api/types.ts';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths.ts';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkReport } from './benchmarkReport';
import { validateBenchmarkConfiguration, type BenchmarkReceipt } from '@aiolm/benchmark-contracts';
import { visibleBenchmarkRecords } from './benchmarkCancellation';
import { toPublicBenchmark } from '../../shared/contracts/benchmark/publicBenchmark';

export const PERFORMANCE_HISTORY_KEY = 'aiolm-performance-history.v1';
export { summarizePerformanceRows, summarizeServingPoints, servingMetricValues, SERVING_METRIC_KEYS } from '../../shared/contracts/benchmark/aggregation.ts';
export type { PerformanceSummary, ServingBenchmarkPoint, ServingMetricKey } from '../../shared/contracts/benchmark/aggregation.ts';

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

interface PerformanceRecordIdentity {
  localState?: 'recovery' | 'cached';
  remoteReceipt?: BenchmarkReceipt & { destination: string };
  acknowledgedAt?: number;
  id: string;
  createdAt: number;
  model: string;
  device?: BenchmarkDevice;
}

/** Legacy records retain their token-based request/result without migration. */
export interface LegacyPerformanceBenchmarkRecord extends PerformanceRecordIdentity {
  schemaVersion: 1;
  backend: string;
  build: string;
  request: LegacyPerformanceBenchmarkRequest;
  result: LegacyPerformanceBenchmarkResult;
}

export interface ServingPerformanceBenchmarkRecord extends PerformanceRecordIdentity {
  schemaVersion: 2;
  request: PerformanceBenchmarkRequest;
  result: PerformanceBenchmarkResult;
}
export type PerformanceBenchmarkRecord = LegacyPerformanceBenchmarkRecord | ServingPerformanceBenchmarkRecord;
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

function isRow(value: unknown): value is LegacyPerformanceBenchmarkRow {
  return isObject(value) && typeof value.id === 'string'
    && ['prompt_tokens', 'generation_length', 'concurrency', 'repetition'].every((key) => isPositiveInteger(value[key]))
    && ['completion_tokens', 'cached_tokens', 'e2e_ms'].every((key) => isFiniteNonnegative(value[key]))
    && ['ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'total_tps', 'peak_memory_bytes'].every((key) => value[key] === null || isFiniteNonnegative(value[key]))
    && (value.timing_source === 'client' || value.timing_source === 'server')
    && (value.error == null || typeof value.error === 'string');
}

export function isPerformanceRecord(value: unknown): value is PerformanceBenchmarkRecord {
  if (!isObject(value) || ![1, 2].includes(value.schemaVersion as number) || typeof value.id !== 'string'
      || !isFiniteNonnegative(value.createdAt) || value.createdAt > 8.64e15
      || typeof value.model !== 'string'
      || (value.device !== undefined && !isDevice(value.device))) return false;
  const request = value.request;
  const result = value.result;
  if (!isObject(request) || !isObject(result)) return false;
  if (value.schemaVersion === 2) return isServingRecord(value, request, result);
  return typeof value.backend === 'string' && typeof value.build === 'string' && typeof request.run_id === 'string'
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

const boundedInteger = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const count = (value: unknown) => boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
const nullableCount = (value: unknown) => value === null || count(value);
const nullableTime = (value: unknown) => value === null || isFiniteNonnegative(value);
const orderedIntegers = (value: unknown, min: number, max: number): value is number[] => Array.isArray(value)
  && value.length > 0 && value.length <= 64 && value.every((n, i) => boundedInteger(n, min, max) && (i === 0 || n > value[i - 1]));
const methodValid = (value: unknown) => isObject(value) && value.id === 'openai-chat-serving' && value.version === 1
  && Object.keys(value).every(key => key === 'id' || key === 'version');

function isServingRow(value: unknown): boolean {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id.length || value.id.length > 256
    || !Object.keys(value).every(key => ['id', 'input_bytes', 'max_output_tokens', 'concurrency', 'repetition',
      'first_output_ms', 'first_content_ms', 'first_reasoning_ms', 'e2e_ms', 'content_bytes', 'reasoning_bytes', 'output_bytes',
      'reported_prompt_tokens', 'reported_completion_tokens', 'reported_cached_tokens', 'usage_status', 'finish_reasons',
      'peak_memory_bytes', 'timing_source', 'failed', 'error'].includes(key))
    || !boundedInteger(value.input_bytes, 256, 1048576) || !boundedInteger(value.max_output_tokens, 1, 65536)
    || !boundedInteger(value.concurrency, 1, 64) || !boundedInteger(value.repetition, 1, 100)
    || !isFiniteNonnegative(value.e2e_ms) || !['first_output_ms', 'first_content_ms', 'first_reasoning_ms'].every(key => nullableTime(value[key]))
    || !['content_bytes', 'reasoning_bytes', 'output_bytes'].every(key => count(value[key]))
    || value.output_bytes !== (value.content_bytes as number) + (value.reasoning_bytes as number)
    || !['reported_prompt_tokens', 'reported_completion_tokens', 'reported_cached_tokens', 'peak_memory_bytes'].every(key => nullableCount(value[key]))
    || value.timing_source !== 'client' || value.failed !== false || value.error != null
    || !Array.isArray(value.finish_reasons) || value.finish_reasons.length !== value.concurrency
    || !value.finish_reasons.every(reason => ['stop', 'length', 'content_filter', 'tool_calls', 'other', 'not_reported'].includes(reason))) return false;
  const counters = [value.reported_prompt_tokens, value.reported_completion_tokens, value.reported_cached_tokens];
  const known = counters.filter(v => v !== null).length;
  return (value.usage_status === 'complete' ? known === 3 : value.usage_status === 'partial' ? known < 3
    : ['missing', 'invalid'].includes(value.usage_status as string) && known === 0)
    && (value.reported_cached_tokens === null || value.reported_prompt_tokens === null || (value.reported_cached_tokens as number) <= (value.reported_prompt_tokens as number))
    && (value.content_bytes !== 0 || value.first_content_ms === null)
    && (value.reasoning_bytes !== 0 || value.first_reasoning_ms === null)
    && (value.output_bytes !== 0 || value.first_output_ms === null);
}

function isServingRecord(value: Record<string, unknown>, request: Record<string, unknown>, result: Record<string, unknown>): boolean {
  if (!boundedInteger(value.createdAt, 0, 8.64e15) || typeof request.run_id !== 'string' || !request.run_id.length || request.run_id.length > 128
    || request.run_id !== value.id || request.run_id !== result.run_id || !methodValid(request.method)
    || !Object.keys(request).every(key => ['run_id', 'method', 'context_profile', 'prompt_bytes', 'max_output_tokens',
      'concurrencies', 'repetitions', 'warmup', 'request_usage'].includes(key))
    || !orderedIntegers(request.prompt_bytes, 256, 1048576) || !orderedIntegers(request.concurrencies, 1, 64)
    || request.prompt_bytes.length * request.concurrencies.length > 64
    || !boundedInteger(request.max_output_tokens, 1, 65536) || !boundedInteger(request.repetitions, 1, 100)
    || !['code_python', 'code_mixed', 'novel_ko', 'novel_en', 'novel_ja'].includes(request.context_profile as string)
    || typeof request.warmup !== 'boolean' || typeof request.request_usage !== 'boolean'
    || !['complete', 'partial', 'cancelled', 'failed'].includes(result.status as string)
    || (result.message != null && typeof result.message !== 'string')
    || !Array.isArray(result.args) || !result.args.every(arg => typeof arg === 'string')
    || !Array.isArray(result.rows) || result.rows.length > 10000 || !result.rows.every(isServingRow)) return false;
  const p = result.provenance;
  // A launch failure can be journaled before any provenance or observations exist.
  if (p === undefined) return result.rows.length === 0 && result.status !== 'complete';
  if (!isObject(p) || p.schema_version !== 2 || typeof p.app_version !== 'string' || !methodValid(p.method)
    || typeof p.recorded_model_label !== 'string' || !isObject(p.workload) || !isObject(p.environment) || !isObject(p.model)) return false;
  const w = p.workload;
  if (w.corpus !== request.context_profile || w.corpus_version !== 1 || w.cache_policy !== 'as_configured'
    || w.max_output_tokens !== request.max_output_tokens || w.repetitions !== request.repetitions
    || w.warmup !== request.warmup || w.request_usage !== request.request_usage
    || JSON.stringify(w.concurrencies) !== JSON.stringify(request.concurrencies)
    || !Array.isArray(w.inputs) || w.inputs.length !== request.prompt_bytes.length
    || !w.inputs.every((input, index) => isObject(input) && input.bytes === (request.prompt_bytes as number[])[index]
      && typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256))) return false;
  try {
    const configuration = validateBenchmarkConfiguration({ runtime: p.runtime, execution: p.execution });
    const requests = configuration.execution.settings.filter(setting => setting.target === 'request');
    const names = ['max_tokens', 'stream', ...(w.request_usage ? ['stream_options.include_usage'] : []), 'temperature'];
    if (requests.length !== names.length || requests.some((setting, index) => setting.name !== names[index])
      || requests[0].value !== w.max_output_tokens) return false;
  } catch { return false; }
  const model = p.model;
  if (!['gguf', 'hf-safetensors', 'mlx', 'unknown'].includes(model.format as string)
    || !['sha256', 'unidentified', 'multipart'].includes(model.status as string)
    || !nullableCount(model.size_bytes)
    || (model.status === 'sha256' ? typeof model.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(model.sha256) || model.size_bytes === null : model.sha256 !== null)
    || (model.status === 'multipart' && model.size_bytes !== null)
    || (model.format !== 'gguf' && model.metadata != null)) return false;
  const env = p.environment;
  if (env.scope !== 'aiolm_host' || typeof env.os !== 'string' || typeof env.arch !== 'string'
    || !isObject(env.cpu) || typeof env.cpu.name !== 'string' || !count(env.cpu.logical_cores)
    || (env.cpu.physical_cores != null && !boundedInteger(env.cpu.physical_cores, 1, Number.MAX_SAFE_INTEGER))
    || (env.system_memory_bytes != null && !boundedInteger(env.system_memory_bytes, 1, Number.MAX_SAFE_INTEGER))
    || !Array.isArray(env.installed_gpus) || env.installed_gpus.length > 64 || !env.installed_gpus.every(isGpuSnapshot)
    || !isObject(env.execution) || !['cpu', 'selected', 'automatic', 'unknown'].includes(env.execution.mode as string)
    || typeof env.execution.selection_complete !== 'boolean' || !Array.isArray(env.execution.selected_gpus)
    || env.execution.selected_gpus.length > 64 || !env.execution.selected_gpus.every(isGpuSnapshot)
    || !Array.isArray(env.execution.devices) || !env.execution.devices.every(v => typeof v === 'string') || typeof env.detection !== 'string') return false;
  const seen = new Set<string>();
  for (const row of result.rows as Record<string, unknown>[]) {
    const key = `${row.input_bytes}/${row.concurrency}/${row.max_output_tokens}/${row.repetition}`;
    if (!(request.prompt_bytes as number[]).includes(row.input_bytes as number)
      || !(request.concurrencies as number[]).includes(row.concurrency as number)
      || row.max_output_tokens !== request.max_output_tokens || (row.repetition as number) > (request.repetitions as number)
      || seen.has(key) || ((p.execution as Record<string, unknown>).memory_scope === 'unavailable' && row.peak_memory_bytes !== null)) return false;
    seen.add(key);
  }
  if (result.status === 'complete') {
    try { toPublicBenchmark(value as unknown as ServingPerformanceBenchmarkRecord, '00000000-0000-4000-8000-000000000001'); }
    catch { return false; }
  }
  return true;
}

function isGpuSnapshot(value: unknown): boolean {
  return isObject(value) && typeof value.name === 'string' && typeof value.vendor === 'string'
    && nullableCount(value.vram_mb) && (value.driver === null || typeof value.driver === 'string') && typeof value.integrated === 'boolean';
}

export function inspectLegacyPerformanceHistory(): { records: PerformanceBenchmarkRecord[]; rejected: number; unreadable: boolean } {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? '[]');
    if (!Array.isArray(value)) return { records: [], rejected: 0, unreadable: true };
    const records = value.filter(isPerformanceRecord);
    return { records, rejected: value.length - records.length, unreadable: false };
  } catch { return { records: [], rejected: 0, unreadable: true }; }
}

/** New exports use only the private label frozen with the run, never a live presentation lookup. */
export function recordedBenchmarkModelLabel(record: PerformanceBenchmarkRecord): string {
  return record.schemaVersion === 2 ? record.result.provenance?.recorded_model_label ?? '' : record.model;
}

/** UI-only fallback from the run's saved local selection, not current model files or metadata. */
export function benchmarkHistoryModelLabel(record: PerformanceBenchmarkRecord): string {
  return normalizeDisplayText(recordedBenchmarkModelLabel(record) || modelDisplayName(record.model));
}

export function readPerformanceHistory(): PerformanceBenchmarkRecord[] {
  return visibleBenchmarkRecords(inspectLegacyPerformanceHistory().records);
}

/** Preserve unreadable entries like deletion and migration do; a failed save leaves the result exportable. */
export function savePerformanceRecord(record: PerformanceBenchmarkRecord): PerformanceBenchmarkRecord[] {
  const stored = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
  const entries: unknown = stored === null ? [] : JSON.parse(stored);
  if (!Array.isArray(entries)) throw new Error('Benchmark history is not readable.');
  const incoming = visibleBenchmarkRecords([record]);
  if (!incoming.length) return visibleBenchmarkRecords(entries.filter(isPerformanceRecord));
  const next = [...incoming, ...entries.filter(entry => !isPerformanceRecord(entry) || entry.id !== record.id)];
  localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify(next));
  return visibleBenchmarkRecords(next.filter(isPerformanceRecord));
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
