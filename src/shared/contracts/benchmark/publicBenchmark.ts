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

/**
 * llama-server options whose value names this machine rather than the tuning
 * setup: its files, its listening address, its credentials or its prompt text.
 * Each is dropped together with its value, so a published launch carries only
 * settings another reader can apply. `safeArgument` independently rejects any
 * token that still reads as a path, URL or address, which also covers options
 * a newer runtime adds after this list was written.
 */
const PRIVATE_OPTIONS: ReadonlySet<string> = new Set([
  '-m', '--model', '-mu', '--model-url', '-md', '--model-draft', '--spec-draft-model',
  '-mm', '--mmproj', '-mmu', '--mmproj-url',
  '-hf', '-hfr', '--hf-repo', '-hff', '--hf-file', '-hft', '--hf-token',
  '--lora', '--lora-scaled', '--control-vector', '--control-vector-scaled',
  '--grammar-file', '-jf', '--json-schema-file', '--chat-template-file',
  '-lcs', '--lookup-cache-static', '-lcd', '--lookup-cache-dynamic',
  '--log-file', '--log-prompts-dir', '--slot-save-path', '--media-path',
  '--models-dir', '--models-preset', '--video-ffmpeg-dir',
  '--ui-config-file', '--webui-config-file', '--mcp-servers-config',
  '--api-key', '--api-key-file', '--ssl-key-file', '--ssl-cert-file',
  '--host', '--port', '--path', '--api-prefix', '-a', '--alias',
  '-r', '--reverse-prompt',
]);
/**
 * The secret-argument shape this repository already refuses to copy into saved
 * profiles, matched on any name segment so an option a newer runtime adds is
 * covered too. A credential is short, ordinary text that no value pattern can
 * tell apart from a setting, so it has to be recognized by its option name.
 */
const SECRET_OPTION = /(?:^|[-_])(?:api[-_]?key|key|token|secret|password|passphrase|credential|authorization|auth)(?:[-_]file)?$/i;
const MAX_PUBLISHED_ARGUMENTS = 256;
const isOption = (token: string) => /^--?[a-zA-Z]/.test(token);
// The contract's token pattern: no path separator, scheme, address or control.
const safeArgument = (token: string) => token.length > 0 && token.length <= 128
  && /^[^\\/:@\u0000-\u001f\u007f]+$/.test(token);

/**
 * The measured launch as ordered tokens, so a reader can reproduce the setup
 * instead of inferring it from the curated settings. An option and its value
 * are published together or not at all; a half-reported option would read as a
 * switch the run never used.
 */
function effectiveArguments(args: readonly string[]): string[] | null {
  if (!args.length) return null;
  const published: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const [name] = args[index].split('=', 1);
    // A following token that does not begin another option is this option's value.
    const pair = isOption(args[index]) && !args[index].includes('=') && index + 1 < args.length && !isOption(args[index + 1])
      ? [args[index], args[index + 1]] : [args[index]];
    index += pair.length - 1;
    if (PRIVATE_OPTIONS.has(name) || SECRET_OPTION.test(name.replace(/^--?/, '')) || !pair.every(safeArgument)) continue;
    if (published.length + pair.length > MAX_PUBLISHED_ARGUMENTS) break;
    published.push(...pair);
  }
  return published;
}

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
  const args = effectiveArguments(result.args ?? []);
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
    } : null, ...(args ? { effective_args: args } : {}) },
    measurements: { status: result.status, rows: result.rows.map(row => ({
      prompt_tokens: row.prompt_tokens, generation_length: row.generation_length, concurrency: row.concurrency, repetition: row.repetition,
      completion_tokens: row.completion_tokens, cached_tokens: row.cached_tokens, ttft_ms: row.ttft_ms, tpot_ms: row.tpot_ms,
      pp_tps: row.pp_tps, tg_tps: row.tg_tps, e2e_ms: row.e2e_ms, total_tps: row.total_tps,
      peak_memory_bytes: row.peak_memory_bytes, timing_source: row.timing_source, failed: Boolean(row.error),
    })) },
  });
}
