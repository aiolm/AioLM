import type { ServerState } from "../api/types.ts";
import { isIpcErrorKind } from "../api/ipcError.ts";
import { translate, type UnifiedKey } from "../i18n/i18nUnified.ts";
import type { Locale } from "../i18n/i18nCatalog.ts";

export type LifecycleErrorKind = "active-response" | "busy" | "timeout" | "port" | "executable" | "model" | "memory" | "unknown";

/** The native gate that refuses to change a model while it answers a request. */
const ACTIVE_RESPONSE = /^finish or stop the active response(?: in session '[^']+')? before (?:loading a model|replacing this model|unloading this model)$/i;

export function classifyLifecycleError(error: unknown): LifecycleErrorKind {
  // Busy also covers runtime installs and other operations; only the active
  // response gate asks the user to stop a response.
  if (isIpcErrorKind(error, "busy")) return error instanceof Error && ACTIVE_RESPONSE.test(error.message) ? "active-response" : "busy";
  if (isIpcErrorKind(error, "timeout")) return "timeout";
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  // Allocation failures often include model-loading frames and startup timeout
  // wrappers. Their concrete memory diagnosis takes precedence over that text.
  if (text.includes("out of memory") || /\boom\b|no available memory for (?:the )?cache blocks|(?:larger than|exceeds?) (?:the )?available (?:kv cache )?memory/.test(text)) return "memory";
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  // Tracebacks contain words such as importing, reuse_port and model even
  // when the rejected setting is a parser. Require an actual bind diagnosis.
  if (/\binvalid (?:tool call|reasoning) parser\b/.test(text)) return "unknown";
  if (/address already in use|\beaddrinuse\b|\bport\b[^\n]{0,80}\b(?:already in use|in use|bind failed)\b|\b(?:failed|unable|cannot) to bind\b/.test(text)) return "port";
  if (text.includes("not found") || text.includes("no such file") || text.includes("executable")) return "executable";
  if (text.includes("model") && (text.includes("load") || text.includes("file") || text.includes("invalid"))) return "model";
  if (text.includes("out of memory") || text.includes("oom") || text.includes("vram") || text.includes("memory")) return "memory";
  return "unknown";
}

const LIFECYCLE_HINT_KEYS: Record<LifecycleErrorKind, UnifiedKey> = {
  "active-response": "lifecycle.activeResponse",
  busy: "lifecycle.busy",
  timeout: "lifecycle.timeout",
  port: "lifecycle.port",
  executable: "lifecycle.executable",
  model: "lifecycle.model",
  memory: "lifecycle.memory",
  unknown: "lifecycle.unknown",
};

export function lifecycleErrorMessage(action: "start" | "stop", error: unknown, locale: Locale): string {
  const kind = classifyLifecycleError(error);
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = translate(locale, action === "start" ? "lifecycle.startFailed" : "lifecycle.stopFailed");
  const hint = translate(locale, LIFECYCLE_HINT_KEYS[kind]);
  return `${prefix}: ${hint}${detail ? ` (${detail})` : ""}`;
}

/** A user-requested or superseded load, distinguished from engine diagnostics. */
export function isLifecycleCancellation(error: unknown): boolean {
  return isIpcErrorKind(error, "cancelled");
}

export function nextPollDelay(baseMs: number, failures: number): number {
  const safeBase = Math.max(250, baseMs);
  return Math.min(10_000, safeBase * 2 ** Math.min(4, Math.max(0, failures)));
}

export function shouldPoll(visibility: DocumentVisibilityState | "unknown"): boolean {
  return visibility !== "hidden";
}

export function shouldAutoStart(enabled: boolean, state: string, busy: boolean, consumed: boolean, configRevision: number): boolean {
  return enabled && !consumed && !busy && state === "stopped" && configRevision === 1;
}

/** Header and page copy describe the model, never the API listener, which has its own status. */
export function modelStatusKey(state: ServerState): UnifiedKey {
  return ({
    running: "status.ready", stopped: "status.stopped", starting: "status.loading",
    stopping: "status.unloading", failed: "status.failed", crashed: "status.crashed",
  } as const)[state];
}

export function isServerRunning(state: string): boolean {
  return state === "running";
}

/** Running plus the starting/stopping transitions around it, for callers that must
 * treat the server as unavailable/locked throughout the whole lifecycle transition. */
export function isServerBusy(state: string): boolean {
  return state === "running" || state === "starting" || state === "stopping";
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    void promise.then(resolve, reject).finally(() => { clearTimeout(timer); });
  });
}

/**
 * The override key a refused launch printed, if this failure is one.
 *
 * The correctness gate names a key in its refusal so a user who knows the
 * placement is fine can accept it. The key is only recoverable from that text,
 * and without somewhere to enter it the refusal is a dead end.
 */
export function verificationOverrideKey(text: string | null | undefined): string | null {
  return /verification override key ([0-9a-f]{64})/i.exec(text ?? "")?.[1] ?? null;
}
