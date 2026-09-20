/** Website wire contract shared by the app client, native transport, and website server. */

/** Recoverable user-action blocks; a new verification or owner proof can proceed. */
export const RECOVERABLE_SERVICE_ERRORS = ['verification_required', 'ownership_missing'] as const;
/** Terminal record state; never retried automatically. */
export const TERMINAL_SERVICE_ERRORS = ['submission_deleted'] as const;

export type RecoverableServiceError = (typeof RECOVERABLE_SERVICE_ERRORS)[number];
export type TerminalServiceError = (typeof TERMINAL_SERVICE_ERRORS)[number];

export interface ServiceErrorBody {
  error: { code: string; message: string };
}

export interface ParsedServiceError {
  code: string;
  message: string;
  status: number;
  retryAfterMs?: number;
  recoverable: boolean;
  terminal: boolean;
}

export function isRecoverableServiceCode(code: string): boolean {
  return (RECOVERABLE_SERVICE_ERRORS as readonly string[]).includes(code);
}

export function isTerminalServiceCode(code: string): boolean {
  return (TERMINAL_SERVICE_ERRORS as readonly string[]).includes(code);
}

/** Preserve machine-readable error body and Retry-After; never retain response secrets. */
export function parseServiceError(status: number, body: string, retryAfterMs?: number): ParsedServiceError {
  let code = 'http_error';
  let message = `HTTP ${status}`;
  try {
    const parsed = JSON.parse(body) as Partial<ServiceErrorBody>;
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error.code === 'string') {
      code = parsed.error.code;
      if (typeof parsed.error.message === 'string' && parsed.error.message.length > 0) {
        message = parsed.error.message.slice(0, 500);
      }
    }
  } catch {
    // Keep the HTTP status when the error body is not machine-readable.
  }
  return {
    code,
    message,
    status,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    recoverable: isRecoverableServiceCode(code),
    terminal: isTerminalServiceCode(code),
  };
}

/** Base URL policy: HTTPS required except explicit debug loopback; no credentials/query/fragment. */
export function normalizeBaseUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('The sharing service requires an HTTPS base URL without credentials, query, or fragment.');
  }
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('The sharing service requires an HTTPS base URL without credentials, query, or fragment.');
  }
  return parsed.href.replace(/\/+$/, '');
}

/** Fixed POST endpoint for new publications; no redirects or cookies on the native path. */
export function benchmarkRunsUrl(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/v1/benchmark-runs`;
}

/** SHA-256 hex of exact request bytes, bound to the upload session. */
export function assertBodySha256(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid publication body hash.');
  return value;
}

export interface UploadSessionRequest {
  submission_id: string;
  body_sha256: string;
}

export interface UploadSessionResponse {
  session_id: string;
  verification_url: string;
  expires_at: string;
}

export type UploadSessionStatus = 'pending' | 'verified' | 'expired';

export interface UploadSessionPoll {
  status: UploadSessionStatus;
  expires_at: string;
}

/** Timestamps are ISO8601 over the wire. */
export function assertIsoTimestamp(value: string): string {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Invalid service timestamp.');
  return value;
}
