import { validatePublicBenchmark, type BenchmarkModelMetadata, type PublicBenchmarkSubmission, type PublicGpu } from '@aiolm/benchmark-contracts';
import type { BenchmarkContextProfile, BenchmarkGpuSnapshot, PerformanceBenchmarkResult } from '../../api/types.ts';
export * from '@aiolm/benchmark-contracts';

// Hardware/runtime labels are structured descriptions, never paths or diagnostic output.
const safeLabel = (value: unknown): string | null => typeof value === 'string' && value.length > 0 && value.length <= 256
  && /^[^\\/:@\u0000-\u001f\u007f]+$/.test(value) ? value : null;
const safeRepository = (value: unknown): string | null => typeof value === 'string'
  && /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) ? value : null;

function modelMetadata(value: unknown): BenchmarkModelMetadata | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const m = value as Record<string, unknown>;
  if (m.format !== 'GGUF' || !['gguf', 'huggingface', 'gguf+huggingface'].includes(String(m.source))) return null;
  const repository = safeRepository(m.repository);
  if (m.source === 'huggingface' && !repository) return null;
  // Only a matched download receipt may contribute a repository-relative artifact.
  const artifact = repository && m.source !== 'gguf' && typeof m.artifact === 'string' && m.artifact.length <= 512
    && /^(?:[A-Za-z0-9][A-Za-z0-9._ -]{0,127}\/)*[A-Za-z0-9][A-Za-z0-9._ -]*\.[gG][gG][uU][fF]$/.test(m.artifact) ? m.artifact : null;
  return {
    format: 'GGUF', name: safeLabel(m.name), architecture: safeLabel(m.architecture), size_label: safeLabel(m.size_label),
    quantization: safeLabel(m.quantization), quantized_by: safeLabel(m.quantized_by),
    file_type: typeof m.file_type === 'number' && Number.isSafeInteger(m.file_type) && m.file_type >= 0 && m.file_type <= 65535 ? m.file_type : null,
    repository, artifact,
    base_models: Array.isArray(m.base_models) ? [...new Set(m.base_models.map(safeRepository).filter((repo): repo is string => repo !== null))].slice(0, 8) : [],
    source: m.source === 'gguf+huggingface' && !repository ? 'gguf' : m.source as BenchmarkModelMetadata['source'],
  };
}
const gpu = (value: BenchmarkGpuSnapshot): PublicGpu => ({
  name: safeLabel(value.name), vendor: safeLabel(value.vendor), vram_mb: value.vram_mb,
  driver: safeLabel(value.driver), integrated: value.integrated,
});

/** Construct every public field explicitly. Local identifiers and diagnostics never cross this boundary. */
export function toPublicBenchmark(record: {
  backend: string; build: string;
  request: { context_profile: BenchmarkContextProfile; prompt_lengths: number[]; generation_length: number; batch_sizes: number[]; repetitions: number; warmup: boolean };
  result: PerformanceBenchmarkResult;
}, submissionId: string): PublicBenchmarkSubmission {
  const { request, result } = record;
  if (result.status !== 'complete' || result.rows.length === 0 || result.rows.some(row => Boolean(row.error))) {
    throw new Error('Only completed benchmarks with successful measurements can be published.');
  }
  const p = result.provenance?.schema_version === 1 ? result.provenance : undefined;
  if (p && p.corpus.profile !== request.context_profile) throw new Error('Benchmark corpus does not match its provenance.');
  const environment = p?.environment;
  const config = p?.execution_config;
  return validatePublicBenchmark({
    schema_version: 1, submission_id: submissionId, app_version: safeLabel(p?.app_version),
    method: p ? { id: p.method.id, version: p.method.version } : null,
    workload: { corpus: request.context_profile, corpus_version: p?.corpus.version ?? null, corpus_sha256: p?.corpus.sha256 ?? null,
      prompt_lengths: [...request.prompt_lengths], generation_length: request.generation_length, batch_sizes: [...request.batch_sizes], repetitions: request.repetitions, warmup: request.warmup },
    model: p ? { status: p.model.status, sha256: p.model.sha256, size_bytes: p.model.size_bytes,
      ...(p.model.metadata ? { metadata: modelMetadata(p.model.metadata) } : {}),
    } : { status: 'unidentified', sha256: null, size_bytes: null },
    runtime: { name: 'llama.cpp', version: safeLabel(result.runtime_version), backend: safeLabel(record.backend), build: safeLabel(record.build) },
    environment: environment ? { os: safeLabel(environment.os), arch: safeLabel(environment.arch), cpu: { name: safeLabel(environment.cpu.name), logical_cores: environment.cpu.logical_cores },
      ...(environment.system_memory_bytes !== undefined ? { system_memory_bytes: environment.system_memory_bytes } : {}),
      installed_gpus: environment.installed_gpus.map(gpu), execution: { mode: environment.execution.mode, selected_gpus: environment.execution.selected_gpus.map(gpu), selection_complete: environment.execution.selection_complete } } : null,
    execution: { context_size: result.context_size, parallel: result.parallel, settings: config ? {
      gpu_layers: config.gpu_layers, threads: config.threads, threads_batch: config.threads_batch,
      flash_attention: safeLabel(config.flash_attention), cache_type_k: safeLabel(config.cache_type_k), cache_type_v: safeLabel(config.cache_type_v),
      split_mode: safeLabel(config.split_mode), tensor_split: config.tensor_split ? [...config.tensor_split] : null,
    } : null },
    measurements: { status: result.status, rows: result.rows.map(row => ({
      prompt_tokens: row.prompt_tokens, generation_length: row.generation_length, concurrency: row.concurrency, repetition: row.repetition,
      completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, ttft_ms: row.ttft_ms, tpot_ms: row.tpot_ms,
      pp_tps: row.pp_tps, tg_tps: row.tg_tps, e2e_ms: row.e2e_ms, total_tps: row.total_tps,
      peak_memory_bytes: row.peak_memory_bytes, timing_source: row.timing_source, failed: Boolean(row.error),
    })) },
  });
}
