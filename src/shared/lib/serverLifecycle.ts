export type LifecycleErrorKind = "timeout" | "port" | "executable" | "model" | "memory" | "unknown";

export function classifyLifecycleError(error: unknown): LifecycleErrorKind {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) return "timeout";
  if (text.includes("address already in use") || text.includes("port") && (text.includes("use") || text.includes("bind"))) return "port";
  if (text.includes("not found") || text.includes("no such file") || text.includes("executable")) return "executable";
  if (text.includes("model") && (text.includes("load") || text.includes("file") || text.includes("invalid"))) return "model";
  if (text.includes("out of memory") || text.includes("oom") || text.includes("vram") || text.includes("memory")) return "memory";
  return "unknown";
}

export function lifecycleErrorMessage(action: "start" | "stop", error: unknown): string {
  const kind = classifyLifecycleError(error);
  const detail = error instanceof Error ? error.message : String(error);
  const prefix = action === "start" ? "Server start failed" : "Server stop failed";
  const hint = {
    timeout: "The operation timed out. Check runtime diagnostics and try again.",
    port: "The configured port is already in use. Choose another port or stop the conflicting process.",
    executable: "The runtime executable could not be found. Check the selected runtime installation.",
    model: "The selected model could not be loaded. Check the model path and file integrity.",
    memory: "There is not enough available memory or VRAM for this configuration.",
    unknown: "Open diagnostics for the runtime log and retry after correcting the issue.",
  }[kind];
  return `${prefix}: ${hint}${detail ? ` (${detail})` : ""}`;
}

export function isLifecycleCancellation(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return text.includes("cancelled") || text.includes("canceled");
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
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export function createErrorId(now = Date.now()): string {
  return `LB-${now.toString(36).toUpperCase()}`;
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
