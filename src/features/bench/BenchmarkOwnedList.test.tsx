import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BenchmarkOwnedList } from './BenchmarkOwnedList';
import { benchmarkCopy } from './benchmarkCopy';
import * as sharing from '../../shared/api/benchmarkSharing';
import * as native from '../../shared/api/transport';

vi.mock('../../shared/api/benchmarkSharing', async (importOriginal) => {
  const actual = await importOriginal<typeof sharing>();
  return { ...actual, benchmarkSharingOwnedList: vi.fn(), benchmarkSharingRecoveryCopy: vi.fn(), benchmarkSharingRecoveryExport: vi.fn(), benchmarkSharingOpenManagement: vi.fn() };
});

const page = (id: string, cursor: string | null) => ({
  items: [{ submission_id: id, credential_ref: `cred-${id.slice(0, 4)}`, destination: 'https://example.test/v1/benchmark-runs', created_at_ms: 1700000000000 }],
  next_cursor: cursor,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(native, 'isNativeRuntimeAvailable').mockReturnValue(true);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('owned recovery list', () => {
  it('pages with the opaque cursor independent of queue history', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList)
      .mockResolvedValueOnce(page('00000000-0000-4000-8000-000000000001', 'cursor-1'))
      .mockResolvedValueOnce(page('00000000-0000-4000-8000-000000000002', null));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/00000000/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledWith(undefined, 25);
    fireEvent.click(screen.getByRole('button', { name: 'Load more ownership' }));
    await waitFor(() => expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledWith('cursor-1', 25));
    await screen.findByText(/Saved ownership/);
  });

  it('runs copy, export, and management controls per entry', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingRecoveryCopy).mockResolvedValue(true);
    vi.mocked(sharing.benchmarkSharingRecoveryExport).mockResolvedValue(true);
    vi.mocked(sharing.benchmarkSharingOpenManagement).mockResolvedValue(undefined);
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/00000000/);
    fireEvent.click(screen.getByRole('button', { name: 'Copy recovery code' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryCopy).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
    fireEvent.click(screen.getByRole('button', { name: 'Save recovery file' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryExport).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
    fireEvent.click(screen.getByRole('button', { name: 'Open management page' }));
    await waitFor(() => expect(sharing.benchmarkSharingOpenManagement).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
  });

  it('shows an empty state instead of queue contents', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue({ items: [], next_cursor: null });
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText('No saved ownership yet.');
  });

  it('retries failures once per explicit retry instead of looping', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockRejectedValue(new Error('offline'));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1);
    fireEvent.click(retry);
    await waitFor(() => expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
  });

  it('refreshes bindings when the revision changes', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue({ items: [], next_cursor: null });
    const { rerender } = render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={0} />);
    await screen.findByText('No saved ownership yet.');
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1);
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000003', null));
    rerender(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={1} />);
    await screen.findByText(/00000000/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
  });

  it('loads under StrictMode without sticking after setup cleanup', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    render(<StrictMode><BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} /></StrictMode>);
    await screen.findByText(/00000000/);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('queues a revision refresh arriving mid-load instead of dropping it', async () => {
    let resolveFirst!: (value: { items: { submission_id: string; credential_ref: string; destination: string; created_at_ms: number }[]; next_cursor: string | null }) => void;
    vi.mocked(sharing.benchmarkSharingOwnedList).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000003', null));
    const { rerender } = render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={0} />);
    // Wait until the first load is in flight.
    await waitFor(() => expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1));
    rerender(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={1} />);
    // The revision refresh is queued because a load is in flight.
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1);
    resolveFirst({ items: [], next_cursor: null });
    // The stale first page is discarded and the queued refresh reloads.
    await screen.findByText(/00000000/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
  });
});
