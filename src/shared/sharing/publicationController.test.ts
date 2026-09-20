// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createPublicationController } from './publicationController.ts';
import type { MeasurementActivity } from './outbox.ts';

function measurementFixture() {
  let active = false;
  const listeners = new Set<() => void>();
  const measurement: MeasurementActivity = {
    isActive: () => active,
    subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; },
  };
  return {
    measurement,
    setActive: (value: boolean) => { active = value; listeners.forEach((cb) => cb()); },
    listenerCount: () => listeners.size,
  };
}

function outboxFixture(errorCode?: string) {
  return {
    enqueuePublication: vi.fn(),
    dispatchSelected: vi.fn(async () => 1),
    get: vi.fn(async () => ({ error: errorCode ? { code: errorCode } : undefined }) as never),
  };
}

describe('publication verification polling', () => {
  it('returns without cancelling once verified', async () => {
    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(async (): Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }> => ({ status: 'pending' as const, expires_at: '2030-01-01T00:00:00.000Z' })), cancel: vi.fn(async () => undefined) };
    native.pollVerification.mockResolvedValueOnce({ status: 'pending', expires_at: '2030-01-01T00:00:00.000Z' });
    native.pollVerification.mockResolvedValueOnce({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' });
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    await controller.pollUntilVerified('sub-1', 'sess-1', undefined, 60_000, 5);
    expect(native.cancel).not.toHaveBeenCalled();
    expect(m.listenerCount()).toBe(0);
  });

  it('removes every abort listener it adds', async () => {
    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(async (): Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }> => ({ status: 'verified' as const, expires_at: '2030-01-01T00:00:00.000Z' })), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    const aborter = new AbortController();
    const added = vi.spyOn(aborter.signal, 'addEventListener');
    const removed = vi.spyOn(aborter.signal, 'removeEventListener');
    native.pollVerification.mockResolvedValueOnce({ status: 'pending', expires_at: '2030-01-01T00:00:00.000Z' });
    await controller.pollUntilVerified('sub-1', 'sess-1', aborter.signal, 60_000, 5);
    expect(added.mock.calls.length).toBeGreaterThan(0);
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
    expect(m.listenerCount()).toBe(0);
  });

  it('cancels native work on timeout', async () => {
    const m = measurementFixture();
    let time = 1000;
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(async () => { time += 5000; return { status: 'pending' as const, expires_at: '2030-01-01T00:00:00.000Z' }; }), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native, now: () => time });
    await expect(controller.pollUntilVerified('sub-1', 'sess-1', undefined, 1000, 5)).rejects.toThrow('timed out');
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
    expect(m.listenerCount()).toBe(0);
  });

  it('cancels native work on user abort during the wait', async () => {
    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(async (): Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }> => ({ status: 'pending' as const, expires_at: '2030-01-01T00:00:00.000Z' })), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    const aborter = new AbortController();
    const polling = controller.pollUntilVerified('sub-1', 'sess-1', aborter.signal, 60_000, 5000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(polling).rejects.toThrow('cancelled');
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
    expect(m.listenerCount()).toBe(0);
  });

  it('cancels native work when measurement starts mid-poll', async () => {
    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(async (): Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }> => ({ status: 'pending' as const, expires_at: '2030-01-01T00:00:00.000Z' })), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    const polling = controller.pollUntilVerified('sub-1', 'sess-1', undefined, 60_000, 5000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setActive(true);
    await expect(polling).rejects.toThrow('measurement');
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
  });
});

describe('hung native calls', () => {
  it('settles promptly on user abort while native poll never resolves', async () => {
    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(() => new Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }>(() => {})), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    const aborter = new AbortController();
    const started = Date.now();
    const polling = controller.pollUntilVerified('sub-1', 'sess-1', aborter.signal, 300_000, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(polling).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
    expect(m.listenerCount()).toBe(0);
  });

  it('settles promptly on measurement start while native poll never resolves', async () => {    const m = measurementFixture();
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(() => new Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }>(() => {})), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox: outboxFixture(), native });
    const started = Date.now();
    const polling = controller.pollUntilVerified('sub-1', 'sess-1', undefined, 300_000, 30_000);
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setActive(true);
    await expect(polling).rejects.toThrow('measurement');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
  });

  it('settles promptly on user abort while native begin never resolves', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture('verification_required');
    outbox.dispatchSelected.mockResolvedValue(0);
    const native = { prepare: vi.fn(), beginVerification: vi.fn(() => new Promise<{ session_id: string; verification_url: string; expires_at: string }>(() => {})), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    const aborter = new AbortController();
    const started = Date.now();
    const publishing = controller.publishSelected('sub-1', { destination: 'https://example.test/v1/benchmark-runs', submitSnapshot: vi.fn() }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(publishing).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(native.cancel).toHaveBeenCalledWith('sub-1');
    expect(m.listenerCount()).toBe(0);
  });
});

describe('prepare abort race', () => {
  const requestFixture = () => ({
    benchmark: {
      schema_version: 1 as const, submission_id: '00000000-0000-4000-8000-000000000001', app_version: null, method: null,
      workload: { corpus: 'novel_en' as const, corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [1], repetitions: 1, warmup: false },
      model: { status: 'unidentified' as const, sha256: null, size_bytes: null },
      runtime: { name: 'llama.cpp' as const, version: null, backend: null, build: null },
      environment: null, execution: { context_size: 4096, parallel: 1, settings: null },
      measurements: { status: 'complete' as const, rows: [] },
    },
    description_md: 'notes',
  });

  it('persists the unbound wrapper before native binding, then attaches metadata', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture();
    const binding = { credential_ref: 'cred-1', body_sha256: 'a'.repeat(64), destination: 'https://example.test/v1/benchmark-runs' };
    const native = { prepare: vi.fn(async () => binding), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    outbox.enqueuePublication.mockResolvedValue({ id: 'x' });
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    const request = requestFixture();
    await controller.prepare(request, { runId: 'run-1' });
    expect(native.prepare).toHaveBeenCalledTimes(1);
    expect(outbox.enqueuePublication).toHaveBeenCalledTimes(2);
    // First call persists the exact unbound wrapper with no network metadata.
    expect(outbox.enqueuePublication.mock.calls[0][0]).toEqual(request);
    expect(outbox.enqueuePublication.mock.calls[0][1]).toEqual({ source: { runId: 'run-1' } });
    // Second call idempotently attaches the returned binding.
    expect(outbox.enqueuePublication.mock.calls[1][1]).toMatchObject({
      credentialRef: 'cred-1', bodySha256: 'a'.repeat(64),
    });
    expect(m.listenerCount()).toBe(0);
  });

  it('makes zero native calls when persistence fails before binding', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture();
    outbox.enqueuePublication.mockRejectedValue(new Error('Quota exceeded'));
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    await expect(controller.prepare(requestFixture(), { runId: 'run-1' })).rejects.toThrow('Quota exceeded');
    expect(native.prepare).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
    expect(outbox.enqueuePublication).toHaveBeenCalledTimes(1);
  });

  it('keeps the unbound wrapper durable when the user aborts a hung native binding', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture();
    const native = { prepare: vi.fn(() => new Promise<{ credential_ref: string; body_sha256: string; destination: string }>(() => {})), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    const aborter = new AbortController();
    const started = Date.now();
    const preparing = controller.prepare(requestFixture(), { runId: 'run-1' }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(preparing).rejects.toThrow('cancelled');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(native.cancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    // Exactly one persistence call: the unbound wrapper, never the attach.
    expect(outbox.enqueuePublication).toHaveBeenCalledTimes(1);
    expect(outbox.enqueuePublication.mock.calls[0][1]).toEqual({ source: { runId: 'run-1' } });
    expect(m.listenerCount()).toBe(0);
  });

  it('keeps the unbound wrapper durable when measurement starts mid-binding', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture();
    const native = { prepare: vi.fn(() => new Promise<{ credential_ref: string; body_sha256: string; destination: string }>(() => {})), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    const started = Date.now();
    const preparing = controller.prepare(requestFixture(), { runId: 'run-1' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    m.setActive(true);
    await expect(preparing).rejects.toThrow('measurement');
    expect(Date.now() - started).toBeLessThan(5000);
    expect(native.cancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(outbox.enqueuePublication).toHaveBeenCalledTimes(1);
  });

  it('ignores late binding completion after abort and never attaches', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture();
    let resolvePrepare!: (value: { credential_ref: string; body_sha256: string; destination: string }) => void;
    const native = { prepare: vi.fn(() => new Promise<{ credential_ref: string; body_sha256: string; destination: string }>((resolve) => { resolvePrepare = resolve; })), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    const aborter = new AbortController();
    const preparing = controller.prepare(requestFixture(), { runId: 'run-1' }, aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(preparing).rejects.toThrow('cancelled');
    resolvePrepare({ credential_ref: 'cred-1', body_sha256: 'h', destination: 'https://example.test/v1/benchmark-runs' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The pre-persisted unbound wrapper stands alone; the late binding is dropped.
    expect(outbox.enqueuePublication).toHaveBeenCalledTimes(1);
  });
});

describe('publish replay and ownership', () => {
  it('runs CAPTCHA verification only for verification_required', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture('verification_required');
    outbox.dispatchSelected.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
    const native = { prepare: vi.fn(), beginVerification: vi.fn(async () => ({ session_id: 'sess-1', verification_url: 'https://example.test/verify/sess-1', expires_at: '2030-01-01T00:00:00.000Z' })), pollVerification: vi.fn(async (): Promise<{ status: 'pending' | 'verified' | 'expired'; expires_at: string }> => ({ status: 'verified' as const, expires_at: '2030-01-01T00:00:00.000Z' })), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    await expect(controller.publishSelected('sub-1', { destination: 'https://example.test/v1/benchmark-runs', submitSnapshot: vi.fn() })).resolves.toBe(1);
    expect(native.beginVerification).toHaveBeenCalledTimes(1);
  });

  it('leaves ownership_missing to key recovery instead of CAPTCHA', async () => {
    const m = measurementFixture();
    const outbox = outboxFixture('ownership_missing');
    outbox.dispatchSelected.mockResolvedValue(0);
    const native = { prepare: vi.fn(), beginVerification: vi.fn(), pollVerification: vi.fn(), cancel: vi.fn(async () => undefined) };
    const controller = createPublicationController({ measurement: m.measurement, outbox, native });
    await expect(controller.publishSelected('sub-1', { destination: 'https://example.test/v1/benchmark-runs', submitSnapshot: vi.fn() })).resolves.toBe(0);
    expect(native.beginVerification).not.toHaveBeenCalled();
    expect(native.cancel).not.toHaveBeenCalled();
  });
});
