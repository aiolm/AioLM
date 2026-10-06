import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, isNativeRuntimeAvailable, NATIVE_RUNTIME_ERROR } from "./transport.ts";
import type { HfInstalledFile, HfSortKey } from "./models.ts";
import type {
  ApiServerStatus, AppConfig, DeviceReport, ResourceEstimate,
  DownloadedModel, DownloadProgress, HfFile, HfModel, InstalledRuntime,
  LatestInfo, McpServer, McpTool, McpToolPayload, ModelDownloadProgress, ModelMetadata,
  PullRequestPreview, RuntimeBundleInfo, RuntimeCapabilities, ServerStatus,
  SessionListResult, SessionStatus, SessionSummary,
  VerificationRecord,
  PerformanceBenchmarkRequest, PerformanceBenchmarkResult, PerformanceBenchmarkProgress,
} from "./types.ts";

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (cfg: AppConfig) => invoke<AppConfig>("save_config", { cfg });

export { listModelArtifacts as listModels } from './providers.ts';
export const cancelModelScan = (scanId: string) => invoke<void>("cancel_model_scan", { scanId });
export const deleteModel = (path: string, paths?: string[]) => invoke<void>("delete_model", { path, ...(paths ? { paths } : {}) });
export const pickModelsDir = () => invoke<string | null>("pick_models_dir");
export const pickLoraAdapter = () => invoke<string | null>("pick_lora_adapter");
/** An empty query lists the catalog itself, which is what Discover opens on. */
export const hfSearchModels = (query: string, limit = 20, sort: HfSortKey = "downloads", format?: 'gguf' | 'safetensors' | 'mlx') =>
  invoke<HfModel[]>("hf_search_models", { query, limit, sort, ...(format ? { format } : {}) });
export const hfInstalledFiles = (repoId: string, files: string[], modelsDir: string) =>
  invoke<HfInstalledFile[]>("hf_installed_files", { repoId, files, modelsDir });
export const hfModelFiles = (repoId: string) => invoke<HfFile[]>("hf_model_files", { repoId });
export const hfOpenModelCard = (repoId: string) => invoke<void>("hf_open_model_card", { repoId });
/** A split GGUF downloads all parts from one revision and returns its first entrypoint. */
export const hfDownloadModel = (repoId: string, filePath: string, modelsDir: string, includeCompanions?: boolean) =>
  invoke<DownloadedModel>("hf_download_model", { repoId, filePath, modelsDir, ...(includeCompanions !== undefined ? { includeCompanions } : {}) });
export const hfCancelDownload = () => invoke<void>("hf_cancel_download");
export const hfDownloadSnapshot = (repoId: string, modelsDir: string) => invoke<import('./providers').ModelArtifact>('hf_download_snapshot', { repoId, modelsDir });
export const pickAttachment = () => invoke<string | null>("pick_attachment");
export const pickImage = () => invoke<string | null>("pick_image");
export const readImageData = (path: string) => invoke<string>("read_image_data", { path });
export const importMedia = (path: string) => invoke<import('../../features/chat/chatTypes').ImageAttachment>('import_media', { path });
export const resolveMedia = (reference: string, providerId: import('./providers').ProviderId) => invoke<import('./types').ChatContentPart>('resolve_media', { reference, providerId });
export interface MediaTranscription { text: string; sessionId: string; model: string }
async function mediaOperation<T>(command: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted();
  const operationId = crypto.randomUUID();
  const cancel = () => { void invoke<void>('cancel_media_operation', { operationId }).catch(() => undefined); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await invoke<T>(command, { ...args, operationId });
    signal?.throwIfAborted();
    return result;
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}
/** Uses one explicitly selected local speech session and immutable audio. */
export const transcribeMedia = (reference: string, sessionId: string, signal?: AbortSignal) =>
  mediaOperation<MediaTranscription>('transcribe_media', { reference, sessionId }, signal);
export interface VideoFrames { frames: import('../../features/chat/chatTypes').PreparedVideoFrame[] }
/** Samples local video into immutable images; never reads a caller URL. */
export const extractVideoFrames = (reference: string, signal?: AbortSignal, maxFrames = 4) =>
  mediaOperation<VideoFrames>('extract_video_frames', { reference, maxFrames }, signal);
export const pickDocument = () => invoke<string | null>("pick_document");
export const readDocumentText = (path: string) => invoke<string>("read_document_text", { path });
export const readDocumentBinding = (path: string) => invoke<string>("read_document_binding", { path });

export const mcpListServers = () => invoke<McpServer[]>("mcp_list_servers");
export const mcpSaveServer = (server: McpServer) => invoke<McpServer[]>("mcp_save_server", { server });
export const mcpRemoveServer = (id: string) => invoke<McpServer[]>("mcp_remove_server", { id });
export const mcpListTools = async (id: string): Promise<McpTool[]> => {
  const tools = await invoke<McpToolPayload[]>("mcp_list_tools", { id });
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description ?? undefined,
    input_schema: tool.inputSchema !== undefined ? tool.inputSchema : tool.input_schema ?? null,
  }));
};
/** `callId` makes the call stoppable through {@link mcpCancelToolCall}. */
export const mcpCallTool = (id: string, name: string, argumentsValue: Record<string, unknown>, callId?: string) =>
  invoke<unknown>("mcp_call_tool", callId ? { id, name, arguments: argumentsValue, callId } : { id, name, arguments: argumentsValue });
/** Stop the call started with `callId`, including its approval wait. Safe to send before the call itself arrives. */
export const mcpCancelToolCall = (callId: string) => invoke<void>("mcp_cancel_tool_call", { callId });

export const startServer = (cfg: AppConfig) => invoke<string>("start_server", { cfg });
export const preflightLaunch = (cfg: AppConfig) => invoke<AppConfig>('preflight_launch', { cfg });
/** Accept one blocked GPU placement, using the key printed in its refusal. */
export const allowVerificationOverride = (key: string) => invoke<void>('allow_verification_override', { key });
export const verifyModelDeeply = (cfg: AppConfig) => invoke<VerificationRecord>('verify_model_deeply', { cfg });
/** Ask a deep verification in flight to stop between passes. */
export const verifyCancel = () => invoke<void>('verify_cancel');
export const applyRequestSettings = (cfg: AppConfig, sessionId = 'default') => invoke<NonNullable<ServerStatus['execution']>>('apply_request_settings', { cfg, sessionId });
export const stopServer = () => invoke<void>("stop_server");
export const unloadModel = () => invoke<void>("unload_model");
export const serverActivity = (phase: "start" | "end" | "touch", sessionId?: string) => invoke<void>("server_activity", { phase, ...(sessionId ? { sessionId } : {}) });
export const serverStatus = () => invoke<ServerStatus>("server_status");
/** The public API listener has its own lifecycle; loading or unloading a model never touches it. */
export const startApiServer = () => invoke<ApiServerStatus>("start_api_server");
export const stopApiServer = () => invoke<void>("stop_api_server");
export const apiServerStatus = () => invoke<ApiServerStatus>("api_server_status");
export const startAnthropicGateway = () => invoke<string>("start_anthropic_gateway");
export const stopAnthropicGateway = () => invoke<void>("stop_anthropic_gateway");
export const anthropicGatewayStatus = () => invoke<{ running: boolean; url?: string }>("anthropic_gateway_status");

export const runPerformanceBench = (cfg: AppConfig, request: PerformanceBenchmarkRequest) =>
  invoke<PerformanceBenchmarkResult>("run_performance_bench", { cfg, request });
export const benchCancel = () => invoke<void>("bench_cancel");

/** Multi-session facade. The default legacy commands remain the source of truth for id=default. */
export const sessionList = () => invoke<SessionStatus[] | SessionListResult>("session_list");
export const sessionSummaryList = () => invoke<SessionSummary[]>("session_summary_list");
export const sessionStart = (sessionId: string, cfg: AppConfig, stopExisting?: boolean) => invoke<SessionStatus>("session_start", { sessionId, cfg, stopExisting });
export const sessionStop = (sessionId: string) => invoke<void>("session_stop", { sessionId });
export const sessionUnload = (sessionId: string) => invoke<void>("session_unload", { sessionId });

export function normalizeSessionList(value: SessionStatus[] | SessionListResult): SessionStatus[] {
  return Array.isArray(value) ? value : Array.isArray(value.sessions) ? value.sessions : [];
}

export const deviceProfile = () => invoke<DeviceReport>("device_profile");
export const modelMetadata = (path: string) =>
  invoke<ModelMetadata>("model_metadata", { path });
export const estimateModelResources = (config: AppConfig, runtimeDevices: readonly string[] = []) =>
  invoke<ResourceEstimate>("estimate_model_resources", { config, runtimeDevices });

export const rtList = () => invoke<InstalledRuntime[]>("rt_list");
export const rtLatest = (backend: string, refresh = false) => invoke<LatestInfo>("rt_latest", { backend, refresh });
export const rtInstall = (backend: string, build: string) =>
  invoke<InstalledRuntime>("rt_install", { backend, build });
export const rtPrPreview = (backend: string, source: string) =>
  invoke<PullRequestPreview>("rt_pr_preview", { backend, source });
/**
 * `confirmedCommit` is the head the user actually approved in the preview. The
 * backend re-resolves the PR and refuses the build if the head has moved since,
 * so a force-push cannot ride in on an earlier confirmation.
 */
export const rtInstallPr = (backend: string, source: string, confirmedCommit: string) =>
  invoke<InstalledRuntime>("rt_install_pr", { backend, source, confirmedCommit });
export const rtExport = (backend: string, build: string) =>
  invoke<RuntimeBundleInfo>("rt_export", { backend, build });
export const rtImport = () => invoke<InstalledRuntime>("rt_import");
export const rtCancel = () => invoke<void>("rt_cancel");
export const rtUninstall = (backend: string, build: string) =>
  invoke<void>("rt_uninstall", { backend, build });
export const rtProbe = (backend = "", build = "") => invoke<RuntimeCapabilities>("rt_probe", { backend, build });

export function onRuntimeProgress(
  cb: (progress: DownloadProgress) => void,
): Promise<UnlistenFn> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  return listen<DownloadProgress>("runtime-download-progress", (event) => cb(event.payload));
}

export function onPerformanceBenchmarkProgress(cb: (progress: PerformanceBenchmarkProgress) => void): Promise<UnlistenFn> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  return listen<PerformanceBenchmarkProgress>("performance-bench-progress", (event) => cb(event.payload));
}

export function onModelDownloadProgress(
  cb: (progress: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  return listen<ModelDownloadProgress>("model-download-progress", (event) => cb(event.payload));
}
