import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke, isNativeRuntimeAvailable, NATIVE_RUNTIME_ERROR } from "./transport.ts";
import type {
  AppConfig, DeviceReport,
  DownloadedModel, DownloadProgress, HfFile, HfModel, InstalledRuntime,
  LatestInfo, McpServer, McpTool, ModelDownloadProgress, ModelScanResult,
  PullRequestPreview, RuntimeBundleInfo, RuntimeCapabilities, ServerStatus,
  SessionListResult, SessionStatus,
  VerificationRecord,
  PerformanceBenchmarkRequest, PerformanceBenchmarkResult, PerformanceBenchmarkProgress,
} from "./types.ts";

export const getConfig = () => invoke<AppConfig>("get_config");
export const saveConfig = (cfg: AppConfig) => invoke<AppConfig>("save_config", { cfg });

export const listModels = (modelsDir: string) => invoke<ModelScanResult>("list_models", { modelsDir });
export const deleteModel = (path: string, paths?: string[]) => invoke<void>("delete_model", { path, ...(paths ? { paths } : {}) });
export const pickModelsDir = () => invoke<string | null>("pick_models_dir");
export const pickLoraAdapter = () => invoke<string | null>("pick_lora_adapter");
export const hfSearchModels = (query: string, limit = 20) => invoke<HfModel[]>("hf_search_models", { query, limit });
export const hfModelFiles = (repoId: string) => invoke<HfFile[]>("hf_model_files", { repoId });
export const hfDownloadModel = (repoId: string, filePath: string, modelsDir: string) =>
  invoke<DownloadedModel>("hf_download_model", { repoId, filePath, modelsDir });
export const hfCancelDownload = () => invoke<void>("hf_cancel_download");
export const pickAttachment = () => invoke<string | null>("pick_attachment");
export const pickImage = () => invoke<string | null>("pick_image");
export const readImageData = (path: string) => invoke<string>("read_image_data", { path });
export const pickDocument = () => invoke<string | null>("pick_document");
export const readDocumentText = (path: string) => invoke<string>("read_document_text", { path });
export const readDocumentBinding = (path: string) => invoke<string>("read_document_binding", { path });

export const mcpListServers = () => invoke<McpServer[]>("mcp_list_servers");
export const mcpSaveServer = (server: McpServer) => invoke<McpServer[]>("mcp_save_server", { server });
export const mcpRemoveServer = (id: string) => invoke<McpServer[]>("mcp_remove_server", { id });
export const mcpListTools = (id: string) => invoke<McpTool[]>("mcp_list_tools", { id });
export const mcpCallTool = (id: string, name: string, argumentsValue: Record<string, unknown>) =>
  invoke<unknown>("mcp_call_tool", { id, name, arguments: argumentsValue });

export const startServer = (cfg: AppConfig) => invoke<string>("start_server", { cfg });
export const preflightLaunch = (cfg: AppConfig) => invoke<AppConfig>('preflight_launch', { cfg });
/** Accept one blocked GPU placement, using the key printed in its refusal. */
export const allowVerificationOverride = (key: string) => invoke<void>('allow_verification_override', { key });
export const verifyModelDeeply = (cfg: AppConfig) => invoke<VerificationRecord>('verify_model_deeply', { cfg });
export const applyRequestSettings = (cfg: AppConfig, sessionId = 'default') => invoke<NonNullable<ServerStatus['execution']>>('apply_request_settings', { cfg, sessionId });
export const stopServer = () => invoke<void>("stop_server");
export const unloadModel = () => invoke<void>("unload_model");
export const serverActivity = (phase: "start" | "end" | "touch", sessionId?: string) => invoke<void>("server_activity", { phase, ...(sessionId ? { sessionId } : {}) });
export const serverStatus = () => invoke<ServerStatus>("server_status");
export const startAnthropicGateway = () => invoke<string>("start_anthropic_gateway");
export const stopAnthropicGateway = () => invoke<void>("stop_anthropic_gateway");
export const anthropicGatewayStatus = () => invoke<{ running: boolean; url?: string }>("anthropic_gateway_status");

export const runPerformanceBench = (cfg: AppConfig, request: PerformanceBenchmarkRequest) =>
  invoke<PerformanceBenchmarkResult>("run_performance_bench", { cfg, request });
export const benchCancel = () => invoke<void>("bench_cancel");

/** Multi-session facade. The default legacy commands remain the source of truth for id=default. */
export const sessionList = () => invoke<SessionStatus[] | SessionListResult>("session_list");
export const sessionStart = (sessionId: string, cfg: AppConfig, stopExisting?: boolean) => invoke<SessionStatus>("session_start", { sessionId, cfg, stopExisting });
export const sessionStop = (sessionId: string) => invoke<void>("session_stop", { sessionId });
export const sessionUnload = (sessionId: string) => invoke<void>("session_unload", { sessionId });

export function normalizeSessionList(value: SessionStatus[] | SessionListResult): SessionStatus[] {
  return Array.isArray(value) ? value : Array.isArray(value.sessions) ? value.sessions : [];
}

export const deviceProfile = () => invoke<DeviceReport>("device_profile");
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
export const rtSelect = (backend: string, build: string) =>
  invoke<AppConfig>("rt_select", { backend, build });
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
