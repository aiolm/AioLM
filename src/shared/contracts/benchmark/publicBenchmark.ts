import { validatePublicBenchmark, type BenchmarkModelMetadata, type LegacyPublicBenchmarkSubmission, type ServingPublicBenchmarkSubmission, type PublicBenchmarkSubmission, type PublicGpu, type ServingBenchmarkRow } from '@aiolm/benchmark-contracts';
import type { BenchmarkModelIdentity, LegacyPerformanceBenchmarkRequest, LegacyPerformanceBenchmarkResult, PerformanceBenchmarkRequest, PerformanceBenchmarkResult, BenchmarkGpuSnapshot } from '../../api/types.ts';
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
/**
 * llama.cpp reports its version as a banner - `version: 0.3.0-dev (build 10638,
 * commit bf9421646)` - followed by the compiler it was built with. A record
 * written before that banner was reduced to its version line still carries the
 * whole thing, which is diagnostic output rather than a version anyone can
 * compare, and the contract's label pattern rejects it. Publish the version
 * line's own text in that case, so the release the run measured survives; a
 * banner with no version line publishes none rather than something assembled.
 */
function runtimeVersion(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const direct = safeLabel(value.trim());
  if (direct) return direct;
  const line = value.split('\n').find(entry => entry.includes('version:'));
  return line ? safeLabel(line.slice(line.indexOf('version:') + 'version:'.length).trim()) : null;
}
const cpu = (value: { name: string; logical_cores: number; physical_cores?: number | null }) => ({
  name: safeLabel(value.name), logical_cores: value.logical_cores,
  // Absent stays absent: a record measured before the count was collected must
  // not be published with a number this machine happens to report now.
  ...(value.physical_cores !== undefined ? { physical_cores: value.physical_cores } : {}),
});
const gpu = (value: BenchmarkGpuSnapshot): PublicGpu => ({
  name: safeLabel(value.name), vendor: safeLabel(value.vendor), vram_mb: value.vram_mb,
  driver: safeLabel(value.driver), integrated: value.integrated,
});

/**
 * Runtime options whose values name this machine rather than the tuning
 * setup: its files, its listening address, its credentials or its prompt text.
 * Each is dropped together with all its values, so a published launch carries only
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
  '--served-model-name', '--embedding-model', '--draft-model', '--adapter-path', '--lora-modules',
  '--speculative-config', '--download-dir', '--tokenizer', '--chat-template', '--model-loader-extra-config',
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
 * instead of inferring it from the curated settings. An option and all its values
 * are published together or not at all; a half-reported option would read as a
 * switch the run never used.
 */
export function effectiveArguments(args: readonly string[]): string[] | null {
  if (!args.length) return null;
  const published: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const [name] = args[index].split('=', 1);
    // Keep contiguous values together, including private multi-value options.
    // A value that looks like an option keeps the existing flag boundary.
    const start = index;
    if (isOption(args[start])) {
      while (index + 1 < args.length && !isOption(args[index + 1])) index += 1;
    }
    if (PRIVATE_OPTIONS.has(name) || SECRET_OPTION.test(name.replace(/^--?/, ''))) continue;
    const group = args.slice(start, index + 1);
    if (!group.every(safeArgument)) continue;
    if (published.length + group.length > MAX_PUBLISHED_ARGUMENTS) break;
    published.push(...group);
  }
  return published;
}

type LegacyRecord = { backend: string; build: string; request: Omit<LegacyPerformanceBenchmarkRequest, 'run_id'> & { run_id?: string }; result: LegacyPerformanceBenchmarkResult };
type ServingRecord = { request: PerformanceBenchmarkRequest; result: PerformanceBenchmarkResult };

/** Source revisions describe inspected snapshots, never weight identity. */
export function publicModelSource(identity: BenchmarkModelIdentity): ServingPublicBenchmarkSubmission['model']['source'] {
  const repository = safeRepository(identity.repository);
  return repository && typeof identity.revision === 'string' && /^[0-9a-f]{40}$/.test(identity.revision)
    ? { kind: 'huggingface', repository, revision: identity.revision } : undefined;
}

/** Construct every public field explicitly. Local identifiers and diagnostics never cross this boundary. */
export function toPublicBenchmark(record: ServingRecord, submissionId: string): ServingPublicBenchmarkSubmission;
export function toPublicBenchmark(record: LegacyRecord, submissionId: string): LegacyPublicBenchmarkSubmission;
export function toPublicBenchmark(record: ServingRecord | LegacyRecord, submissionId: string): PublicBenchmarkSubmission;
export function toPublicBenchmark(record: ServingRecord | LegacyRecord, submissionId: string): PublicBenchmarkSubmission {
  if ('prompt_bytes' in record.request) return toServingPublicBenchmark(record as ServingRecord, submissionId);
  return toLegacyPublicBenchmark(record as LegacyRecord, submissionId);
}

function toLegacyPublicBenchmark(record: LegacyRecord, submissionId: string): LegacyPublicBenchmarkSubmission {
  const { request, result } = record;
  if (result.status !== 'complete' || result.rows.length === 0 || result.rows.some(row => Boolean(row.error))) {
    throw new Error('Only completed benchmarks with successful measurements can be published.');
  }
  const p = result.provenance?.schema_version === 1 ? result.provenance : undefined;
  if (p && p.corpus.profile !== request.context_profile) throw new Error('Benchmark corpus does not match its provenance.');
  const environment = p?.environment;
  const config = p?.execution_config;
  const provider = result.provider ?? 'llama.cpp';
  const python = provider !== 'llama.cpp';
  // Python launch prefixes contain a private interpreter/model identity.
  // Publish only tokens beginning at the first actual server option.
  const launchArgs = result.args ?? [];
  const hostIndex = launchArgs.indexOf('--host');
  const serverArgs = python ? (hostIndex < 0 ? [] : launchArgs.slice(hostIndex)) : launchArgs;
  const args = effectiveArguments(serverArgs);
  return validatePublicBenchmark({
    schema_version: python ? 2 : 1, submission_id: submissionId, app_version: safeLabel(p?.app_version),
    method: p ? { id: p.method.id, version: python ? 2 : p.method.version } : null,
    workload: { corpus: request.context_profile, corpus_version: p?.corpus.version ?? null, corpus_sha256: p?.corpus.sha256 ?? null,
      prompt_lengths: [...request.prompt_lengths], generation_length: request.generation_length, batch_sizes: [...request.batch_sizes], repetitions: request.repetitions, warmup: request.warmup },
    model: p ? { status: p.model.status, sha256: p.model.sha256, size_bytes: p.model.size_bytes,
      ...(!python && p.model.metadata ? { metadata: modelMetadata(p.model.metadata) } : {}),
      ...(python ? { format: result.model_format ?? 'unknown' } : {}),
    } : { status: 'unidentified', sha256: null, size_bytes: null, ...(python ? { format: result.model_format ?? 'unknown' } : {}) },
    runtime: { name: provider, version: runtimeVersion(result.runtime_version), backend: safeLabel(python ? result.runtime_accelerator : record.backend), build: safeLabel(python ? result.runtime_version : record.build),
      ...(result.runtime_variant === 'vllm-metal' ? { variant: 'vllm-metal' as const, plugin_version: safeLabel(result.runtime_plugin_version) ?? '' } : {}),
    },
    environment: environment ? { os: safeLabel(environment.os), arch: safeLabel(environment.arch), cpu: cpu(environment.cpu),
      ...(environment.system_memory_bytes !== undefined ? { system_memory_bytes: environment.system_memory_bytes } : {}),
      installed_gpus: environment.installed_gpus.map(gpu), execution: { mode: environment.execution.mode, selected_gpus: environment.execution.selected_gpus.map(gpu), selection_complete: environment.execution.selection_complete } } : null,
    execution: { context_size: result.context_size, parallel: result.parallel, settings: config && !python ? {
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
  }) as LegacyPublicBenchmarkSubmission;
}

function toServingPublicBenchmark({ request, result }: ServingRecord, submissionId: string): ServingPublicBenchmarkSubmission {
  const p = result.provenance;
  if (!p || p.schema_version !== 2) throw new Error('Serving benchmark provenance is unavailable.');
  if (result.status !== 'complete' || !result.rows.length || result.rows.some(row => row.failed || Boolean(row.error))) {
    throw new Error('Only completed benchmarks with successful measurements can be published.');
  }
  const w = p.workload;
  if (request.method.id !== p.method.id || request.method.version !== p.method.version
    || request.context_profile !== w.corpus || request.max_output_tokens !== w.max_output_tokens
    || request.repetitions !== w.repetitions || request.warmup !== w.warmup || request.request_usage !== w.request_usage
    || JSON.stringify(request.prompt_bytes) !== JSON.stringify(w.inputs.map(input => input.bytes))
    || JSON.stringify(request.concurrencies) !== JSON.stringify(w.concurrencies)) {
    throw new Error('Benchmark workload does not match its frozen provenance.');
  }
  const environment = p.environment;
  const source = publicModelSource(p.model);
  const format = p.model.format ?? 'unknown';
  return validatePublicBenchmark({
    schema_version: 3, submission_id: submissionId, app_version: p.app_version,
    method: { id: p.method.id, version: p.method.version },
    workload: {
      corpus: w.corpus, corpus_version: w.corpus_version,
      inputs: w.inputs.map(input => ({ bytes: input.bytes, sha256: input.sha256 })),
      max_output_tokens: w.max_output_tokens, concurrencies: [...w.concurrencies],
      repetitions: w.repetitions, warmup: w.warmup, request_usage: w.request_usage, cache_policy: w.cache_policy,
    },
    runtime: { name: p.runtime.name, version: p.runtime.version, backend: p.runtime.backend,
      build: p.runtime.build, variant: p.runtime.variant, plugin_version: p.runtime.plugin_version },
    model: { format, status: p.model.status, sha256: p.model.sha256, size_bytes: p.model.size_bytes,
      ...(source ? { source } : {}),
      ...(format === 'gguf' && p.model.metadata !== undefined ? { metadata: modelMetadata(p.model.metadata) } : {}) },
    environment: { scope: environment.scope, os: safeLabel(environment.os), arch: safeLabel(environment.arch),
      cpu: cpu(environment.cpu),
      ...(environment.system_memory_bytes !== undefined ? { system_memory_bytes: environment.system_memory_bytes } : {}),
      installed_gpus: environment.installed_gpus.map(gpu),
      execution: { mode: environment.execution.mode, selected_gpus: environment.execution.selected_gpus.map(gpu),
        selection_complete: environment.execution.selection_complete } },
    execution: { topology: p.execution.topology, memory_scope: p.execution.memory_scope,
      settings: p.execution.settings.map(setting => ({ target: setting.target, scope: [...setting.scope], name: setting.name,
        value: Array.isArray(setting.value) ? [...setting.value] : setting.value, unit: setting.unit, role: setting.role })) },
    measurements: { status: 'complete', rows: result.rows.map(publicServingRow) },
  }) as ServingPublicBenchmarkSubmission;
}

export function publicServingRow(row: PerformanceBenchmarkResult['rows'][number]): ServingBenchmarkRow {
  return {
    input_bytes: row.input_bytes, max_output_tokens: row.max_output_tokens, concurrency: row.concurrency, repetition: row.repetition,
    first_output_ms: row.first_output_ms, first_content_ms: row.first_content_ms, first_reasoning_ms: row.first_reasoning_ms,
    e2e_ms: row.e2e_ms, content_bytes: row.content_bytes, reasoning_bytes: row.reasoning_bytes, output_bytes: row.output_bytes,
    ...(row.reported_completion_tokens_by_request ? { reported_completion_tokens_by_request: [...row.reported_completion_tokens_by_request] } : {}),
    reported_prompt_tokens: row.reported_prompt_tokens, reported_completion_tokens: row.reported_completion_tokens,
    reported_cached_tokens: row.reported_cached_tokens, usage_status: row.usage_status, finish_reasons: [...row.finish_reasons],
    peak_memory_bytes: row.peak_memory_bytes, timing_source: row.timing_source, failed: row.failed,
  };
}
