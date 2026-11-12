import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type EventCallback, type UnlistenFn } from "@tauri-apps/api/event";
import { trackInitialRead } from "../ui/initialLayout.ts";
import { toIpcError } from "./ipcError.ts";

const layoutReads = new Set([
  "get_config", "server_status", "session_list", "list_models", "device_profile",
  "rt_list", "rt_latest", "rt_probe", "mcp_list_servers", "mcp_list_tools",
  "api_server_status", "anthropic_gateway_status", "hf_search_models", "hf_model_files", "read_document_binding",
]);

export const NATIVE_RUNTIME_ERROR = "Native desktop runtime is unavailable. Run the packaged aiolm desktop app instead of the browser preview.";

export type LayoutReadPhase = "initial" | "refresh";

export function invoke<T>(command: string, args?: Record<string, unknown>, phase: LayoutReadPhase = "initial"): Promise<T> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  const call = () => tauriInvoke<T>(command, args).catch((cause: unknown) => { throw toIpcError(cause); });
  return phase !== "refresh" && layoutReads.has(command) ? trackInitialRead(call) : call();
}

/** Apply the same native guard to SDK operations that do not use invoke. */
export function withNativeRuntime<T>(operation: () => Promise<T>): Promise<T> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  return operation();
}

export function listen<T>(event: string, handler: EventCallback<T>): Promise<UnlistenFn> {
  return withNativeRuntime(() => tauriListen<T>(event, handler));
}

export type { UnlistenFn } from "@tauri-apps/api/event";

export function isNativeRuntimeAvailable(): boolean {
  return typeof window !== "undefined"
    && typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export { readBoundedResponseText } from "./http.ts";
