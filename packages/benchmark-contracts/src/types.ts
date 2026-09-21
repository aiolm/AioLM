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
  status: 'sha256' | 'unidentified' | 'multipart';
  sha256: string | null;
  size_bytes: number | null;
  /** Absent on older records; unavailable facts are not inferred from filenames. */
  metadata?: BenchmarkModelMetadata | null;
}

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

export interface PublicBenchmarkSubmission {
  schema_version: 1;
  submission_id: string;
  app_version: string | null;
  method: { id: 'cold-prompt-serving'; version: 1 } | null;
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
  runtime: { name: 'llama.cpp'; version: string | null; backend: string | null; build: string | null };
  environment: {
    os: string | null;
    arch: string | null;
    cpu: { name: string | null; logical_cores: number };
    /** Physical system RAM in bytes. Absent on measurements made before contract 0.4. */
    system_memory_bytes?: number | null;
    installed_gpus: PublicGpu[];
    execution: {
      mode: 'cpu' | 'selected' | 'automatic' | 'unknown';
      selected_gpus: PublicGpu[];
      selection_complete: boolean;
    };
  } | null;
  execution: { context_size: number; parallel: number; settings: BenchmarkExecutionSettings | null };
  measurements: { status: BenchmarkRunStatus; rows: PublicBenchmarkRow[] };
}

/** A website-issued acknowledgement; the website owns the resulting benchmark record. */
export interface BenchmarkReceipt {
  submission_id: string;
  id: string;
  url?: string;
}
