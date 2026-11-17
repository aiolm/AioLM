// @vitest-environment node
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { BenchmarkPublicationRequest } from '@aiolm/benchmark-contracts';
import { createPublicationController, type PublicationNative } from '../../sharing/publicationController.ts';
import { createBenchmarkOutbox, type BenchmarkOutboxStore, type MeasurementActivity, type QueuedBenchmark } from '../../sharing/outbox.ts';
import { createPublicationBody, parseStoredPublicationBody } from './publication.ts';
import { toPublicBenchmark } from './publicBenchmark.ts';
import { servingBenchmark } from '../../../testing/servingBenchmark.ts';

const submissionId = '00000000-0000-4000-8000-000000000001';
const benchmarkFixture = toPublicBenchmark(servingBenchmark(), submissionId);

function requestFixture(rowCount = 1, description_md = ''): BenchmarkPublicationRequest {
  const benchmark = structuredClone(benchmarkFixture);
  const repetitions = Math.min(100, rowCount);
  benchmark.workload.repetitions = repetitions;
  benchmark.workload.inputs = Array.from({ length: Math.min(64, Math.ceil(rowCount / repetitions)) }, (_, index) => ({
    bytes: 4096 + index * 256, sha256: (index * repetitions + 1).toString(16).padStart(64, '0'),
  }));
  const row = benchmarkFixture.measurements.rows[0]!;
  benchmark.measurements.rows = Array.from({ length: rowCount }, (_, index) => ({
    ...row, input_bytes: 4096 + Math.floor(index / repetitions) * 256, repetition: index % repetitions + 1,
    input_sha256_by_request: [(index + 1).toString(16).padStart(64, '0')],
  }));
  return { benchmark, description_md };
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
    const prepared = await controller.prepare(request, { runId: 'synthetic-run' });
    const stored = fixture.rows.get(submissionId);
    const direct = createPublicationBody(request);
    expect(prepared.destination).toBe('https://example.test/v1/benchmark-runs');
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
    ['an unknown wrapper key', { ...requestFixture(), unexpected: true }, 'Invalid publication request.'],
  ])('rejects %s before emitting a body', (_name, value, error) => {
    expect(() => createPublicationBody(value)).toThrow(error);
  });

  it('rejects a bare benchmark both as a publication and as a stored snapshot', () => {
    const benchmark = requestFixture().benchmark;
    expect(() => createPublicationBody(benchmark as unknown as BenchmarkPublicationRequest)).toThrow();
    expect(() => parseStoredPublicationBody(JSON.stringify(benchmark))).toThrow();
  });

  it('ignores a wrapper prototype serializer when freezing user bytes', () => {
    const request = requestFixture();
    Object.setPrototypeOf(request, { toJSON: () => ({ ...request, local_path: 'synthetic-private.gguf' }) });
    const body = createPublicationBody(request).body;
    expect(body).not.toContain('local_path');
  });
});
