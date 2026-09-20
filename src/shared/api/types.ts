import type { StreamDelta } from "./sse.ts";
import type { JsonObject } from "../config/tuningValidation.ts";
import type { ExecutionSettings, SessionExecutionSettings } from '../config/executionSettings';
import type { SettingsProfileLibrary } from '../config/settingsProfiles';

export interface AppConfig {
  settings_profiles?: SettingsProfileLibrary;
  runtime_defaults?: string[];
  config_version: number;
  models_dir: string;
  port: number;
  ngl: number;
  ctx_size: number;
  batch_size: number;
  ubatch_size: number;
  keep: number;
  cache_type_k: string;
  cache_type_v: string;
  flash_attn: string;
  n_cpu_moe: number;
  threads: number;
  temperature: number;
  top_p: number;
  top_k: number;
  spec_type: string;
  spec_draft_n_max: number;
  spec_draft_n_min: number;
  spec_draft_p_min: number;
  spec_draft_p_split: number;
  spec_draft_ngl: string;
  spec_draft_device: string;
  spec_draft_model: string;
  reasoning: string;
  reasoning_format: string;
  reasoning_effort: string;
  reasoning_budget: number;
  reasoning_budget_message: string;
  reasoning_preserve: string;
  server_args: string[];
  chat_options: JsonObject;
  mmproj: string;
  active_model: string;
  active_backend: string;
  active_build: string;
  iters: number;
  parallel: number;
  request_timeout_seconds: number;
  sleep_idle_seconds: number;
  lora_adapters: LoraAdapterConfig[];
  /** Added by the multi-session config schema; optional for older app builds. */
  stop_existing_sessions_on_load?: boolean;
  sessions?: SessionDefinition[];
  gpu?: GpuPlacement;
}

export interface LoraAdapterConfig {
  path: string;
  scale: number;
  enabled: boolean;
}

export interface GgufModel {
  name: string;
  path: string;
  size_mb: number;
  is_vision: boolean;
  shards?: { files: string[]; total: number; missing: number[] };
}

/** What a GGUF file's own header states about the model. */
export interface ModelMetadata {
  context_length?: number;
  architecture?: string;
}

export interface ModelScanResult {
  models: GgufModel[];
  truncated: boolean;
}

export interface HfModel {
  id: string;
  author: string;
  downloads: number;
  likes: number;
  last_modified: string;
  pipeline_tag?: string;
  tags: string[];
  gated: boolean;
}

export interface HfFile {
  path: string;
  size_bytes: number;
  oid?: string;
  is_mmproj: boolean;
  download_url: string;
}

export interface DownloadedModel {
  repo_id: string;
  file_path: string;
  path: string;
  size_bytes: number;
}

export interface McpServer {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
}

export interface McpTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

export interface ModelDownloadProgress {
  repo_id: string;
  file_path: string;
  phase: "starting" | "downloading" | "cancelled" | "complete";
  received: number;
  total: number;
}

export interface LocalModelInfo {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";

export interface GpuDevice {
  vendor: GpuVendor;
  name: string;
  vram_mb?: number;
  driver?: string;
  pci_id?: string;
  integrated: boolean;
  /** Stable physical-device id; never use the transient array index as a key. */
  stable_id?: string;
}

export interface DeviceProfile {
  schema_version: number;
  os: string;
  arch: string;
  cpu: { name: string; logical_cores: number };
  gpus: GpuDevice[];
  detection: string;
  /** Stable, non-identifying device-class key for the benchmark service. */
  fingerprint: string;
}

/** Verdict from the local backend-recommendation policy. */
export type BackendFit = "recommended" | "compatible" | "unsupported";

export interface BackendSuitability {
  backend: string;
  fit: BackendFit;
  /** Reason key resolved by the UI catalog, not a display string. */
  reason: string;
  device?: string;
}

export interface DeviceReport {
  profile: DeviceProfile;
  backends: BackendSuitability[];
}

export interface RuntimeVersion {
  semver: string;
  build: number;
  commit: string;
}

export interface RuntimeSource {
  pull_request: number;
  /** Head repository — `ggml-org/llama.cpp` or a contributor's fork. */
  repository: string;
  /** Head branch at build time. A label, not an identity: `commit` is that. */
  head_ref?: string;
  author?: string;
  /** `open`, `closed` or `merged`, as of the build. */
  state?: string;
  fork?: boolean;
  commit: string;
  /**
   * SHA-256 of the archive as this machine downloaded it, computed locally.
   * GitHub publishes no digest for a source archive, so this records what was
   * built — it is not an independent verification of the download.
   */
  archive_sha256: string;
  /** How the extracted tree was tied back to `commit`. */
  commit_check?: string;
  url: string;
}

/**
 * A PR runtime keeps one directory per pull request, so rebuilding the same PR
 * replaces the previous commit. Present only on a fresh install that displaced
 * a different commit — never when listing.
 */
export interface RuntimeReplacement {
  previous_commit: string;
  previous_pull_request: number;
}

/** Reasons a pull request deserves a second look. None of them refuse a build. */
export type PrAdvisory = "draft" | "closed" | "merged" | "fork" | "no-head-ref";

export interface PullRequestArtifactPreview {
  name: string;
  sha256: string;
  bytes: number;
}

/** What the user is shown before agreeing to build a pull request locally. */
export interface PullRequestPreview {
  pull_request: number;
  title: string;
  state: string;
  draft: boolean;
  author: string;
  repository: string;
  head_ref: string;
  commit: string;
  fork: boolean;
  url: string;
  archive_url: string;
  updated_at: string;
  advisories: PrAdvisory[];
  /** Present when a verified, platform-matching prebuilt PR artifact exists. */
  artifact?: PullRequestArtifactPreview | null;
  /** Non-fatal artifact lookup error, when GitHub could not be queried reliably. */
  artifact_error?: string | null;
}

export interface InstalledRuntime {
  build: string;
  backend: string;
  dir: string;
  size_mb: number;
  /** Absent until the runtime is installed or probed by a build that records it. */
  version?: RuntimeVersion;
  /** Present for a runtime built from an upstream pull request. */
  source?: RuntimeSource;
  /** Set when this install displaced a PR build of a different commit. */
  replaced?: RuntimeReplacement;
}

export interface RuntimeBundleInfo {
  path: string;
  backend: string;
  build: string;
  archive_sha256: string;
  bytes: number;
}

export interface LatestInfo {
  build: string;
  file_name: string;
  url: string;
  digest?: string;
}

/** One stored answer to "does this runtime compute correctly on these GPUs?" */
export interface VerificationRecord {
  verdict: "pass" | "fail" | "unsupported";
  ratio?: number;
  detail: string;
  suite_version: number;
  recorded_at: string;
}

export interface RuntimeCapabilities {
  backend: string;
  build: string;
  executable: string;
  state: "available" | "failed preflight" | "not installed" | "unsupported by this runtime build" | "unknown";
  version: string;
  flags: string[];
  /** Exact help from the selected executable, including build-specific options. */
  server_help?: string;
  devices: string[];
  diagnostics: string[];
  bench_available?: boolean;
  supports_dflash?: boolean;
}

export type BenchmarkContextProfile = "code_python" | "code_mixed" | "novel_ko" | "novel_en" | "novel_ja";

/** A workload for an isolated local llama-server. It does not change saved tuning. */
export interface PerformanceBenchmarkRequest {
  run_id: string;
  prompt_lengths: number[];
  generation_length: number;
  batch_sizes: number[];
  repetitions: number;
  context_profile: BenchmarkContextProfile;
  warmup: boolean;
}

/** One trial. Rates are observed at the client, using server-reported token counts. */
export interface PerformanceBenchmarkRow {
  id: string;
  prompt_tokens: number;
  generation_length: number;
  concurrency: number;
  repetition: number;
  completion_tokens: number;
  cached_tokens: number;
  ttft_ms: number | null;
  tpot_ms: number | null;
  /** Aggregate prompt tokens / time until every request has emitted its first token. */
  pp_tps: number | null;
  /** Output tokens excluding each first token / observed batch decode interval. */
  tg_tps: number | null;
  e2e_ms: number;
  /** Total output tokens / complete trial wall time (includes prefill). */
  total_tps: number | null;
  /** Sampled child-process resident RAM, not GPU VRAM. */
  peak_memory_bytes: number | null;
  timing_source: "server" | "client";
  error?: string | null;
}

export interface PerformanceBenchmarkResult {
  run_id: string;
  rows: PerformanceBenchmarkRow[];
  status: "complete" | "partial" | "cancelled" | "failed";
  message?: string | null;
  /** Effective server arguments with credentials removed. */
  args: string[];
  runtime_version: string;
  context_size: number;
  parallel: number;
  /** Absent on older records; unknown provenance must not be reconstructed later. */
  provenance?: PerformanceBenchmarkProvenance;
}

export interface BenchmarkGpuSnapshot {
  name: string;
  vendor: string;
  vram_mb: number | null;
  driver: string | null;
  integrated: boolean;
}

export interface BenchmarkModelIdentity {
  status: 'sha256' | 'unidentified' | 'multipart';
  sha256: string | null;
  size_bytes: number | null;
}

export interface PerformanceBenchmarkProvenance {
  schema_version: 1;
  app_version: string;
  method: { id: 'cold-prompt-serving'; version: 1 };
  corpus: { profile: string; version: 1; sha256: string };
  model: BenchmarkModelIdentity;
  execution_config?: {
    gpu_layers: number | null;
    threads: number | null;
    threads_batch: number | null;
    flash_attention: string | null;
    cache_type_k: string | null;
    cache_type_v: string | null;
    split_mode: string | null;
    tensor_split: number[] | null;
  };
  environment: {
    os: string;
    arch: string;
    cpu: { name: string; logical_cores: number };
    installed_gpus: BenchmarkGpuSnapshot[];
    execution: {
      mode: 'cpu' | 'selected' | 'automatic' | 'unknown';
      selected_gpus: BenchmarkGpuSnapshot[];
      devices: string[];
      selection_complete: boolean;
    };
    detection: string;
  };
}

export interface PerformanceBenchmarkProgress {
  run_id: string;
  phase: "loading" | "warmup" | "single" | "batch" | "cleanup";
  completed: number;
  total: number;
  row?: PerformanceBenchmarkRow | null;
  message?: string | null;
}

/** A saved server session is a primary model plus optional sidecars. */
export interface SessionModels {
  primary_model: string;
  mmproj: string;
  draft_model: string;
}

export type SplitMode = "none" | "single" | "layer" | "row" | "tensor";

export interface GpuPlacement {
  gpu_ids: string[];
  main_gpu?: string | null;
  split_mode: SplitMode;
  tensor_split: number[];
  draft_gpu_id?: string | null;
}

export interface SessionDefinition {
  id: string;
  name: string;
  models: SessionModels;
  gpu: GpuPlacement;
  enabled: boolean;
  execution?: SessionExecutionSettings;
  model_profile_id?: string;
}

export interface SessionStatus {
  id: string;
  name: string;
  state: ServerState;
  url?: string;
  /** The backend may provide this directly; the UI also derives it from url. */
  port?: number;
  model?: string;
  mmproj?: string;
  draft_model?: string;
  api_key?: string;
  pid?: number;
  active_requests?: number;
  idle_seconds?: number;
  log_tail?: string;
  error?: string;
  gpu?: GpuPlacement;
  execution?: Partial<ExecutionSettings>;
}

export interface SessionListResult {
  sessions: SessionStatus[];
}

/** Status for selectors and badges, without diagnostic or request credentials. */
export type SessionSummary = Omit<SessionStatus, 'api_key' | 'log_tail' | 'error' | 'execution'>;

export type ServerState = "stopped" | "starting" | "running" | "stopping" | "failed" | "crashed";

export interface ServerStatus {
  state: ServerState;
  url?: string;
  model?: string;
  api_key?: string;
  mmproj?: string;
  pid?: number;
  log_tail?: string;
  error?: string;
  active_requests?: number;
  idle_seconds?: number;
  memory?: MemoryEstimate;
  lifecycle?: LifecycleDiagnostics;
  execution?: Partial<ExecutionSettings>;
}

export interface MemoryEstimate {
  model_mb: number;
  context_mb: number;
  kv_mb: number;
  projector_mb: number;
  adapters_mb: number;
  total_mb: number;
  available_mb?: number;
  source: "metadata" | "filesystem" | "unknown";
}

export interface LifecycleDiagnostics {
  idle_seconds?: number;
  sleep_idle_seconds: number;
  request_timeout_seconds: number;
  parallel: number;
  active_requests?: number;
  auto_unload_due?: boolean;
  effective_model?: string;
  effective_backend?: string;
  last_ready_at?: string;
}

export interface DownloadProgress {
  backend: string;
  build: string;
  phase: string;
  received: number;
  total: number;
}

export interface ServerLoraAdapter {
  id: number;
  path: string;
  scale: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ChatContentPart[];
  tool_call_id?: string;
  name?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatTextPart {
  type: "text";
  text: string;
}

export interface ChatImagePart {
  type: "image_url";
  image_url: { url: string };
}

export type ChatContentPart = ChatTextPart | ChatImagePart;

export type ChatDelta = StreamDelta;

export interface ChatSampling {
  runtime_defaults?: string[];
  temperature: number;
  top_p: number;
  top_k: number;
  reasoning?: string;
  reasoning_effort?: string;
  options?: JsonObject;
  tools?: ChatToolDefinition[];
}

export interface ChatToolDefinition {
  type: "function";
  function: { name: string; description?: string; parameters: unknown };
}

export interface ChatRequestBody {
  model: string;
  messages: ChatMessage[];
  stream: true;
  [key: string]: unknown;
}
