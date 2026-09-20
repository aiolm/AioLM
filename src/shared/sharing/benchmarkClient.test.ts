// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { PublicBenchmarkSubmission } from '../contracts/benchmark/publicBenchmark';
import { createBenchmarkClient } from './benchmarkClient';

function payload(): PublicBenchmarkSubmission {
  return {
    schema_version: 1, submission_id: '00000000-0000-4000-8000-000000000001', app_version: '0.1.9', method: null,
    workload: { corpus: 'novel_ko', corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [1], repetitions: 1, warmup: true },
    model: { status: 'unidentified', sha256: null, size_bytes: null },
    runtime: { name: 'llama.cpp', version: null, backend: 'cpu', build: null },
    environment: null, execution: { context_size: 4096, parallel: 1, settings: null },
    measurements: { status: 'complete', rows: [{ prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10, pp_tps: 100, tg_tps: 100, e2e_ms: 1380, total_tps: 93, peak_memory_bytes: null, timing_source: 'client', failed: false }] },
  };
}

it('keeps the reviewed request and receipt identity stable while credentials resolve', async () => {
  const input = payload();
  const reviewed = structuredClone(input);
  let resolveToken!: (token: string) => void;
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ id: 'public-1', submission_id: reviewed.submission_id })));
  const client = createBenchmarkClient({
    baseUrl: 'https://example.test', fetcher,
    accessToken: () => new Promise(resolve => { resolveToken = resolve; }),
  });
  const result = client.submit(input);
  input.submission_id = '00000000-0000-4000-8000-000000000002';
  input.workload.prompt_lengths.push(2048);
  Object.assign(input, { local_path: 'private/model.gguf' });
  expect(fetcher).not.toHaveBeenCalled();
  resolveToken('synthetic-token');
  await expect(result).resolves.toMatchObject({ submission_id: reviewed.submission_id });
  const request = fetcher.mock.calls[0][1]!;
  expect(JSON.parse(request.body as string)).toEqual(reviewed);
  expect(new Headers(request.headers).get('Idempotency-Key')).toBe(reviewed.submission_id);
});

it('validates the serialized body before requesting credentials or sending it', async () => {
  const input = payload();
  Object.setPrototypeOf(input, { toJSON() { return { ...input, local_path: 'private/model.gguf' }; } });
  const accessToken = vi.fn(); const fetcher = vi.fn<typeof fetch>();
  const client = createBenchmarkClient({ baseUrl: 'https://example.test', accessToken, fetcher });
  await expect(client.submit(input)).rejects.toThrow('Invalid public benchmark');
  expect(accessToken).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
