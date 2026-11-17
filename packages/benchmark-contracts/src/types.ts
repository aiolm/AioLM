export type BenchmarkCorpus = 'code_python' | 'code_mixed' | 'novel_ko' | 'novel_en' | 'novel_ja';
export type BenchmarkRunStatus = 'complete' | 'partial' | 'cancelled' | 'failed';

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

export interface BenchmarkEnvironment {
  os: string | null;
  arch: string | null;
  cpu: {
    name: string | null;
    /** Schedulable threads. */
    logical_cores: number;
    /** Physical cores, when reported by the measuring machine. */
    physical_cores?: number | null;
  };
  system_memory_bytes?: number | null;
  installed_gpus: PublicGpu[];
  execution: {
    mode: 'cpu' | 'selected' | 'automatic' | 'unknown';
    selected_gpus: PublicGpu[];
    selection_complete: boolean;
  };
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

/** Actual UTF-8 identity of the first point's first request slot. */
export interface ServingInput {
  bytes: number;
  sha256: string;
}

export interface ServingWorkload {
  corpus: BenchmarkCorpus;
  corpus_version: 2;
  inputs: ServingInput[];
  max_output_tokens: number;
  concurrencies: number[];
  repetitions: number;
  warmup: false;
  request_usage: boolean;
  cache_policy: 'cold_prompt';
  /** Fresh random run nonce, never a user or model identifier. */
  prompt_nonce: string;
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
  /** Actual dispatched input SHA256 values, in request launch-slot order. */
  input_sha256_by_request: string[];
  first_output_ms: number | null;
  e2e_ms: number;
  output_bytes: number;
  reported_prompt_tokens: number | null;
  reported_completion_tokens: number | null;
  prefill_tokens_per_second: number | null;
  decode_tokens_per_second: number | null;
  tpot_ms: number | null;
  usage_status: 'complete' | 'partial' | 'missing' | 'invalid';
  /** One last-observed reason per request, in launch-slot order. */
  finish_reasons: string[];
  peak_memory_bytes: number | null;
  timing_source: 'client';
  failed: boolean;
}

export type ServingAggregationRow = Omit<ServingBenchmarkRow, 'failed'> & {
  failed?: boolean;
  error?: string | null;
};

export type ServingMetricKey =
  | 'first_output_ms' | 'prefill_tokens_per_second' | 'decode_tokens_per_second' | 'tpot_ms'
  | 'reported_tokens_per_second' | 'output_bytes_per_second' | 'e2e_ms' | 'peak_memory_bytes';

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
  schema_version: 4;
  submission_id: string;
  app_version: string | null;
  method: { id: 'openai-chat-serving'; version: 5 };
  workload: ServingWorkload;
  model: ServingBenchmarkModelIdentity;
  environment: (BenchmarkEnvironment & { scope: 'aiolm_host' }) | null;
  measurements: { status: 'complete'; rows: ServingBenchmarkRow[] };
}

export type PublicBenchmarkSubmission = ServingPublicBenchmarkSubmission;

/** A website-issued acknowledgement; the website owns the resulting benchmark record. */
export interface BenchmarkReceipt {
  submission_id: string;
  id: string;
  url?: string;
}
