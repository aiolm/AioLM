import type { PerformanceBenchmarkRequest, PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import type { BenchmarkDevice, PerformanceBenchmarkRecord, ServingPerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory.ts';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths.ts';
import type { Locale } from '../../shared/i18n/i18n';
import { benchmarkReport } from './benchmarkReport';
import { MAX_SERVING_OUTPUT_TOKENS, validateBenchmarkConfiguration } from '@aiolm/benchmark-contracts';
import { visibleBenchmarkRecords } from './benchmarkCancellation';
import { toPublicBenchmark } from '../../shared/contracts/benchmark/publicBenchmark';

export const PERFORMANCE_HISTORY_KEY = 'aiolm-performance-history.v2';
export { summarizeServingPoints, servingMetricValues, SERVING_METRIC_KEYS } from '../../shared/contracts/benchmark/aggregation.ts';
export type { ServingBenchmarkPoint, ServingMetricKey } from '../../shared/contracts/benchmark/aggregation.ts';

const isFiniteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function isDevice(value: unknown): value is BenchmarkDevice {
  return isObject(value)
    && ['fingerprint', 'os', 'arch', 'cpu'].every((key) => typeof value[key] === 'string')
    && isFiniteNonnegative(value.cpuThreads)
    && ['gpu', 'gpuVendor'].every((key) => value[key] === undefined || typeof value[key] === 'string')
    && (value.gpuVramMb === undefined || isFiniteNonnegative(value.gpuVramMb));
}

export function isPerformanceRecord(value: unknown): value is PerformanceBenchmarkRecord {
  if (!isObject(value) || value.schemaVersion !== 3 || typeof value.id !== 'string'
      || !isFiniteNonnegative(value.createdAt) || value.createdAt > 8.64e15
      || typeof value.model !== 'string'
      || (value.device !== undefined && !isDevice(value.device))) return false;
  const request = value.request;
  const result = value.result;
  if (!isObject(request) || !isObject(result)) return false;
  return isServingRecord(value, request, result);
}

const boundedInteger = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const count = (value: unknown) => boundedInteger(value, 0, Number.MAX_SAFE_INTEGER);
const nullableCount = (value: unknown) => value === null || count(value);
const nullableTime = (value: unknown) => value === null || isFiniteNonnegative(value);
const orderedIntegers = (value: unknown, min: number, max: number): value is number[] => Array.isArray(value)
  && value.length > 0 && value.length <= 64 && value.every((n, i) => boundedInteger(n, min, max) && (i === 0 || n > value[i - 1]));
const methodValid = (value: unknown): value is PerformanceBenchmarkRequest['method'] => isObject(value) && value.id === 'openai-chat-serving' && value.version === 5
  && Object.keys(value).every(key => key === 'id' || key === 'version');

function isServingRow(value: unknown): value is PerformanceBenchmarkRow {
  if (!isObject(value) || typeof value.id !== 'string' || !value.id.length || value.id.length > 256
    || !Object.keys(value).every(key => ['id', 'input_bytes', 'max_output_tokens', 'concurrency', 'repetition',
      'first_output_ms', 'e2e_ms', 'output_bytes', 'reported_prompt_tokens', 'reported_completion_tokens',
      'input_sha256_by_request', 'prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms', 'usage_status', 'finish_reasons',
      'peak_memory_bytes', 'timing_source', 'failed', 'error'].includes(key))
    || !boundedInteger(value.input_bytes, 256, 1048576) || !boundedInteger(value.max_output_tokens, 1, MAX_SERVING_OUTPUT_TOKENS)
    || !boundedInteger(value.concurrency, 1, 64) || !boundedInteger(value.repetition, 1, 100)
    || !isFiniteNonnegative(value.e2e_ms) || !nullableTime(value.first_output_ms) || !count(value.output_bytes)
    || !['reported_prompt_tokens', 'reported_completion_tokens', 'peak_memory_bytes'].every(key => nullableCount(value[key]))
    || !['prefill_tokens_per_second', 'decode_tokens_per_second', 'tpot_ms'].every(key => nullableTime(value[key]))
    || (value.decode_tokens_per_second !== null && (value.decode_tokens_per_second as number) <= 0)
    || (value.tpot_ms !== null && (value.tpot_ms as number) <= 0)
    || value.timing_source !== 'client' || value.failed !== false || value.error != null
    || !Array.isArray(value.finish_reasons) || value.finish_reasons.length !== value.concurrency
    || !value.finish_reasons.every((reason: unknown) => typeof reason === 'string' && ['stop', 'length', 'content_filter', 'tool_calls', 'other', 'not_reported'].includes(reason))) return false;
  const known = [value.reported_prompt_tokens, value.reported_completion_tokens].filter(v => v !== null).length;
  return (value.usage_status === 'complete' ? known === 2 : value.usage_status === 'partial' ? known < 2
    : ['missing', 'invalid'].includes(value.usage_status as string) && known === 0)
    && (value.first_output_ms !== null || value.prefill_tokens_per_second === null && value.decode_tokens_per_second === null && value.tpot_ms === null)
    && (value.reported_prompt_tokens !== null || value.prefill_tokens_per_second === null)
    && (value.reported_completion_tokens !== null || value.decode_tokens_per_second === null && value.tpot_ms === null)
    && (value.output_bytes !== 0 || value.first_output_ms === null)
    && Array.isArray(value.input_sha256_by_request)
    && value.input_sha256_by_request.length === value.concurrency
    && value.input_sha256_by_request.every(hash => typeof hash === 'string' && hash.length === 64 && /^[0-9a-f]{64}$/.test(hash))
    && new Set(value.input_sha256_by_request).size === value.concurrency;
}

function isServingRecord(value: Record<string, unknown>, request: Record<string, unknown>, result: Record<string, unknown>): boolean {
  if (!boundedInteger(value.createdAt, 0, 8.64e15) || typeof request.run_id !== 'string' || !request.run_id.length || request.run_id.length > 128
    || request.run_id !== value.id || request.run_id !== result.run_id || !methodValid(request.method)
    || !Object.keys(request).every(key => ['run_id', 'method', 'context_profile', 'prompt_bytes', 'max_output_tokens',
      'concurrencies', 'repetitions', 'warmup', 'request_usage'].includes(key))
    || !orderedIntegers(request.prompt_bytes, 256, 1048576) || !orderedIntegers(request.concurrencies, 1, 64)
    || request.prompt_bytes.length * request.concurrencies.length > 64
    || !boundedInteger(request.max_output_tokens, 1, MAX_SERVING_OUTPUT_TOKENS) || !boundedInteger(request.repetitions, 1, 100)
    || !['code_python', 'code_mixed', 'novel_ko', 'novel_en', 'novel_ja'].includes(request.context_profile as string)
    || request.warmup !== false || typeof request.request_usage !== 'boolean'
    || !['complete', 'partial', 'cancelled', 'failed'].includes(result.status as string)
    || (result.message != null && typeof result.message !== 'string')
    || !Array.isArray(result.args) || !result.args.every(arg => typeof arg === 'string')
    || (result.engine_args !== undefined && (!Array.isArray(result.engine_args) || !result.engine_args.every(arg => typeof arg === 'string')))
    || (result.engine_args_error !== undefined && typeof result.engine_args_error !== 'string')
    || !Array.isArray(result.rows) || result.rows.length > 10000 || !result.rows.every(isServingRow)) return false;
  const p = result.provenance;
  // A launch failure can be journaled before any provenance or observations exist.
  if (p === undefined) return result.rows.length === 0 && result.status !== 'complete';
  if (!isObject(p) || p.schema_version !== 3 || typeof p.app_version !== 'string' || !methodValid(p.method)
    || p.method.version !== request.method.version || typeof p.recorded_model_label !== 'string' || !isObject(p.workload) || !isObject(p.environment) || !isObject(p.model)) return false;
  const w = p.workload;
  if (w.corpus !== request.context_profile || w.corpus_version !== 2 || w.cache_policy !== 'cold_prompt'
    || typeof w.prompt_nonce !== 'string' || w.prompt_nonce.length !== 32 || !/^[0-9a-f]{32}$/.test(w.prompt_nonce)
    || w.max_output_tokens !== request.max_output_tokens || w.repetitions !== request.repetitions
    || w.warmup !== request.warmup || typeof w.request_usage !== 'boolean'
    // Requests may negotiate usage off, never on.
    || w.request_usage === true && request.request_usage !== true
    || JSON.stringify(w.concurrencies) !== JSON.stringify(request.concurrencies)
    || !Array.isArray(w.inputs) || w.inputs.length !== request.prompt_bytes.length
    || !w.inputs.every((input, index): input is { bytes: number; sha256: string } => isObject(input) && input.bytes === (request.prompt_bytes as number[])[index]
      && typeof input.sha256 === 'string' && input.sha256.length === 64 && /^[0-9a-f]{64}$/.test(input.sha256))) return false;
  try {
    const configuration = validateBenchmarkConfiguration({ runtime: p.runtime, execution: p.execution });
    const requests = configuration.execution.settings.filter(setting => setting.target === 'request');
    const names = ['max_tokens', 'stream', ...(w.request_usage ? ['stream_options.include_usage'] : []), 'temperature'];
    if (requests.length !== names.length || requests.some((setting, index) => setting.name !== names[index])
      || requests.find(setting => setting.name === 'max_tokens')?.value !== w.max_output_tokens) return false;
    if (requests.some(setting => setting.scope.length !== 0 || setting.role !== null
      || (setting.name === 'max_tokens' ? setting.unit !== 'tokens'
        : setting.unit !== null || setting.value !== (setting.name === 'temperature' ? 0 : true)))) return false;
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
  const seenInputHashes = new Set<string>();
  for (const row of result.rows) {
    const key = `${String(row.input_bytes)}/${String(row.concurrency)}/${String(row.max_output_tokens)}/${String(row.repetition)}`;
    if (!request.prompt_bytes.includes(row.input_bytes)
      || !request.concurrencies.includes(row.concurrency)
      || row.max_output_tokens !== request.max_output_tokens || row.repetition > request.repetitions
      || seen.has(key) || ((p.execution as Record<string, unknown>).memory_scope === 'unavailable' && row.peak_memory_bytes !== null)) return false;
    const hashes = row.input_sha256_by_request;
    if (hashes.some(hash => seenInputHashes.has(hash))) return false;
    hashes.forEach(hash => seenInputHashes.add(hash));
    if (row.concurrency === request.concurrencies[0] && row.repetition === 1
      && hashes[0] !== w.inputs.find(input => input.bytes === row.input_bytes)?.sha256) return false;
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

/** New exports use only the private label frozen with the run, never a live presentation lookup. */
export function recordedBenchmarkModelLabel(record: PerformanceBenchmarkRecord): string {
  return record.result.provenance?.recorded_model_label ?? '';
}

/** UI-only fallback from the run's saved local selection, not current model files or metadata. */
export function benchmarkHistoryModelLabel(record: PerformanceBenchmarkRecord): string {
  // Records frozen before part suffixes were grouped still carry the first part's name.
  const recorded = recordedBenchmarkModelLabel(record);
  return normalizeDisplayText(modelDisplayName(recorded || record.model));
}

export function readPerformanceHistory(): PerformanceBenchmarkRecord[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? '[]');
    return Array.isArray(value) ? visibleBenchmarkRecords(value.filter(isPerformanceRecord)) : [];
  } catch { return []; }
}

/** Preserve unreadable entries; a failed save leaves the result exportable. */
export function savePerformanceRecord(record: PerformanceBenchmarkRecord): PerformanceBenchmarkRecord[] {
  const stored = localStorage.getItem(PERFORMANCE_HISTORY_KEY);
  const entries: unknown = stored === null ? [] : JSON.parse(stored);
  if (!Array.isArray(entries)) throw new Error('Benchmark history is not readable.');
  const history: unknown[] = entries;
  const incoming = visibleBenchmarkRecords([record]);
  if (!incoming.length) return visibleBenchmarkRecords(history.filter(isPerformanceRecord));
  const next = [...incoming, ...history.filter(entry => !isPerformanceRecord(entry) || entry.id !== record.id)];
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

function csvCell(value: string | number | null): string {
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
