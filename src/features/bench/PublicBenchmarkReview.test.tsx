import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { benchmarkCopy } from './benchmarkCopy';
import { enqueuePublicationBenchmark, getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox';
import type { PerformanceBenchmarkRecord } from './performanceRecords';
import * as native from '../../shared/api/transport';
import { toPublicBenchmark } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import { serializePublicationRequest } from '@aiolm/benchmark-contracts';

vi.mock('../../shared/sharing/benchmarkOutbox', () => ({ enqueuePublicationBenchmark: vi.fn(), getQueuedBenchmark: vi.fn(async () => undefined), dispatchSelectedBenchmark: vi.fn(async () => 0) }));
const saved: PerformanceBenchmarkRecord = {
  schemaVersion: 1, id: 'performance-00000000-0000-4000-8000-000000000001', createdAt: 1,
  model: '/private/model.gguf', backend: 'cpu', build: 'b1',
  request: { run_id: 'performance-00000000-0000-4000-8000-000000000001', context_profile: 'novel_en', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
  result: { run_id: 'performance-00000000-0000-4000-8000-000000000001', rows: [], status: 'partial', args: ['--private-token', 'secret'], message: '/private/failed.log', runtime_version: '1', context_size: 4096, parallel: 1 },
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(enqueuePublicationBenchmark).mockResolvedValue({} as Awaited<ReturnType<typeof enqueuePublicationBenchmark>>);
  // Pin the queue lookup default every test: per-test overrides must not leak
  // across cases and gate (or fail) hydration.
  vi.mocked(getQueuedBenchmark).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
  await screen.findByLabelText('Public result preview');
}

describe('public benchmark review', () => {
  it('requires opening the public preview before saving exactly that snapshot to the queue', async () => {
    const onQueued = vi.fn();
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} onQueued={onQueued} />);
    expect(screen.queryByRole('button', { name: 'Save to sharing queue' })).not.toBeInTheDocument();
    await review();
    const preview = JSON.parse(screen.getByLabelText('Public result preview').textContent!);
    expect(JSON.stringify(preview)).not.toMatch(/private|secret|args|message/);
    expect(preview.submission_id).toBe('00000000-0000-4000-8000-000000000001');
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    await waitFor(() => expect(onQueued).toHaveBeenCalledOnce());
    // Offline queueing keeps the description wrapper with the snapshot; no legacy fallback.
    expect(enqueuePublicationBenchmark).toHaveBeenCalledWith({ benchmark: preview, description_md: '' }, undefined);
    expect(screen.getByRole('button', { name: 'Saved to sharing queue' })).toBeDisabled();
    expect(screen.getByText(/Upload will be available/)).toBeInTheDocument();
  });

  it('queues the edited effective description and freezes the review to it', async () => {
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await review();
    fireEvent.change(screen.getByLabelText('Public description (Markdown)', { exact: true }), { target: { value: 'review notes' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    await waitFor(() => expect(enqueuePublicationBenchmark).toHaveBeenCalledOnce());
    const [request] = vi.mocked(enqueuePublicationBenchmark).mock.calls[0];
    // The persisted wrapper carries the edited text, not the stale empty draft.
    expect(request).toHaveProperty('description_md', 'review notes');
    const editor = screen.getByDisplayValue('review notes');
    expect(editor).toBeDisabled();
  });

  it('keeps the reviewed JSON export available after queue storage failure', async () => {
    vi.mocked(enqueuePublicationBenchmark).mockRejectedValue(new Error('quota'));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    await screen.findByRole('alert');
    expect(screen.getByRole('button', { name: 'Export public JSON' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Save to sharing queue' })).toBeEnabled();
  });

  it('surfaces binding conflicts instead of falling back to a bare legacy entry', async () => {
    vi.mocked(enqueuePublicationBenchmark).mockRejectedValue(new Error('This submission is already bound to a different credential.'));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('already bound to a different credential');
    expect(enqueuePublicationBenchmark).toHaveBeenCalledTimes(1);
  });

  it('links a desktop recovery record outside the reviewed public payload', async () => {
    vi.spyOn(native, 'isNativeRuntimeAvailable').mockReturnValue(true);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await review();
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    await waitFor(() => expect(enqueuePublicationBenchmark).toHaveBeenCalledOnce());
    const [request, source] = vi.mocked(enqueuePublicationBenchmark).mock.calls[0];
    expect(source).toEqual({ source: { runId: saved.id } });
    expect(JSON.stringify(request)).not.toContain(saved.id);
    expect(request).not.toHaveProperty('source');
    expect(request).toHaveProperty('description_md', '');
  });

  it('disables hashing-independent publication work while a measurement is active', async () => {
    const { rerender } = render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await review();
    rerender(<PublicBenchmarkReview record={saved} busy copy={benchmarkCopy('en')} />);
    expect(screen.getByRole('button', { name: 'Save to sharing queue' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export public JSON' })).toBeDisabled();
  });

  it('gates actions on hydration and never shows the draft as publishable first', async () => {
    let resolveLookup!: (value: undefined) => void;
    vi.mocked(getQueuedBenchmark).mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
    await screen.findByText('Loading saved snapshot…');
    // While hydration is pending there is no preview, export, queue, or publish UI.
    expect(screen.queryByLabelText('Public result preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to sharing queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export public JSON' })).not.toBeInTheDocument();
    resolveLookup(undefined);
    await screen.findByLabelText('Public result preview');
    expect(screen.getByRole('button', { name: 'Save to sharing queue' })).toBeInTheDocument();
  });

  it('restores the exact frozen benchmark and description when reviewing an offline-queued wrapper', async () => {
    const frozenBenchmark = toPublicBenchmark(saved, '00000000-0000-4000-8000-000000000001');
    const frozenBody = serializePublicationRequest({ benchmark: frozenBenchmark, description_md: 'saved notes' });
    vi.mocked(getQueuedBenchmark).mockResolvedValue({ requestBody: frozenBody, descriptionMd: 'saved notes' } as Awaited<ReturnType<typeof getQueuedBenchmark>>);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
    const editor = await screen.findByDisplayValue('saved notes');
    expect(editor).toBeDisabled();
    // The preview shows the exact frozen benchmark bytes, not a re-derived draft.
    const preview = JSON.parse(screen.getByLabelText('Public result preview').textContent!);
    expect(preview.submission_id).toBe('00000000-0000-4000-8000-000000000001');
    expect(JSON.stringify(preview)).toBe(JSON.stringify(frozenBenchmark));
  });

  it('requeues the restored frozen wrapper instead of a re-derived draft', async () => {
    const frozenBenchmark = toPublicBenchmark(saved, '00000000-0000-4000-8000-000000000001');
    const frozenBody = serializePublicationRequest({ benchmark: frozenBenchmark, description_md: 'saved notes' });
    vi.mocked(getQueuedBenchmark).mockResolvedValue({ requestBody: frozenBody, descriptionMd: 'saved notes' } as Awaited<ReturnType<typeof getQueuedBenchmark>>);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
    await screen.findByDisplayValue('saved notes');
    fireEvent.click(screen.getByRole('button', { name: 'Save to sharing queue' }));
    await waitFor(() => expect(enqueuePublicationBenchmark).toHaveBeenCalledOnce());
    const [request] = vi.mocked(enqueuePublicationBenchmark).mock.calls[0];
    expect(request).toEqual({ benchmark: frozenBenchmark, description_md: 'saved notes' });
  });

  it('blocks export and publishing when the stored snapshot is corrupt', async () => {
    vi.mocked(getQueuedBenchmark).mockResolvedValue({ requestBody: '{corrupt', descriptionMd: 'old notes' } as Awaited<ReturnType<typeof getQueuedBenchmark>>);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not be read');
    // No export, queue, preview, or publish UI for a different body.
    expect(screen.queryByLabelText('Public result preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export public JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save to sharing queue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish selected result' })).not.toBeInTheDocument();
    expect(enqueuePublicationBenchmark).not.toHaveBeenCalled();
  });

  it('blocks export and publishing when the stored snapshot cannot be read', async () => {
    vi.mocked(getQueuedBenchmark).mockRejectedValue(new Error('unavailable'));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Review public result' }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Public result preview')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export public JSON' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publish selected result' })).not.toBeInTheDocument();
  });

  it('exports the publication wrapper with the effective description', async () => {
    const createUrl = vi.fn((_blob: Blob) => 'blob:wrapper');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    try {
      render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
      await review();
      fireEvent.click(screen.getByRole('button', { name: 'Export public JSON' }));
      expect(createUrl).toHaveBeenCalledOnce();
      const blob = createUrl.mock.calls[0]?.[0] as unknown as Blob;
      const text = await blob.text();
      const wrapper = JSON.parse(text);
      expect(wrapper.benchmark.submission_id).toBe('00000000-0000-4000-8000-000000000001');
      expect(wrapper).toHaveProperty('description_md', '');
    } finally {
      clickSpy.mockRestore();
    }
  });
});
