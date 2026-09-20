// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./transport.ts', () => ({
  NATIVE_RUNTIME_ERROR: 'Native desktop runtime is unavailable.',
  isNativeRuntimeAvailable: vi.fn(() => true),
  invoke: vi.fn(),
}));

import { invoke, isNativeRuntimeAvailable } from './transport.ts';
import {
  benchmarkSharingOwnedList,
  normalizeNativeError,
  normalizeSharingOrigin,
} from './benchmarkSharing.ts';

const entry = (overrides = {}) => ({
  submission_id: '00000000-0000-4000-8000-000000000001',
  credential_ref: 'cred-ref-1',
  destination: 'https://example.test/v1/benchmark-runs',
  created_at_ms: 1700000000000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true);
});

describe('owned-list wrapper', () => {
  it('defaults to 25, clamps to 100, and passes the opaque cursor unchanged', async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [entry()], next_cursor: 'opaque-1' });
    await benchmarkSharingOwnedList();
    expect(invoke).toHaveBeenCalledWith('benchmark_sharing_owned_list', { limit: 25 });
    await benchmarkSharingOwnedList('opaque-1', 500);
    expect(invoke).toHaveBeenCalledWith('benchmark_sharing_owned_list', { after: 'opaque-1', limit: 100 });
    await benchmarkSharingOwnedList(undefined, 0);
    expect(invoke).toHaveBeenCalledWith('benchmark_sharing_owned_list', { limit: 1 });
  });

  it('rejects malformed ownership records without vault reads', async () => {
    vi.mocked(invoke).mockResolvedValue({ items: [entry({ submission_id: 'not-a-uuid' })], next_cursor: null });
    await expect(benchmarkSharingOwnedList()).rejects.toThrow('invalid response');
    vi.mocked(invoke).mockResolvedValue({ items: 'nope', next_cursor: null });
    await expect(benchmarkSharingOwnedList()).rejects.toThrow('invalid response');
    vi.mocked(invoke).mockResolvedValue({ items: [], next_cursor: 42 });
    await expect(benchmarkSharingOwnedList()).rejects.toThrow('invalid response');
  });

  it('fails closed without a native runtime', async () => {
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
    await expect(benchmarkSharingOwnedList()).rejects.toThrow('unavailable');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('sharing origin policy', () => {  it('accepts root origins and rejects base paths, queries, and credentials', () => {
    expect(normalizeSharingOrigin('https://example.test')).toBe('https://example.test');
    expect(normalizeSharingOrigin('https://example.test/')).toBe('https://example.test');
    expect(() => normalizeSharingOrigin('https://example.test/api')).toThrow('base path');
    expect(() => normalizeSharingOrigin('https://example.test/api/')).toThrow('base path');
    expect(() => normalizeSharingOrigin('https://example.test?x=1')).toThrow();
    expect(() => normalizeSharingOrigin('https://user@example.test')).toThrow();
    expect(() => normalizeSharingOrigin('http://example.test')).toThrow();
    expect(normalizeSharingOrigin('http://127.0.0.1:3000/')).toBe('http://127.0.0.1:3000');
  });
});

describe('structured native errors', () => {
  it('maps known codes with handshake status and Retry-After preserved', () => {
    expect(normalizeNativeError({ code: 'vault_locked', message: 'locked' })).toMatchObject({ kind: 'vault-locked', recoverable: true });
    expect(normalizeNativeError({ code: 'ownership_missing', message: 'gone' })).toMatchObject({ kind: 'credential-missing', serviceCode: 'ownership_missing' });
    expect(normalizeNativeError({ code: 'verification_required', message: 'verify', status: 401, retry_after: '7' }))
      .toMatchObject({ kind: 'verification', serviceCode: 'verification_required', status: 401, retryAfterMs: 7000 });
    expect(normalizeNativeError({ code: 'binding_conflict', message: 'conflict' })).toMatchObject({ kind: 'configuration', recoverable: false });
    expect(normalizeNativeError({ code: 'measurement_active' })).toMatchObject({ kind: 'transport', recoverable: true });
  });

  it('bounds messages and ignores unknown shapes via legacy fallback', () => {
    const long = normalizeNativeError({ code: 'network_error', message: 'x'.repeat(9000) });
    expect(long.message.length).toBeLessThanOrEqual(500);
    expect(normalizeNativeError({ code: 'something_else', message: 'vault is locked' })).toMatchObject({ kind: 'vault-locked' });
    expect(normalizeNativeError(new Error('credential missing for submission'))).toMatchObject({ kind: 'credential-missing' });
    expect(normalizeNativeError('total failure')).toMatchObject({ kind: 'vault-unavailable', message: 'total failure' });
  });
});

describe('native service_code preservation', () => {
  it('carries a validated server code while classifying kind by native code', () => {
    expect(normalizeNativeError({ code: 'network_error', service_code: 'submission_deleted', status: 410, retry_after: '3' }))
      .toMatchObject({ kind: 'transport', serviceCode: 'submission_deleted', status: 410, retryAfterMs: 3000 });
    expect(normalizeNativeError({ code: 'verification_required', service_code: 'ownership_missing' }))
      .toMatchObject({ kind: 'verification', serviceCode: 'ownership_missing' });
  });

  it('drops unknown or unbounded service codes instead of surfacing them', () => {
    expect(normalizeNativeError({ code: 'network_error', service_code: 'token_abc123' }).serviceCode).toBe('network_error');
    expect(normalizeNativeError({ code: 'network_error', service_code: 'x'.repeat(9000) }).serviceCode).toBe('network_error');
    expect(normalizeNativeError({ code: 'network_error', service_code: 42 }).serviceCode).toBe('network_error');
    // Token-looking 43-char strings and valid-code prefixes never pass through.
    expect(normalizeNativeError({ code: 'network_error', service_code: 'A'.repeat(43) }).serviceCode).toBe('network_error');
    expect(normalizeNativeError({ code: 'network_error', service_code: 'verification_required_extra' }).serviceCode).toBe('network_error');
    expect(normalizeNativeError({ code: 'network_error', service_code: 'quota_exceeded' }).serviceCode).toBe('network_error');
  });

  it('accepts the exact native allowlist and preserves handshake status', () => {
    for (const serviceCode of ['not_found', 'invalid_request', 'body_mismatch', 'payload_too_large', 'revision_conflict', 'invalid_csrf', 'rate_limited', 'service_unavailable']) {
      expect(normalizeNativeError({ code: 'network_error', service_code: serviceCode, status: 400 }).serviceCode).toBe(serviceCode);
    }
    expect(normalizeNativeError({ code: 'network_error', service_code: 'body_mismatch', status: 409, retry_after: '2' }))
      .toMatchObject({ kind: 'transport', serviceCode: 'body_mismatch', status: 409, retryAfterMs: 2000 });
  });
});
