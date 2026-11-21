import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render as renderView, screen, waitFor, within } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { benchmarkCopy } from './benchmarkCopy';
import { dispatchSelectedBenchmark, enqueuePublicationBenchmark, getQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox';
import { servingBenchmark } from '../../testing/servingBenchmark';
import { toPublicBenchmark } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import { serializePublicationRequest } from '@aiolm/benchmark-contracts';
import { PublicBenchmarkSummary } from './PublicBenchmarkSummary';
import { defined } from '../../testing/assertDefined';

// Shared feedback banners read the active locale for their dismiss label.
const English = ({ children }: { children: ReactNode }) => <I18nProvider initialLocale="en">{children}</I18nProvider>;
const render = (ui: ReactElement) => renderView(ui, { wrapper: English });

vi.mock('../../shared/sharing/benchmarkOutbox', () => ({ enqueuePublicationBenchmark: vi.fn(), getQueuedBenchmark: vi.fn(async () => undefined), dispatchSelectedBenchmark: vi.fn(async () => 0), retryQueuedBenchmark: vi.fn(async () => undefined) }));
const saved = servingBenchmark();
saved.id = saved.request.run_id = saved.result.run_id = 'performance-00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.clearAllMocks();
  // Pin the queue lookup default every test: per-test overrides must not leak
  // across cases and gate (or fail) hydration.
  vi.mocked(getQueuedBenchmark).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function waitForShare() {
  fireEvent.click(screen.getByText('Share result'));
  await screen.findByLabelText('Shared details');
}

describe('public benchmark review', () => {
  it.each(['en', 'ko', 'ja', 'zh'] as const)('shows isolated Cold Prompt inputs in %s review', locale => {
    const record = servingBenchmark();
    const copy = benchmarkCopy(locale);
    render(<PublicBenchmarkSummary snapshot={toPublicBenchmark(record, '00000000-0000-4000-8000-000000000004')} copy={copy} />);
    expect(screen.getByText(copy.coldPrompt)).toBeVisible();
    expect(screen.queryByText(copy.asConfigured)).not.toBeInTheDocument();
    expect(screen.getByText(record.result.provenance!.workload.prompt_nonce)).toBeVisible();
    const table = screen.getByRole('table', { name: copy.shareResults });
    expect(within(table).getByText('60.0')).toBeVisible();
    expect(within(table).getAllByText(copy.unavailable).length).toBeGreaterThan(0);
  });

  it('reviews completion without publishing or inventing token observations', async () => {
    render(<PublicBenchmarkReview record={servingBenchmark()} busy={false} copy={benchmarkCopy('en')} />);
    await waitForShare();
    const summary = screen.getByLabelText('Shared details');
    expect(summary).toHaveTextContent('openai-chat-serving@5');
    expect(summary).toHaveTextContent('Maximum output token request');
    const table = within(summary).getByRole('table', { name: 'Results' });
    expect(within(table).getByRole('columnheader', { name: /Total token throughput/ })).toBeVisible();
    expect(within(table).getAllByText('N/A').length).toBeGreaterThan(0);
    expect(within(table).getByText('60.0')).toBeVisible();
    expect(summary).not.toHaveTextContent(/PRIVATE|synthetic|private|diagnostic/);
    expect(enqueuePublicationBenchmark).not.toHaveBeenCalled();
    expect(dispatchSelectedBenchmark).not.toHaveBeenCalled();
  });


  it('renders per-metric median samples without inventing token usage', () => {
    const snapshot = toPublicBenchmark(servingBenchmark(), '00000000-0000-4000-8000-000000000001');
    const observed = defined(snapshot.measurements.rows[0]);
    observed.first_output_ms = 50;
    snapshot.runtime.name = 'sglang';
    snapshot.model.source = { kind: 'huggingface', repository: 'example/model', revision: 'a'.repeat(40) };
    snapshot.workload.repetitions = 2;
    snapshot.execution.settings.unshift(
      { target: 'launch', scope: [], name: 'batch', value: 0, unit: 'count', role: null },
      { target: 'launch', scope: ['serve'], name: 'cache', value: false, unit: null, role: null },
    );
    snapshot.measurements.rows.push({ ...observed, repetition: 2, input_sha256_by_request: ['b'.repeat(64)], e2e_ms: 400, first_output_ms: null });
    render(<PublicBenchmarkSummary snapshot={snapshot} copy={benchmarkCopy('en')} />);
    const summary = screen.getByLabelText('Shared details');
    const table = within(summary).getByRole('table', { name: 'Results' });
    const cells = within(defined(within(table).getAllByRole('row')[1])).getAllByRole('cell');
    expect(cells[7]).toHaveTextContent('45.0');
    expect(cells[7]).toHaveTextContent('30.0 – 60.0 · n=2');
    expect(cells[2]).toHaveTextContent('50.0 – 50.0 · n=1');
    expect(cells[6]).toHaveTextContent('N/A');
    expect(summary).toHaveTextContent('sglang');
    expect(summary).toHaveTextContent('example/model');
    expect(summary).toHaveTextContent('a'.repeat(40));
    expect(summary).toHaveTextContent('A source revision is not a weight SHA-256');
    expect(summary).toHaveTextContent('Launch · batch0 count');
    expect(summary).toHaveTextContent('Launch · serve / cachefalse');
  });

  it('keeps zero output throughput distinct from unavailable timing and token observations', () => {
    const snapshot = toPublicBenchmark(servingBenchmark(), '00000000-0000-4000-8000-000000000001');
    Object.assign(defined(snapshot.measurements.rows[0]), { first_output_ms: null, output_bytes: 0 });
    render(<PublicBenchmarkSummary snapshot={snapshot} copy={benchmarkCopy('en')} />);
    const cells = within(defined(within(screen.getByRole('table', { name: 'Results' })).getAllByRole('row')[1])).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('N/A');
    expect(cells[7]).toHaveTextContent('0.0 – 0.0 · n=1');
    expect(cells[6]).toHaveTextContent('N/A');
    expect(screen.getByLabelText('Shared details')).toHaveTextContent('valid zero-byte output');
  });

  it('shows reported token metrics and owned memory', () => {
    const record = servingBenchmark();
    record.request.request_usage = record.result.provenance!.workload.request_usage = true;
    record.result.provenance!.execution = {
      topology: 'owned', memory_scope: 'owned_process_tree',
      settings: [...record.result.provenance!.execution.settings,
        { target: 'request' as const, scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null }]
        .sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    };
    Object.assign(defined(record.result.rows[0]), {
      reported_prompt_tokens: 55, reported_completion_tokens: 24,
      prefill_tokens_per_second: 2750, decode_tokens_per_second: 127.7777777778, tpot_ms: 180 / 23,
      usage_status: 'complete', peak_memory_bytes: 1073741824,
    });
    const snapshot = toPublicBenchmark(record, '00000000-0000-4000-8000-000000000001');
    render(<PublicBenchmarkSummary snapshot={snapshot} copy={benchmarkCopy('ko')} />);
    const cells = within(defined(within(screen.getByRole('table')).getAllByRole('row')[1])).getAllByRole('cell');
    expect(cells[2]).toHaveTextContent('20.0');
    expect(cells[3]).toHaveTextContent('2750.0');
    expect(cells[4]).toHaveTextContent('127.8');
    expect(cells[5]).toHaveTextContent('7.8');
    expect(cells[6]).toHaveTextContent('120.0');
    expect(cells[9]).toHaveTextContent('1.00 GiB');
  });

  it('prepares a review only when opened and never publishes automatically', async () => {
    const copy = benchmarkCopy('en');
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    expect(getQueuedBenchmark).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    await waitForShare();
    expect(screen.getByRole('button', { name: copy.publishSelected })).toBeInTheDocument();
    expect(enqueuePublicationBenchmark).not.toHaveBeenCalled();
    expect(dispatchSelectedBenchmark).not.toHaveBeenCalled();
  });

  it('shows a human-readable summary without local paths, private diagnostics, IDs or JSON', async () => {
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
    fireEvent.click(screen.getByText('Share result'));
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
    fireEvent.click(screen.getByText('Share result'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('could not be read');
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishSelected })).not.toBeInTheDocument();
  });

  it('blocks publishing when the stored snapshot cannot be read', async () => {
    const copy = benchmarkCopy('en');
    vi.mocked(getQueuedBenchmark).mockRejectedValue(new Error('unavailable'));
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    fireEvent.click(screen.getByText('Share result'));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: copy.publishSelected })).not.toBeInTheDocument();
  });

  it('rejects records that cannot be converted without offering publication', async () => {
    const copy = benchmarkCopy('en');
    const partial = { ...saved, result: { ...saved.result, status: 'partial' as const } };
    render(<PublicBenchmarkReview record={partial} busy={false} copy={copy} />);
    fireEvent.click(screen.getByText('Share result'));
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

  it('disables publishing while the description exceeds the length limit', async () => {
    const copy = benchmarkCopy('en');
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    await waitForShare();
    const editor = screen.getByLabelText(copy.descriptionLabel, { exact: false });
    fireEvent.change(editor, { target: { value: 'x'.repeat(4001) } });
    expect(screen.getByRole('button', { name: copy.publishSelected })).toBeDisabled();
  });

  it('retries failed share hydration and restores details once readable', async () => {
    const copy = benchmarkCopy('en');
    vi.mocked(getQueuedBenchmark)
      .mockRejectedValueOnce(new Error('temporary read failure'))
      .mockResolvedValueOnce(undefined);
    render(<PublicBenchmarkReview record={saved} busy={false} copy={copy} />);
    fireEvent.click(screen.getByText('Share result'));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Shared details')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: copy.publishRetry }));
    await screen.findByLabelText('Shared details');
    expect(screen.getByRole('button', { name: copy.publishSelected })).toBeEnabled();
  });
});
