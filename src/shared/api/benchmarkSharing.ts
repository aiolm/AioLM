import { invoke, isNativeRuntimeAvailable, NATIVE_RUNTIME_ERROR } from "./transport.ts";
import { parseServiceError } from "@aiolm/benchmark-contracts";
import { HttpError } from "./http.ts";

/** Typed recoverable vault failures; publishing blocks without plaintext fallback. */
export type BenchmarkSharingVaultErrorKind = "vault-locked" | "vault-missing" | "vault-unavailable" | "credential-missing";

export class BenchmarkSharingError extends Error {
  readonly kind: BenchmarkSharingVaultErrorKind | "configuration" | "verification" | "transport";
  readonly recoverable: boolean;
  readonly serviceCode?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(kind: BenchmarkSharingError["kind"], message: string, recoverable = true, details?: { serviceCode?: string; status?: number; retryAfterMs?: number }) {
    super(message);
    this.name = "BenchmarkSharingError";
    this.kind = kind;
    this.recoverable = recoverable;
    if (details?.serviceCode !== undefined) this.serviceCode = details.serviceCode;
    if (details?.status !== undefined) this.status = details.status;
    if (details?.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
  }
}

/** Structured native failure codes owned by the native worker. */
export const NATIVE_ERROR_CODES = [
  "configuration_missing", "vault_locked", "ownership_missing", "vault_unavailable",
  "verification_required", "measurement_active", "cancelled", "network_error",
  "invalid_response", "binding_conflict",
] as const;
export type NativeErrorCode = (typeof NATIVE_ERROR_CODES)[number];
const nativeCodes = new Set<string>(NATIVE_ERROR_CODES);

/**
 * Server codes the native layer may preserve alongside its own code.
 * Exact allowlist shared with the native error boundary; unknown values
 * (including token-looking strings and valid-code prefixes) are dropped so
 * arbitrary error text never becomes WebView metadata.
 */
export const KNOWN_SERVICE_CODES = [
  "verification_required", "ownership_missing", "submission_deleted",
  "rate_limited", "service_unavailable", "not_found",
  "invalid_request", "body_mismatch", "payload_too_large",
  "revision_conflict", "invalid_csrf",
] as const;
export type KnownServiceCode = (typeof KNOWN_SERVICE_CODES)[number];
const serviceCodes = new Set<string>(KNOWN_SERVICE_CODES);

/** Static bounded messages; never raw response dumps containing potential tokens. */
function safeMessage(value: unknown, fallback: string): string {
  if (typeof value === "string" && value.length > 0 && value.length <= 500) return value;
  return fallback;
}

function retryAfterToMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.min(value, 3_600_000);
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}

function statusOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599 ? value : undefined;
}

/**
 * Normalize native invoke rejections. Structured {code,message,status?,retry_after?}
 * failures map by code with website handshake codes/status/Retry-After preserved;
 * anything else falls back to legacy string categorization.
 */
export function normalizeNativeError(value: unknown): BenchmarkSharingError {
  if (value instanceof BenchmarkSharingError) return value;
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.code === "string" && nativeCodes.has(record.code)) {
      const code = record.code as NativeErrorCode;
      const status = statusOf(record.status);
      const retryAfterMs = retryAfterToMs(record.retry_after);
      // A validated server code rides along for dispatch decisions; the user
      // message still comes from the static native-code mapping below.
      const carried = typeof record.service_code === "string" && serviceCodes.has(record.service_code)
        ? record.service_code
        : undefined;
      const details = {
        serviceCode: carried ?? code,
        ...(status !== undefined ? { status } : {}),
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
      switch (code) {
        case "configuration_missing": return new BenchmarkSharingError("configuration", safeMessage(record.message, "Sharing is not configured."), true, details);
        case "vault_locked": return new BenchmarkSharingError("vault-locked", safeMessage(record.message, "The system vault is locked."), true, details);
        case "ownership_missing": return new BenchmarkSharingError("credential-missing", safeMessage(record.message, "No owner key is stored for this submission."), true, details);
        case "vault_unavailable": return new BenchmarkSharingError("vault-unavailable", safeMessage(record.message, "The system vault is unavailable."), true, details);
        case "verification_required": return new BenchmarkSharingError("verification", safeMessage(record.message, "Browser verification is required."), true, details);
        case "measurement_active": return new BenchmarkSharingError("transport", "Pause sharing while a measurement is active.", true, details);
        case "cancelled": return new BenchmarkSharingError("transport", "The sharing request was cancelled.", true, details);
        case "network_error": return new BenchmarkSharingError("transport", safeMessage(record.message, "The sharing service could not be reached."), true, details);
        case "invalid_response": return new BenchmarkSharingError("transport", safeMessage(record.message, "The sharing service returned an invalid response."), true, details);
        case "binding_conflict": return new BenchmarkSharingError("configuration", safeMessage(record.message, "This submission is already bound to different data."), false, details);
      }
    }
  }
  const raw = value instanceof Error ? value.message
    : value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).message === "string"
      ? (value as Record<string, unknown>).message as string
      : String(value);
  const message = raw.length > 500 ? raw.slice(0, 500) : raw;
  if (/locked/i.test(message)) return new BenchmarkSharingError("vault-locked", message, true);
  if (/missing|not found|no credential/i.test(message)) return new BenchmarkSharingError("credential-missing", message, true);
  return new BenchmarkSharingError("vault-unavailable", message, true);
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isNativeRuntimeAvailable()) throw new BenchmarkSharingError("transport", NATIVE_RUNTIME_ERROR, true);
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw normalizeNativeError(error);
  }
}

export interface SharingConfiguration { base_url: string | null }
export interface SharingPrepareResult { credential_ref: string; body_sha256: string; destination: string }
export interface SharingVerification { session_id: string; verification_url: string; expires_at: string }
export type VerificationStatus = "pending" | "verified" | "expired";
export interface SharingPollResult { status: VerificationStatus; expires_at: string }
export interface SharingSubmitResult { status: number; body: string; retry_after?: string }
export interface SharingRecoveryImport { submission_id: string; credential_ref: string; destination: string }
export interface OwnedEntry { submission_id: string; credential_ref: string; destination: string; created_at_ms: number }
export interface OwnedListResult { items: OwnedEntry[]; next_cursor: string | null }

const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Configured sharing endpoint is an origin: root path only, no query/fragment/credentials. */
export function normalizeSharingOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new BenchmarkSharingError("configuration", "The sharing service requires an HTTPS origin without credentials, query, or fragment.", true);
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new BenchmarkSharingError("configuration", "The sharing service requires an HTTPS origin without credentials, query, or fragment.", true);
  }
  if (parsed.pathname !== "/") throw new BenchmarkSharingError("configuration", "The sharing service must be configured as an origin without a base path.", true);
  const loopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) {
    throw new BenchmarkSharingError("configuration", "The sharing service requires an HTTPS origin.", true);
  }
  return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

function validateOwnedList(value: unknown): OwnedListResult {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.items) || !(typeof record.next_cursor === "string" || record.next_cursor === null)) {
    throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
  }
  for (const item of record.items) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
    const entry = item as Record<string, unknown>;
    if (typeof entry.submission_id !== "string" || !UUID_V4.test(entry.submission_id)) throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
    if (typeof entry.credential_ref !== "string" || !entry.credential_ref || typeof entry.destination !== "string" || !entry.destination) {
      throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
    }
    if (typeof entry.created_at_ms !== "number" || !Number.isFinite(entry.created_at_ms)) throw new BenchmarkSharingError("transport", "The ownership list returned an invalid response.", true);
  }
  return value as OwnedListResult;
}

/** Service URL read through native command, not WebView env secrets. Fail closed if absent. */
export const benchmarkSharingConfiguration = () => call<SharingConfiguration>("benchmark_sharing_configuration");

export const benchmarkSharingPrepare = (submissionId: string, body: string) =>
  call<SharingPrepareResult>("benchmark_sharing_prepare", { submissionId, body });

export const benchmarkSharingBeginVerification = (submissionId: string) =>
  call<SharingVerification>("benchmark_sharing_begin_verification", { submissionId });

export const benchmarkSharingPollVerification = (submissionId: string, sessionId: string) =>
  call<SharingPollResult>("benchmark_sharing_poll_verification", { submissionId, sessionId });

export const benchmarkSharingSubmit = (submissionId: string, body: string) =>
  call<SharingSubmitResult>("benchmark_sharing_submit", { submissionId, body });

export const benchmarkSharingCancel = (submissionId: string) =>
  call<void>("benchmark_sharing_cancel", { submissionId });

export const benchmarkSharingRecoveryExport = (submissionId: string) =>
  call<boolean>("benchmark_sharing_recovery_export", { submissionId });

export const benchmarkSharingRecoveryImport = () =>
  call<SharingRecoveryImport | null>("benchmark_sharing_recovery_import");

export const benchmarkSharingRecoveryCopy = (submissionId: string) =>
  call<boolean>("benchmark_sharing_recovery_copy", { submissionId });

export const benchmarkSharingOpenManagement = (submissionId: string) =>
  call<void>("benchmark_sharing_open_management", { submissionId });

/**
 * Paginated nonsecret ownership records without opening the OS vault,
 * independent of queue/history cache. Opaque cursor passed through unchanged.
 */
export async function benchmarkSharingOwnedList(after?: string, limit = 25): Promise<OwnedListResult> {
  const page = Number.isInteger(limit) ? limit : 25;
  const clamped = Math.min(100, Math.max(1, page));
  const args: Record<string, unknown> = { limit: clamped };
  if (after !== undefined) {
    if (typeof after !== "string" || !after) throw new BenchmarkSharingError("transport", "Invalid ownership list cursor.", true);
    args.after = after;
  }
  const result = await call<OwnedListResult>("benchmark_sharing_owned_list", args);
  return validateOwnedList(result);
}

/** Convert a native submit response into a receipt or a typed dispatch error. */
export function throwForNativeSubmit(response: SharingSubmitResult, submissionId: string, validateReceipt: (value: unknown) => { id: string; submission_id: string }): { id: string; submission_id: string } {
  if (response.status === 200 || response.status === 201) {
    try {
      return validateReceipt(JSON.parse(response.body));
    } catch {
      throw new HttpError("invalid_response", "The server returned an invalid response.", false, response.status);
    }
  }
  const parsed = parseServiceError(response.status, response.body, response.retry_after ? retryMs(response.retry_after) : undefined);
  const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
  const error = new HttpError(parsed.recoverable || retryable ? "http" : "http", parsed.message, retryable || parsed.recoverable, response.status, parsed.retryAfterMs);
  (error as HttpError & { serviceCode?: string }).serviceCode = parsed.code;
  if (parsed.terminal) (error as HttpError & { serviceCode?: string }).serviceCode = parsed.code;
  void submissionId;
  throw error;
}

function retryMs(value: string): number | undefined {
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000;
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) ? Math.max(0, delay) : undefined;
}
