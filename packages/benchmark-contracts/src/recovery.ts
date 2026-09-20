/** Owner recovery encoding shared by the app, native vault, and website. */

export const RECOVERY_PREFIX = 'aiolm-recovery-v1.';
export const RECOVERY_MAX_FILE_BYTES = 4096;
const UUID_V4 = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface BenchmarkRecoveryPayload {
  version: 1;
  origin: string;
  submission_id: string;
  secret: string;
}

const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

export function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let output = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    output += alphabet[(triple >> 18) & 63] + alphabet[(triple >> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(triple >> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[triple & 63];
  }
  return output;
}

export function base64UrlDecode(value: string): Uint8Array {
  if (!BASE64URL.test(value) || value.length === 0 || value.length % 4 === 1) throw new Error('Invalid recovery encoding.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const indices = new Map<string, number>();
  for (let index = 0; index < alphabet.length; index += 1) indices.set(alphabet[index], index);
  const output: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const chunk = value.slice(index, index + 4);
    const a = indices.get(chunk[0]!);
    const b = indices.get(chunk[1]!);
    const c = chunk.length > 2 ? indices.get(chunk[2]!) : 0;
    const d = chunk.length > 3 ? indices.get(chunk[3]!) : 0;
    if (a === undefined || b === undefined || (chunk.length > 2 && c === undefined) || (chunk.length > 3 && d === undefined)) {
      throw new Error('Invalid recovery encoding.');
    }
    const triple = (a << 18) | (b << 12) | ((c ?? 0) << 6) | (d ?? 0);
    output.push((triple >> 16) & 255);
    if (chunk.length > 2) output.push((triple >> 8) & 255);
    if (chunk.length > 3) output.push(triple & 255);
  }
  const bytes = new Uint8Array(output);
  // Reject noncanonical trailing bits the way URL_SAFE_NO_PAD decoders do.
  if (base64UrlEncode(bytes) !== value) throw new Error('Invalid recovery encoding.');
  return bytes;
}

/**
 * Recovery service origin: an origin, not a base path. Non-root paths are rejected
 * rather than silently stripped. Generic legacy HTTP client base paths remain
 * supported separately via normalizeBaseUrl in service.ts.
 */
export function normalizeServiceOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid recovery service origin.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('Invalid recovery service origin.');
  if (parsed.pathname !== '/') throw new Error('Invalid recovery service origin.');
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol === 'https:') {
    // Valid production origin.
  } else if (parsed.protocol === 'http:' && loopback) {
    // Explicit debug loopback only.
  } else {
    throw new Error('Recovery service origin must use HTTPS.');
  }
  return `${parsed.protocol}//${parsed.host.toLowerCase()}`;
}

function validateSecret(value: unknown): string {
  if (typeof value !== 'string' || !BASE64URL.test(value)) throw new Error('Invalid recovery secret.');
  const bytes = base64UrlDecode(value);
  if (bytes.length !== 32) throw new Error('Invalid recovery secret.');
  return value;
}

/** A recovered owner secret conveys exactly the original authority. */
export function decodeRecoveryCode(code: string, expectedOrigin?: string): BenchmarkRecoveryPayload {
  if (typeof code !== 'string' || !code.startsWith(RECOVERY_PREFIX)) throw new Error('Invalid recovery code.');
  const encoded = code.slice(RECOVERY_PREFIX.length);
  if (new TextEncoder().encode(code).length > RECOVERY_MAX_FILE_BYTES) throw new Error('Recovery file is too large.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(base64UrlDecode(encoded)));
  } catch {
    throw new Error('Invalid recovery code.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid recovery code.');
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 4 || keys[0] !== 'origin' || keys[1] !== 'secret' || keys[2] !== 'submission_id' || keys[3] !== 'version') {
    throw new Error('Invalid recovery code.');
  }
  if (record.version !== 1) throw new Error('Unsupported recovery version.');
  if (typeof record.origin !== 'string' || typeof record.submission_id !== 'string') throw new Error('Invalid recovery code.');
  const origin = normalizeServiceOrigin(record.origin);
  if (!UUID_V4.test(record.submission_id)) throw new Error('Invalid recovery submission.');
  const secret = validateSecret(record.secret);
  if (expectedOrigin !== undefined && normalizeServiceOrigin(expectedOrigin) !== origin) {
    throw new Error('Recovery code does not belong to this service.');
  }
  if (!hasOwn(record, 'version') || !hasOwn(record, 'origin') || !hasOwn(record, 'submission_id') || !hasOwn(record, 'secret')) {
    throw new Error('Invalid recovery code.');
  }
  return { version: 1, origin, submission_id: record.submission_id, secret };
}

export function encodeRecoveryCode(payload: BenchmarkRecoveryPayload): string {
  if (payload.version !== 1) throw new Error('Unsupported recovery version.');
  const origin = normalizeServiceOrigin(payload.origin);
  if (!UUID_V4.test(payload.submission_id)) throw new Error('Invalid recovery submission.');
  const secret = validateSecret(payload.secret);
  const body = JSON.stringify({ version: 1, origin, submission_id: payload.submission_id, secret });
  if (new TextEncoder().encode(RECOVERY_PREFIX + base64UrlEncode(new TextEncoder().encode(body))).length > RECOVERY_MAX_FILE_BYTES) {
    throw new Error('Recovery file is too large.');
  }
  return RECOVERY_PREFIX + base64UrlEncode(new TextEncoder().encode(body));
}

/** Deterministic fixture shared with native/website implementations. */
export const RECOVERY_FIXTURE: BenchmarkRecoveryPayload = {
  version: 1,
  origin: 'https://benchmarks.example.test',
  submission_id: '00000000-0000-4000-8000-000000000001',
  secret: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
};
