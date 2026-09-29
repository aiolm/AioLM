import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { benchmarkCopy } from './benchmarkCopy';
import { dispatchSelectedBenchmark, enqueuePublicationBenchmark, getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox';
import type { PerformanceBenchmarkRecord } from './performanceRecords';
import { toPublicBenchmark } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import { serializePublicationRequest } from '@aiolm/benchmark-contracts';

// Shared feedback banners read the active locale for their dismiss label.
const English = ({ children }: { children: ReactNode }) => <I18nProvider initialLocale="en">{children}</I18nProvider>;
const render = (ui: ReactElement) => renderView(ui, { wrapper: English });

vi.mock('../../shared/sharing/benchmarkOutbox', () => ({ enqueuePublicationBenchmark: vi.fn(), getQueuedBenchmark: vi.fn(async () => undefined), dispatchSelectedBenchmark: vi.fn(async () => 0), retryQueuedBenchmark: vi.fn(async () => undefined) }));
const saved: PerformanceBenchmarkRecord = {
  schemaVersion: 1, id: 'performance-00000000-0000-4000-8000-000000000001', createdAt: 1,
  model: '/private/model.gguf', backend: 'cpu', build: 'b1',
  request: { run_id: 'performance-00000000-0000-4000-8000-000000000001', context_profile: 'novel_en', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
  result: { run_id: 'performance-00000000-0000-4000-8000-000000000001', rows: [{ id: 'sample', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0, ttft_ms: 40, tpot_ms: 10, pp_tps: 100, tg_tps: 100, e2e_ms: 1400, total_tps: 95, peak_memory_bytes: null, timing_source: 'client', error: null }], status: 'complete', args: ['--private-token', 'secret'], message: null, runtime_version: '1', context_size: 4096, parallel: 1 },
};
beforeEach(() => {
  vi.clearAllMocks();
  // Pin the queue lookup default every test: per-test overrides must not leak
  // across cases and gate (or fail) hydration.
  vi.mocked(getQueuedBenchmark).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function waitForShare() {
  await screen.findByLabelText('Shared details');
}

describe('public benchmark review', () => {
  it('opens and prepares the review without publishing automatically', async () => {
    const copy = benchmarkCopy('en');
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    expect(screen.getByText('Share result').closest('details')).toHaveAttribute('open');
    // No separate prepare, export, or queue actions exist.
    expect(screen.queryByText('Review what will be shared')).not.toBeInTheDocument();
    expect(screen.queryByText(/Export public JSON/)).not.toBeInTheDocument();
    expect(screen.queryByText(/sharing queue/i)).not.toBeInTheDocument();
    await waitForShare();
    expect(screen.getByRole('button', { name: copy.publishSelected })).toBeInTheDocument();
    expect(enqueuePublicationBenchmark).not.toHaveBeenCalled();
    expect(dispatchSelectedBenchmark).not.toHaveBeenCalled();
  });

  it('shows a human-readable summary without local paths, raw hashes, IDs or JSON', async () => {
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await waitForShare();
    const summary = screen.getByLabelText('Shared details');
    expect(summary).toHaveTextContent('Model');
    expect(summary).toHaveTextContent('Hardware');
    expect(summary).toHaveTextContent('Runtime');
    expect(summary).toHaveTextContent('Results');
    // Unknown provenance stays unknown; the local filename never leaks.
    expect(summary).toHaveTextContent('Not identified');
    expect(document.body.textContent).not.toMatch(/private|model\.gguf|secret/);
    expect(document.body.textContent).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(screen.queryByText(/submission_id/)).not.toBeInTheDocument();
    expect(document.querySelector('pre.performance-public-json')).not.toBeInTheDocument();
  });

  it('keeps the same snapshot when closed and reopened with a stable submission ID', async () => {
    const { rerender } = render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    await waitForShare();
    expect(vi.mocked(getQueuedBenchmark)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getQueuedBenchmark)).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001');
    fireEvent.click(screen.getByText('Share result'));
    await waitFor(() => expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument());
    rerender(<PublicBenchmarkReview record={saved} busy copy={benchmarkCopy('en')} />);
    expect(screen.getByText('Share result').closest('details')).not.toHaveAttribute('open');
    fireEvent.click(screen.getByText('Share result'));
    await screen.findByLabelText('Shared details');
    // Reopening reuses the frozen snapshot instead of hydrating again.
    expect(vi.mocked(getQueuedBenchmark)).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Shared details')).toHaveTextContent('Not identified');
  });

  it('restores the exact frozen benchmark and description when bound', async () => {
    const frozenBenchmark = toPublicBenchmark(saved, '00000000-0000-4000-8000-000000000001');
    const frozenBody = serializePublicationRequest({ benchmark: frozenBenchmark, description_md: 'saved notes' });
    vi.mocked(getQueuedBenchmark).mockResolvedValue({ requestBody: frozenBody, descriptionMd: 'saved notes' } as Awaited<ReturnType<typeof getQueuedBenchmark>>);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={benchmarkCopy('en')} />);
    const editor = await screen.findByDisplayValue('saved notes');
    expect(editor).toBeDisabled();
    const summary = await screen.findByLabelText('Shared details');
    expect(summary).toHaveTextContent('Not identified');
    expect(document.body.textContent).not.toContain('00000000-0000-4000-8000-000000000001');
  });

  it('blocks publishing when the stored snapshot is corrupt', async () => {
    vi.mocked(getQueuedBenchmark).mockResolvedValue({ requestBody: '{corrupt', descriptionMd: 'old notes' } as Awaited<ReturnType<typeof getQueuedBenchmark>>);
    const copy = benchmarkCopy('en');
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not be read');
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishSelected })).not.toBeInTheDocument();
  });

  it('blocks publishing when the stored snapshot cannot be read', async () => {
    const copy = benchmarkCopy('en');
    vi.mocked(getQueuedBenchmark).mockRejectedValue(new Error('unavailable'));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishSelected })).not.toBeInTheDocument();
  });

  it('rejects records that cannot be converted without offering publication', async () => {
    const copy = benchmarkCopy('en');
    const partial = { ...saved, result: { ...saved.result, status: 'partial' as const } };
    render(<PublicBenchmarkReview record={partial} busy={false} copy={copy} />);
    await screen.findByText(copy.publicInvalid);
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishSelected })).not.toBeInTheDocument();
  });

  it('exposes an optional description alongside the publish panel', async () => {
    const copy = benchmarkCopy('en');
    const onPublished = vi.fn();
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} onPublished={onPublished} />);
    await waitForShare();
    const editor = screen.getByLabelText(copy.descriptionLabel, { exact: false });
    expect(editor).toBeEnabled();
    fireEvent.change(editor, { target: { value: 'review notes' } });
    expect(screen.getByDisplayValue('review notes')).toBeInTheDocument();
    // Publishing stays available with or without a description.
    expect(screen.getByRole('button', { name: copy.publishSelected })).toBeInTheDocument();
    expect(onPublished).not.toHaveBeenCalled();
  });

  it('disables editing while a measurement is active', async () => {
    const copy = benchmarkCopy('en');
    const { rerender } = render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    await waitForShare();
    rerender(<PublicBenchmarkReview record={saved} busy copy={copy} />);
    expect(screen.getByLabelText(copy.descriptionLabel, { exact: false })).toBeDisabled();
  });
});
