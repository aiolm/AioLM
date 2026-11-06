export type BenchmarkCorpus = 'code_python' | 'code_mixed' | 'novel_ko' | 'novel_en' | 'novel_ja';
export type BenchmarkRunStatus = 'complete' | 'partial' | 'cancelled' | 'failed';

/** Numeric trial measurements shared by collection and public comparison. */
export interface BenchmarkMetricRow {
  prompt_tokens: number;
  generation_length: number;
  concurrency: number;
  repetition: number;
  completion_tokens: number;
  cached_tokens: number;
  ttft_ms: number | null;
  tpot_ms: number | null;
  pp_tps: number | null;
  tg_tps: number | null;
  e2e_ms: number;
  total_tps: number | null;
  peak_memory_bytes: number | null;
  timing_source: 'server' | 'client';
}

/** Aggregation input only. Local identities and diagnostics are not public submission fields. */
export interface BenchmarkTrial extends BenchmarkMetricRow {
  id: string;
  error?: string | null;
}

export interface BenchmarkSummary extends BenchmarkTrial {
  samples: number;
  /** Sample standard deviation; unavailable with fewer than two measured trials. */
  tg_stddev: number | null;
  speedup: number | null;
}

export interface PublicBenchmarkRow extends BenchmarkMetricRow {
  failed: boolean;
}

export interface PublicGpu {
  name: string | null;
  vendor: string | null;
  vram_mb: number | null;
  driver: string | null;
  integrated: boolean;
}

/** Declared GGUF metadata and, when available, a file-matched download origin. */
export interface BenchmarkModelMetadata {
  format: 'GGUF';
  name: string | null;
  architecture: string | null;
  size_label: string | null;
  /** Weight encoding; independent of the runtime's KV-cache encoding. */
  quantization: string | null;
  file_type: number | null;
  quantized_by: string | null;
  /** Public Hugging Face namespace/repository, never a URL or local path. */
  repository: string | null;
  base_models: string[];
  /** Repository-relative artifact from a file-matched public origin. */
  artifact: string | null;
  source: 'gguf' | 'huggingface' | 'gguf+huggingface';
}

export interface BenchmarkModelIdentity {
  format?: 'gguf' | 'hf-safetensors' | 'mlx' | 'unknown';
  status: 'sha256' | 'unidentified' | 'multipart';
  sha256: string | null;
  size_bytes: number | null;
  /** Absent on older records; unavailable facts are not inferred from filenames. */
  metadata?: BenchmarkModelMetadata | null;
}

/**
 * llama.cpp settings; Python engines leave these null. Imports retain the
 * recorded runtime's settings; context, concurrency and KV-cache controls
 * must not be translated between engines based on similar field names.
 */
export interface BenchmarkExecutionSettings {
  /** -1 preserves an explicitly selected automatic runtime value. */
  gpu_layers: number | null;
  threads: number | null;
  threads_batch: number | null;
  flash_attention: string | null;
  cache_type_k: string | null;
  cache_type_v: string | null;
  split_mode: string | null;
  tensor_split: number[] | null;
}

export interface LegacyPublicBenchmarkSubmission {
  schema_version: 1 | 2;
  submission_id: string;
  app_version: string | null;
  method: { id: 'cold-prompt-serving'; version: 1 | 2 } | null;
  workload: {
    corpus: BenchmarkCorpus;
    corpus_version: number | null;
    corpus_sha256: string | null;
    prompt_lengths: number[];
    generation_length: number;
    batch_sizes: number[];
    repetitions: number;
    warmup: boolean;
  };
  model: BenchmarkModelIdentity;
  runtime: {
    name: 'llama.cpp' | 'vllm' | 'mlx-vlm'; version: string | null; backend: string | null; build: string | null;
    /** Present only when the measured vLLM platform is vllm-metal. */
    variant?: 'vllm-metal';
    plugin_version?: string;
  };
  environment: {
    os: string | null;
    arch: string | null;
    cpu: {
      name: string | null;
      /** Schedulable threads. */
      logical_cores: number;
      /**
       * Physical cores, fewer than `logical_cores` on a processor with
       * simultaneous multithreading. Absent on measurements made before
       * contract 0.6, and null when the measuring machine did not report one.
       */
      physical_cores?: number | null;
    };
    /** Physical system RAM in bytes. Absent on measurements made before contract 0.4. */
    system_memory_bytes?: number | null;
    installed_gpus: PublicGpu[];
    execution: {
      mode: 'cpu' | 'selected' | 'automatic' | 'unknown';
      selected_gpus: PublicGpu[];
      selection_complete: boolean;
    };
  } | null;
  execution: {
    context_size: number;
    parallel: number;
    settings: BenchmarkExecutionSettings | null;
    /**
     * The llama-server options the measured run was started with, in order, as
     * separate tokens, so a reader can reproduce the setup. Options carrying a
     * path, address or credential are removed with their values. Absent on
     * measurements made before contract 0.5.
     */
    effective_args?: string[] | null;
  };
  measurements: { status: BenchmarkRunStatus; rows: PublicBenchmarkRow[] };
}

/** Public identity is independent of local provider, connection and process IDs. */
export interface ServingRuntimeIdentity {
  name: string | null;
  version: string | null;
  backend: string | null;
  build: string | null;
  variant: string | null;
  plugin_version: string | null;
}

export interface ServingWorkload {
  corpus: BenchmarkCorpus;
  corpus_version: 1;
  inputs: Array<{ bytes: number; sha256: string }>;
  max_output_tokens: number;
  concurrencies: number[];
  repetitions: number;
  warmup: boolean;
  request_usage: boolean;
  cache_policy: 'as_configured';
}

export interface RecordedSetting {
  target: 'launch' | 'request';
  scope: string[];
  name: string;
  value: boolean | number | string | number[] | null;
  unit: 'tokens' | 'bytes' | 'MiB' | 'GiB' | 'threads' | 'layers' | 'count' | 'ratio' | 'bits' | 'percent' | null;
  role: 'context.total_tokens' | 'context.per_sequence_tokens' | 'context.per_request_kv_tokens' | 'concurrency.capacity' | null;
}

export interface ServingExecution {
  topology: 'owned' | 'attached' | 'unknown';
  memory_scope: 'owned_process_tree' | 'owned_root_process' | 'unavailable';
  settings: RecordedSetting[];
}

export interface BenchmarkConfiguration {
  runtime: ServingRuntimeIdentity;
  execution: ServingExecution;
}

export interface ServingBenchmarkModelIdentity extends BenchmarkModelIdentity {
  format: 'gguf' | 'hf-safetensors' | 'mlx' | 'unknown';
  /** Provenance only: revision does not establish a weight hash or unmodified weights. */
  source?: { kind: 'huggingface'; repository: string; revision: string };
}

export interface ServingBenchmarkRow {
  input_bytes: number;
  max_output_tokens: number;
  concurrency: number;
  repetition: number;
  first_output_ms: number | null;
  first_content_ms: number | null;
  first_reasoning_ms: number | null;
  e2e_ms: number;
  content_bytes: number;
  reasoning_bytes: number;
  output_bytes: number;
  reported_prompt_tokens: number | null;
  reported_completion_tokens: number | null;
  /** Fixed-output method v2 evidence, in request launch-slot order. */
  reported_completion_tokens_by_request?: number[];
  reported_cached_tokens: number | null;
  usage_status: 'complete' | 'partial' | 'missing' | 'invalid';
  /** One last-observed reason per request, in launch-slot order. */
  finish_reasons: Array<'stop' | 'length' | 'content_filter' | 'tool_calls' | 'other' | 'not_reported'>;
  peak_memory_bytes: number | null;
  timing_source: 'client';
  failed: false;
}

export type ServingAggregationRow = Omit<ServingBenchmarkRow, 'failed'> & {
  failed?: boolean;
  error?: string | null;
};

export type ServingMetricKey =
  | 'first_output_ms' | 'first_content_ms' | 'first_reasoning_ms' | 'e2e_ms'
  | 'content_bytes' | 'reasoning_bytes' | 'output_bytes' | 'output_bytes_per_second'
  | 'reported_prompt_tokens' | 'reported_completion_tokens' | 'reported_cached_tokens'
  | 'reported_tokens_per_second' | 'peak_memory_bytes';

export interface ServingMetricStat {
  median: number;
  min: number;
  max: number;
  samples: number;
}

export type ServingBenchmarkPoint = {
  input_bytes: number;
  max_output_tokens: number;
  concurrency: number;
  samples: number;
} & Record<ServingMetricKey, ServingMetricStat | null>;

export interface ServingPublicBenchmarkSubmission extends BenchmarkConfiguration {
  schema_version: 3;
  submission_id: string;
  app_version: string | null;
  method: { id: 'openai-chat-serving'; version: 1 | 2 };
  workload: ServingWorkload;
  model: ServingBenchmarkModelIdentity;
  environment: (NonNullable<LegacyPublicBenchmarkSubmission['environment']> & { scope: 'aiolm_host' }) | null;
  measurements: { status: 'complete'; rows: ServingBenchmarkRow[] };
}

export type PublicBenchmarkSubmission = LegacyPublicBenchmarkSubmission | ServingPublicBenchmarkSubmission;

/** A website-issued acknowledgement; the website owns the resulting benchmark record. */
export interface BenchmarkReceipt {
  submission_id: string;
  id: string;
  url?: string;
}
