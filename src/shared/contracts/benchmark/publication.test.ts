// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { BenchmarkPublicationRequest } from '@aiolm/benchmark-contracts';
import { createPublicationController, type PublicationNative } from '../../sharing/publicationController.ts';
import { createBenchmarkOutbox, type BenchmarkOutboxStore, type MeasurementActivity, type QueuedBenchmark } from '../../sharing/outbox.ts';
import { createPublicationBody } from './publication.ts';

const submissionId = '00000000-0000-4000-8000-000000000001';

function requestFixture(rowCount = 1, description_md = ''): BenchmarkPublicationRequest {
  return {
    benchmark: {
      schema_version: 1, submission_id: submissionId, app_version: '0.1.9', method: null,
      workload: { corpus: 'novel_ko', corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [1], repetitions: 1, warmup: true },
      model: { status: 'unidentified', sha256: null, size_bytes: null },
      runtime: { name: 'llama.cpp', version: null, backend: 'cpu', build: 'synthetic' },
      environment: null, execution: { context_size: 4096, parallel: 1, settings: null },
      measurements: { status: 'complete', rows: Array.from({ length: rowCount }, (_, index) => ({
        prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: index + 1,
        completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10, pp_tps: 100,
        tg_tps: 100, e2e_ms: 1380, total_tps: 93, peak_memory_bytes: null,
        timing_source: 'client', failed: false,
      })) },
    },
    description_md,
  };
}

function countStringify<T>(run: () => T): { value: T; count: number } {
  const stringify = vi.spyOn(JSON, 'stringify');
  try {
    return { value: run(), count: stringify.mock.calls.length };
  } finally {
    stringify.mockRestore();
  }
}

function outboxFixture() {
  const rows = new Map<string, QueuedBenchmark>();
  const store: BenchmarkOutboxStore = {
    list: async (_page) => [...rows.values()],
    get: async (id) => rows.get(id),
    cooldown: async (_destination, _until) => 0,
    mutate: async (id, update) => {
      const next = update(rows.get(id));
      if (next === undefined) rows.delete(id);
      else rows.set(id, next);
      return next;
    },
  };
  const measurement: MeasurementActivity = { isActive: () => false, subscribe: () => () => undefined };
  return {
    rows,
    measurement,
    outbox: createBenchmarkOutbox({ store, measurement, now: () => 1000, uuid: () => 'lease-token' }),
  };
}

describe('publication body normalization', () => {
  it('keeps one exact serialization for a large reviewed payload', () => {
    const counted = countStringify(() => createPublicationBody(requestFixture(1000)));
    expect(counted.count).toBe(1);
    expect(counted.value.submissionId).toBe(submissionId);
  });

  it('keeps controller native bytes, durable bytes, hash input, and identity aligned', async () => {
    const fixture = outboxFixture();
    let preparedBody = '';
    const native: PublicationNative = {
      prepare: async (_id, body) => {
        preparedBody = body;
        return { credential_ref: 'credential-1', body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'), destination: 'https://example.test/v1/benchmark-runs' };
      },
      beginVerification: async () => ({ session_id: 'session-1', verification_url: 'https://example.test/verify', expires_at: '2030-01-01T00:00:00.000Z' }),
      pollVerification: async () => ({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' }),
      cancel: async () => undefined,
    };
    const controller = createPublicationController({ measurement: fixture.measurement, outbox: fixture.outbox, native });
    const request = requestFixture(1000);
    const counted = await (async () => {
      const stringify = vi.spyOn(JSON, 'stringify');
      try {
        const result = await controller.prepare(request, { runId: 'synthetic-run' });
        return { result, count: stringify.mock.calls.length };
      } finally {
        stringify.mockRestore();
      }
    })();
    const stored = fixture.rows.get(submissionId);
    const direct = createPublicationBody(request);
    expect(counted.count).toBe(3);
    expect(counted.result.destination).toBe('https://example.test/v1/benchmark-runs');
    expect(preparedBody).toBe(direct.body);
    expect(stored?.requestBody).toBe(direct.body);
    expect(stored?.payload).toEqual(request.benchmark);
    expect(direct.submissionId).toBe(submissionId);
    expect(stored?.bodySha256).toBe(createHash('sha256').update(direct.body, 'utf8').digest('hex'));
  });

  it('rejects a private benchmark field before durable write or native binding', async () => {
    const fixture = outboxFixture();
    let nativeCalls = 0;
    const native: PublicationNative = {
      prepare: async () => {
        nativeCalls += 1;
        return { credential_ref: 'credential-1', body_sha256: 'a'.repeat(64), destination: 'https://example.test/v1/benchmark-runs' };
      },
      beginVerification: async () => ({ session_id: 'session-1', verification_url: 'https://example.test/verify', expires_at: '2030-01-01T00:00:00.000Z' }),
      pollVerification: async () => ({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' }),
      cancel: async () => undefined,
    };
    const controller = createPublicationController({ measurement: fixture.measurement, outbox: fixture.outbox, native });
    const request = requestFixture();
    Object.assign(request.benchmark, { local_path: 'synthetic-private.gguf' });
    await expect(controller.prepare(request)).rejects.toThrow('Invalid public benchmark field: benchmark');
    expect(fixture.rows.size).toBe(0);
    expect(nativeCalls).toBe(0);
  });
});

describe('publication validation boundaries', () => {
  it.each([
    ['description over the 4000-codepoint limit', requestFixture(1, 'x'.repeat(4001)), 'Publication description exceeds 4000 characters.'],
    ['row count over the public schema limit', requestFixture(10001), 'Invalid public benchmark field: benchmark.measurements.rows'],
    ['an unknown wrapper key', { ...requestFixture(), unexpected: true }, 'Invalid public benchmark field: benchmark'],
  ])('rejects %s before emitting a body', (_name, value, error) => {
    expect(() => createPublicationBody(value as BenchmarkPublicationRequest)).toThrow(error);
  });

  it('ignores a wrapper prototype serializer when freezing user bytes', () => {
    const request = requestFixture();
    Object.setPrototypeOf(request, { toJSON: () => ({ ...request, local_path: 'synthetic-private.gguf' }) });
    const body = createPublicationBody(request).body;
    expect(body).not.toContain('local_path');
  });
});
