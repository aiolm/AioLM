// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/benchmarkSharing.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/benchmarkSharing.ts')>();
  return { ...actual, benchmarkSharingSubmit: vi.fn(), benchmarkSharingCancel: vi.fn(async () => undefined) };
});

import { benchmarkSharingCancel, benchmarkSharingSubmit } from '../api/benchmarkSharing.ts';
import { createNativeSelectedTransport } from './nativeTransport.ts';
import type { QueuedBenchmark } from './outbox.ts';

const entry = (overrides: Partial<QueuedBenchmark> = {}): QueuedBenchmark => ({
  id: '00000000-0000-4000-8000-000000000001',
  payload: { submission_id: '00000000-0000-4000-8000-000000000001' } as QueuedBenchmark['payload'],
  state: 'pending',
  createdAt: 1000,
  attempts: 0,
  nextAttemptAt: 0,
  ...overrides,
});

describe('native transport cancellation', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('forwards user abort to native cancel and removes its listener', async () => {
    vi.mocked(benchmarkSharingSubmit).mockImplementation(() => new Promise(() => {}));
    const transport = createNativeSelectedTransport('https://example.test/v1/benchmark-runs');
    const aborter = new AbortController();
    const added = vi.spyOn(aborter.signal, 'addEventListener');
    const removed = vi.spyOn(aborter.signal, 'removeEventListener');
    const started = Date.now();
    const sending = transport.submitSnapshot(entry({ requestBody: '{"exact":true}' }), aborter.signal);
    await new Promise((resolve) => setTimeout(resolve, 20));
    aborter.abort();
    await expect(sending).rejects.toMatchObject({ code: 'aborted' });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(benchmarkSharingCancel).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    expect(removed.mock.calls.length).toBe(added.mock.calls.length);
    expect(added.mock.calls.length).toBeGreaterThan(0);
  });

  it('submits exact persisted bytes and preserves receipts without a signal', async () => {
    vi.mocked(benchmarkSharingSubmit).mockResolvedValue({
      status: 201,
      body: JSON.stringify({ submission_id: '00000000-0000-4000-8000-000000000001', id: 'public-1' }),
    });
    const transport = createNativeSelectedTransport('https://example.test/v1/benchmark-runs');
    await expect(transport.submitSnapshot(entry({ requestBody: '{"exact":true}' }))).resolves.toMatchObject({ id: 'public-1' });
    expect(benchmarkSharingSubmit).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', '{"exact":true}');
    expect(benchmarkSharingCancel).not.toHaveBeenCalled();
  });
});
