import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { trackInitialRead } from "../ui/initialLayout.ts";

const layoutReads = new Set([
  "get_config", "server_status", "session_list", "list_models", "device_profile",
  "rt_list", "rt_latest", "rt_probe", "mcp_list_servers", "mcp_list_tools",
  "anthropic_gateway_status", "hf_search_models", "hf_model_files", "read_document_binding",
]);

export const NATIVE_RUNTIME_ERROR = "Native desktop runtime is unavailable. Run the packaged aiolm desktop app instead of the browser preview.";

export function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isNativeRuntimeAvailable()) return Promise.reject(new Error(NATIVE_RUNTIME_ERROR));
  return layoutReads.has(command)
    ? trackInitialRead(() => tauriInvoke<T>(command, args))
    : tauriInvoke<T>(command, args);
}

export function isNativeRuntimeAvailable(): boolean {
  return typeof window !== "undefined"
    && typeof (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !== "undefined";
}

export { readBoundedResponseText } from "./http.ts";
