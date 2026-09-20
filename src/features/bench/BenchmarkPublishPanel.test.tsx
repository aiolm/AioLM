import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BenchmarkPublishPanel } from './BenchmarkPublishPanel';
import { benchmarkCopy } from './benchmarkCopy';
import * as sharing from '../../shared/api/benchmarkSharing';
import * as native from '../../shared/api/transport';
import { createBenchmarkOutbox, type BenchmarkOutboxStore, type QueuedBenchmark } from '../../shared/sharing/outbox';
import { HttpError } from '../../shared/api/http';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import type { PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';

vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true }));
vi.mock('../../shared/api/benchmarkSharing', async (importOriginal) => {
  const actual = await importOriginal<typeof sharing>();
  return {
    ...actual,
    benchmarkSharingConfiguration: vi.fn(async () => ({ base_url: 'https://example.test' })),
    benchmarkSharingOpenManagement: vi.fn(async () => undefined),
    benchmarkSharingRecoveryCopy: vi.fn(async () => true),
    benchmarkSharingRecoveryExport: vi.fn(async () => true),
    benchmarkSharingRecoveryImport: vi.fn(async () => null),
    benchmarkSharingPrepare: vi.fn(),
    benchmarkSharingBeginVerification: vi.fn(),
    benchmarkSharingPollVerification: vi.fn(),
    benchmarkSharingSubmit: vi.fn(),
    benchmarkSharingCancel: vi.fn(async () => undefined),
  };
});

const snapshot = (): PublicBenchmarkSubmission => ({
  schema_version: 1, submission_id: '00000000-0000-4000-8000-000000000001', app_version: '0.1.9', method: null,
  workload: { corpus: 'novel_ko', corpus_version: null, corpus_sha256: null, prompt_lengths: [1024], generation_length: 128, batch_sizes: [2], repetitions: 1, warmup: true },
  model: { status: 'unidentified', sha256: null, size_bytes: null },
  runtime: { name: 'llama.cpp', version: '10840', backend: 'cpu', build: 'b10840' },
  environment: null, execution: { context_size: 4096, parallel: 2, settings: null },
  measurements: { status: 'complete', rows: [{ prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10, pp_tps: 100, tg_tps: 100, e2e_ms: 1380, total_tps: 93, peak_memory_bytes: null, timing_source: 'client', failed: false }] },
});

function memoryOutbox() {
  const rows = new Map<string, QueuedBenchmark>();
  const deadlines = new Map<string, number>();
  const store: BenchmarkOutboxStore = {
    get: async (id) => structuredClone(rows.get(id)),
    list: async () => [...rows.values()].map((row) => structuredClone(row)),
    cooldown: async (destination, until) => {
      const deadline = Math.max(deadlines.get(destination) ?? 0, until ?? 0);
      deadlines.set(destination, deadline);
      return deadline;
    },
    mutate: async (id, update) => {
      const row = update(structuredClone(rows.get(id)));
      if (row) rows.set(id, structuredClone(row));
      else rows.delete(id);
      return structuredClone(row);
    },
  };
  const active = false;
  const listeners = new Set<() => void>();
  const engine = createBenchmarkOutbox({
    store,
    measurement: { isActive: () => active, subscribe: (cb) => { listeners.add(cb); return () => { listeners.delete(cb); }; } },
    now: () => Date.now(),
    uuid: (() => { let n = 0; return () => `tok-${++n}`; })(),
    random: () => 0.5,
  });
  return { rows, engine };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(native, 'isNativeRuntimeAvailable').mockReturnValue(true);
  vi.mocked(sharing.benchmarkSharingConfiguration).mockResolvedValue({ base_url: 'https://example.test' });
  for (const task of getTaskSnapshot()) removeTask(task.id);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function clickPublish() {
  const button = await screen.findByRole('button', { name: 'Publish selected result' });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe('publish flow', () => {
  it('prepares the exact reviewed body then verifies and dispatches automatically', async () => {
    const { engine } = memoryOutbox();
    const body = JSON.stringify({ benchmark: snapshot(), description_md: 'hello notes' });
    vi.mocked(sharing.benchmarkSharingPrepare).mockResolvedValue({ credential_ref: 'cred-1', body_sha256: 'h', destination: 'https://example.test/v1/benchmark-runs' });
    vi.mocked(sharing.benchmarkSharingBeginVerification).mockResolvedValue({ session_id: 'sess-1', verification_url: 'https://example.test/verify/sess-1', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingPollVerification).mockResolvedValue({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' });
    // Accepted replay first: the first submit requires verification, the post-verify submit succeeds.
    vi.mocked(sharing.benchmarkSharingSubmit)
      .mockRejectedValueOnce(Object.assign(new HttpError('http', 'Verify first.', true, 401), { serviceCode: 'verification_required' }))
      .mockResolvedValue({ status: 201, body: JSON.stringify({ submission_id: snapshot().submission_id, id: 'public-1' }) });
    const onBound = vi.fn();
    const onQueued = vi.fn();
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="hello notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} onQueued={onQueued} onBound={onBound} outbox={engine} />);
    await clickPublish();
    await waitFor(() => expect(sharing.benchmarkSharingPrepare).toHaveBeenCalledWith(snapshot().submission_id, body));
    expect(sharing.benchmarkSharingBeginVerification).toHaveBeenCalledWith(snapshot().submission_id);
    expect(sharing.benchmarkSharingSubmit).toHaveBeenCalledTimes(2);
    expect(sharing.benchmarkSharingSubmit).toHaveBeenLastCalledWith(snapshot().submission_id, body);
    expect(onBound).toHaveBeenCalledWith('hello notes');
    expect(onQueued).toHaveBeenCalled();
    expect(await engine.get(snapshot().submission_id)).toMatchObject({ state: 'sent', receipt: { id: 'public-1' } });
    await screen.findByText('Upload accepted. Local receipt:');
    expect(screen.getByText('public-1')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('reuses the frozen queued body on retry without preparing again', async () => {
    const { rows, engine } = memoryOutbox();
    const id = snapshot().submission_id;
    const frozen = JSON.stringify({ benchmark: snapshot(), description_md: 'old notes' });
    rows.set(id, {
      id, payload: snapshot(), state: 'pending', createdAt: 0, attempts: 0, nextAttemptAt: 0,
      requestBody: frozen, descriptionMd: 'old notes', credentialRef: 'cred-1', destination: 'https://example.test/v1/benchmark-runs',
    });
    vi.mocked(sharing.benchmarkSharingBeginVerification).mockResolvedValue({ session_id: 'sess-1', verification_url: 'https://example.test/verify/sess-1', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingPollVerification).mockResolvedValue({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingSubmit).mockResolvedValue({ status: 200, body: JSON.stringify({ submission_id: id, id: 'public-1' }) });
    const onBound = vi.fn();
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="changed draft" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} onBound={onBound} outbox={engine} />);
    await waitFor(() => expect(onBound).toHaveBeenCalledWith('old notes'));
    await clickPublish();
    await waitFor(() => expect(sharing.benchmarkSharingSubmit).toHaveBeenCalledWith(id, frozen));
    expect(sharing.benchmarkSharingPrepare).not.toHaveBeenCalled();
    expect(await engine.get(id)).toMatchObject({ state: 'sent' });
  });

  it('binds an offline-queued wrapper to the exact frozen bytes before first send', async () => {
    const { rows, engine } = memoryOutbox();
    const id = snapshot().submission_id;
    const frozen = JSON.stringify({ benchmark: snapshot(), description_md: 'offline notes' });
    rows.set(id, {
      id, payload: snapshot(), state: 'pending', createdAt: 0, attempts: 0, nextAttemptAt: 0,
      requestBody: frozen, descriptionMd: 'offline notes',
    });
    vi.mocked(sharing.benchmarkSharingPrepare).mockResolvedValue({ credential_ref: 'cred-1', body_sha256: 'h', destination: 'https://example.test/v1/benchmark-runs' });
    vi.mocked(sharing.benchmarkSharingBeginVerification).mockResolvedValue({ session_id: 'sess-1', verification_url: 'https://example.test/verify/sess-1', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingPollVerification).mockResolvedValue({ status: 'verified', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingSubmit).mockResolvedValue({ status: 201, body: JSON.stringify({ submission_id: id, id: 'public-1' }) });
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="offline notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} outbox={engine} />);
    await clickPublish();
    await waitFor(() => expect(sharing.benchmarkSharingPrepare).toHaveBeenCalledWith(id, frozen));
    await waitFor(() => expect(sharing.benchmarkSharingSubmit).toHaveBeenCalledWith(id, frozen));
    expect(await engine.get(id)).toMatchObject({ state: 'sent', credentialRef: 'cred-1' });
  });

  it('refuses attempted legacy entries before any native binding', async () => {
    const { rows, engine } = memoryOutbox();
    const id = snapshot().submission_id;
    rows.set(id, { id, payload: snapshot(), state: 'pending', createdAt: 0, attempts: 2, nextAttemptAt: 0 });
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="new notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} outbox={engine} />);
    await clickPublish();
    await screen.findByRole('alert');
    expect(sharing.benchmarkSharingPrepare).not.toHaveBeenCalled();
    const kept = await engine.get(id);
    expect(kept?.requestBody).toBeUndefined();
    expect(kept?.payload).toEqual(snapshot());
  });

  it('cancels a hung verification and cleans up without errors', async () => {
    const { engine } = memoryOutbox();
    vi.mocked(sharing.benchmarkSharingPrepare).mockResolvedValue({ credential_ref: 'cred-1', body_sha256: 'h', destination: 'https://example.test/v1/benchmark-runs' });
    vi.mocked(sharing.benchmarkSharingSubmit)
      .mockRejectedValueOnce(Object.assign(new HttpError('http', 'Verify first.', true, 401), { serviceCode: 'verification_required' }))
      .mockResolvedValue({ status: 201, body: JSON.stringify({ submission_id: snapshot().submission_id, id: 'public-1' }) });
    vi.mocked(sharing.benchmarkSharingBeginVerification).mockResolvedValue({ session_id: 'sess-1', verification_url: 'https://example.test/verify/sess-1', expires_at: '2030-01-01T00:00:00.000Z' });
    vi.mocked(sharing.benchmarkSharingPollVerification).mockImplementation(() => new Promise(() => {}));
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="hello notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} outbox={engine} />);
    await clickPublish();
    await screen.findByRole('button', { name: 'Cancel publish' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel publish' }));
    await waitFor(() => expect(sharing.benchmarkSharingCancel).toHaveBeenCalledWith(snapshot().submission_id));
    expect(screen.getByRole('button', { name: 'Publish selected result' })).toBeEnabled();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('cancels native work on unmount while publishing', async () => {
    const { engine } = memoryOutbox();
    vi.mocked(sharing.benchmarkSharingPrepare).mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<BenchmarkPublishPanel snapshot={snapshot()} description="hello notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} outbox={engine} />);
    await clickPublish();
    await waitFor(() => expect(sharing.benchmarkSharingPrepare).toHaveBeenCalled());
    unmount();
    await waitFor(() => expect(sharing.benchmarkSharingCancel).toHaveBeenCalledWith(snapshot().submission_id));
  });

  it('keeps the unbound wrapper durable when native binding is cancelled before attach', async () => {
    const { engine } = memoryOutbox();
    const id = snapshot().submission_id;
    let resolvePrepare!: (value: { credential_ref: string; body_sha256: string; destination: string }) => void;
    vi.mocked(sharing.benchmarkSharingPrepare).mockImplementation(() => new Promise((resolve) => { resolvePrepare = resolve; }));
    const onBound = vi.fn();
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="durable notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} onBound={onBound} outbox={engine} />);
    await clickPublish();
    await waitFor(() => expect(sharing.benchmarkSharingPrepare).toHaveBeenCalledWith(id, JSON.stringify({ benchmark: snapshot(), description_md: 'durable notes' })));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel publish' }));
    await waitFor(() => expect(sharing.benchmarkSharingCancel).toHaveBeenCalledWith(id));
    // A late native completion must never attach or send.
    resolvePrepare({ credential_ref: 'cred-late', body_sha256: 'h', destination: 'https://example.test/v1/benchmark-runs' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sharing.benchmarkSharingSubmit).not.toHaveBeenCalled();
    const kept = await engine.get(id);
    expect(kept?.requestBody).toBe(JSON.stringify({ benchmark: snapshot(), description_md: 'durable notes' }));
    expect(kept?.credentialRef).toBeUndefined();
    // The review still freezes to the persisted wrapper after cancellation.
    expect(onBound).toHaveBeenCalledWith('durable notes');
  });

  it('disables publishing while no service is configured', async () => {
    const { engine } = memoryOutbox();
    vi.mocked(sharing.benchmarkSharingConfiguration).mockResolvedValue({ base_url: null });
    render(<BenchmarkPublishPanel snapshot={snapshot()} description="hello notes" sourceRunId="performance-1" busy={false} copy={benchmarkCopy('en')} outbox={engine} />);
    await screen.findByText('No sharing service is configured. Review, export, and queue still work offline.');
    expect(screen.getByRole('button', { name: 'Publish selected result' })).toBeDisabled();
    expect(sharing.benchmarkSharingPrepare).not.toHaveBeenCalled();
  });
});
