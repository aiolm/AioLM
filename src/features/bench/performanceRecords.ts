import type { PerformanceBenchmarkRequest, PerformanceBenchmarkResult, PerformanceBenchmarkRow } from '../../shared/api/types.ts';
import { normalizeDisplayText } from '../../shared/lib/displayPaths.ts';
import type { BenchmarkReceipt } from '../../shared/sharing/benchmarkClient.ts';

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
  return inspectLegacyPerformanceHistory().records;
}

/** Throws on unavailable/full storage so the UI can keep the result and offer export. */
export function savePerformanceRecord(record: PerformanceBenchmarkRecord): PerformanceBenchmarkRecord[] {
  const next = [record, ...readPerformanceHistory().filter((item) => item.id !== record.id)];
  localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify(next));
  return next;
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
    'ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'e2e_ms', 'total_tps', 'peak_process_ram_bytes', 'timing_source', 'trial_error',
    'app_version', 'method_id', 'method_version', 'corpus_version', 'corpus_sha256', 'model_sha256', 'model_identity_status', 'model_size_bytes',
    'os', 'arch', 'logical_cpu_cores', 'execution_mode', 'selected_gpus', 'installed_gpus', 'execution_settings'];
  const lines = [columns.join(',')];
  for (const record of records) {
    const { request, result } = record;
    const provenance = result.provenance;
    const environment = provenance?.environment;
    const selectedGpus = environment?.execution?.selected_gpus;
    for (const row of result.rows.length > 0 ? result.rows : [null]) {
      lines.push([
        record.id, new Date(record.createdAt).toISOString(), record.model, record.backend, record.build,
        result.runtime_version, result.status, result.message,
        request.context_profile, request.warmup, request.prompt_lengths.join(';'), request.generation_length,
        request.batch_sizes.join(';'), request.repetitions, result.context_size, result.parallel, JSON.stringify(result.args),
        record.device?.fingerprint, environment?.cpu?.name ?? record.device?.cpu,
        Array.isArray(selectedGpus) ? selectedGpus.map(gpu => gpu?.name).filter(Boolean).join(';') : record.device?.gpu,
        row?.id, row?.prompt_tokens, row?.generation_length, row?.concurrency, row?.repetition,
        row?.completion_tokens, row?.cached_tokens, row?.ttft_ms, row?.tpot_ms, row?.pp_tps, row?.tg_tps,
        row?.e2e_ms, row?.total_tps, row?.peak_memory_bytes, row?.timing_source, row?.error,
        provenance?.app_version, provenance?.method?.id, provenance?.method?.version, provenance?.corpus?.version, provenance?.corpus?.sha256,
        provenance?.model?.sha256, provenance?.model?.status, provenance?.model?.size_bytes,
        environment?.os ?? record.device?.os, environment?.arch ?? record.device?.arch, environment?.cpu?.logical_cores ?? record.device?.cpuThreads,
        environment?.execution?.mode, selectedGpus ? JSON.stringify(selectedGpus) : '', environment?.installed_gpus ? JSON.stringify(environment.installed_gpus) : '',
        provenance?.execution_config ? JSON.stringify(provenance.execution_config) : '',
      ].map(csvCell).join(','));
    }
  }
  return `${lines.join('\r\n')}\r\n`;
}
