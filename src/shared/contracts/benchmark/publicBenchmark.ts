import { validatePublicBenchmark, type BenchmarkEnvironment, type BenchmarkModelMetadata, type ServingPublicBenchmarkSubmission, type PublicGpu, type ServingBenchmarkRow } from '@aiolm/benchmark-contracts';
import type { BenchmarkModelIdentity, PerformanceBenchmarkRequest, PerformanceBenchmarkResult } from '../../api/types.ts';
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
const cpu = (value: BenchmarkEnvironment['cpu']) => ({
  name: safeLabel(value.name), logical_cores: value.logical_cores,
  // Absent stays absent: a record measured before the count was collected must
  // not be published with a number this machine happens to report now.
  ...(value.physical_cores !== undefined ? { physical_cores: value.physical_cores } : {}),
});
const gpu = (value: PublicGpu): PublicGpu => ({
  name: safeLabel(value.name), vendor: safeLabel(value.vendor), vram_mb: value.vram_mb,
  driver: safeLabel(value.driver), integrated: value.integrated,
});

type ServingRecord = { request: PerformanceBenchmarkRequest; result: PerformanceBenchmarkResult };

/** Source revisions describe inspected snapshots, never weight identity. */
export function publicModelSource(identity: BenchmarkModelIdentity): ServingPublicBenchmarkSubmission['model']['source'] {
  const repository = safeRepository(identity.repository);
  return repository && typeof identity.revision === 'string' && /^[0-9a-f]{40}$/.test(identity.revision)
    ? { kind: 'huggingface', repository, revision: identity.revision } : undefined;
}

/** Construct every public field explicitly. Local identifiers and diagnostics never cross this boundary. */
export function toPublicBenchmark(record: ServingRecord, submissionId: string): ServingPublicBenchmarkSubmission {
  return toServingPublicBenchmark(record, submissionId);
}

function toServingPublicBenchmark({ request, result }: ServingRecord, submissionId: string): ServingPublicBenchmarkSubmission {
  const p = result.provenance;
  if (!p || p.schema_version !== 3) throw new Error('Serving benchmark provenance is unavailable.');
  if (result.status !== 'complete' || !result.rows.length || result.rows.some(row => row.failed || Boolean(row.error))) {
    throw new Error('Only completed benchmarks with successful measurements can be published.');
  }
  const w = p.workload;
  if (request.method.id !== p.method.id || request.method.version !== p.method.version
    || request.context_profile !== w.corpus || request.max_output_tokens !== w.max_output_tokens
    || request.repetitions !== w.repetitions || request.warmup !== w.warmup
    || (w.request_usage && !request.request_usage)
    || JSON.stringify(request.prompt_bytes) !== JSON.stringify(w.inputs.map(input => input.bytes))
    || JSON.stringify(request.concurrencies) !== JSON.stringify(w.concurrencies)) {
    throw new Error('Benchmark workload does not match its frozen provenance.');
  }
  const environment = p.environment;
  const source = publicModelSource(p.model);
  const format = p.model.format ?? 'unknown';
  return validatePublicBenchmark({
    schema_version: 4, submission_id: submissionId, app_version: p.app_version,
    method: { id: p.method.id, version: p.method.version },
    workload: {
      corpus: w.corpus, corpus_version: w.corpus_version,
      inputs: w.inputs.map(input => ({ bytes: input.bytes, sha256: input.sha256 })),
      max_output_tokens: w.max_output_tokens, concurrencies: [...w.concurrencies],
      repetitions: w.repetitions, warmup: w.warmup, request_usage: w.request_usage, cache_policy: w.cache_policy,
      prompt_nonce: w.prompt_nonce,
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
  });
}

export function publicServingRow(row: PerformanceBenchmarkResult['rows'][number]): ServingBenchmarkRow {
  return {
    input_bytes: row.input_bytes, max_output_tokens: row.max_output_tokens, concurrency: row.concurrency, repetition: row.repetition,
    input_sha256_by_request: [...row.input_sha256_by_request],
    first_output_ms: row.first_output_ms, e2e_ms: row.e2e_ms, output_bytes: row.output_bytes,
    reported_prompt_tokens: row.reported_prompt_tokens, reported_completion_tokens: row.reported_completion_tokens,
    prefill_tokens_per_second: row.prefill_tokens_per_second, decode_tokens_per_second: row.decode_tokens_per_second,
    tpot_ms: row.tpot_ms, usage_status: row.usage_status, finish_reasons: [...row.finish_reasons],
    peak_memory_bytes: row.peak_memory_bytes, timing_source: row.timing_source, failed: row.failed,
  };
}
