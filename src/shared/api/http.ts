/** HTTP primitives usable by the desktop app and a browser client. */
export type HttpErrorCode = "http" | "network" | "timeout" | "aborted" | "response_too_large" | "invalid_response";

export class HttpError extends Error {
  readonly code: HttpErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    code: HttpErrorCode,
    message: string,
    retryable = false,
    status?: number,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HttpError";
    this.code = code;
    this.retryable = retryable;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export async function readBoundedResponseText(response: Response, maxBytes = 1024 * 1024): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("Invalid response size limit.");
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new HttpError("response_too_large", "The response body exceeds the configured size limit.");
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } finally {
    try { await reader.cancel(); } catch { /* A disconnected stream may already be closed. */ }
    reader.releaseLock();
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const delay = /^\d+$/.test(value.trim()) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

export interface JsonRequestOptions extends Omit<RequestInit, "signal"> {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetcher?: typeof fetch;
}

/** A single attempt; callers decide whether their operation can safely be retried. */
export async function requestJson<T>(
  url: string,
  validate: (value: unknown) => T,
  options: JsonRequestOptions = {},
): Promise<T> {
  const { signal, timeoutMs = 30_000, maxResponseBytes = 1024 * 1024, fetcher = fetch, ...init } = options;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new RangeError("Invalid HTTP timeout.");
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new HttpError("aborted", "Request cancelled.");
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      // Do not retain server error bodies, which may contain echoed credentials or local data.
      const retryAfterMs = retryAfterMilliseconds(response.headers.get("Retry-After"));
      try { await response.body?.cancel(); } catch { /* The response may already have disconnected. */ }
      throw new HttpError("http", `HTTP ${response.status}`, response.status === 408 || response.status === 429 || response.status >= 500, response.status, retryAfterMs);
    }
    const body = await readBoundedResponseText(response, maxResponseBytes);
    try { return validate(JSON.parse(body)); }
    catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError("invalid_response", "The server returned an invalid response.");
    }
  } catch (error) {
    if (timedOut) throw new HttpError("timeout", "The request timed out.", true);
    if (signal?.aborted) throw new HttpError("aborted", "Request cancelled.");
    if (error instanceof HttpError) throw error;
    throw new HttpError("network", "The server could not be reached.", true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
