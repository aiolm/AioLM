import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { cleanup, fireEvent, render as renderView, screen, waitFor } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { BenchmarkOwnedList } from './BenchmarkOwnedList';
import { benchmarkCopy } from './benchmarkCopy';
import * as sharing from '../../shared/api/benchmarkSharing';
import * as native from '../../shared/api/transport';

// Shared feedback banners read the active locale for their dismiss label.
const English = ({ children }: { children: ReactNode }) => <I18nProvider initialLocale="en">{children}</I18nProvider>;
const render = (ui: ReactElement) => renderView(ui, { wrapper: English });

vi.mock('../../shared/api/benchmarkSharing', async (importOriginal) => {
  const actual = await importOriginal<typeof sharing>();
  return { ...actual, benchmarkSharingOwnedList: vi.fn(), benchmarkSharingRecoveryCopy: vi.fn(), benchmarkSharingRecoveryExport: vi.fn(), benchmarkSharingRecoveryImport: vi.fn(), benchmarkSharingOpenManagement: vi.fn() };
});

const page = (id: string, cursor: string | null) => ({
  items: [{ submission_id: id, credential_ref: `cred-${id.slice(0, 4)}`, destination: 'https://example.test/v1/benchmark-runs', created_at_ms: 1700000000000 }],
  next_cursor: cursor,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(native, 'isNativeRuntimeAvailable').mockReturnValue(true);
  vi.mocked(sharing.benchmarkSharingRecoveryImport).mockResolvedValue(null);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('owned recovery list', () => {
  it('pages with the opaque cursor independent of queue history', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList)
      .mockResolvedValueOnce(page('00000000-0000-4000-8000-000000000001', 'cursor-1'))
      .mockResolvedValueOnce(page('00000000-0000-4000-8000-000000000002', null));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledWith(undefined, 25);
    fireEvent.click(screen.getByRole('button', { name: 'Show more' }));
    await waitFor(() => expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledWith('cursor-1', 25));
    await screen.findByText(/^Shared results/);
  });

  it('shows dated rows with the service host and a manage action, never raw ownership', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingOpenManagement).mockResolvedValue(undefined);
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    expect(screen.getByRole('button', { name: 'Manage on website' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Manage on website' }));
    await waitFor(() => expect(sharing.benchmarkSharingOpenManagement).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
    // Raw identifiers and key material stay out of the visible management list.
    expect(document.body.textContent).not.toContain('00000000-0000-4000-8000-000000000001');
    expect(document.body.textContent).not.toMatch(/cred-/);
  });

  it('keeps actions disabled while connecting the selected result without requesting a backup code', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    let finish!: () => void;
    vi.mocked(sharing.benchmarkSharingOpenManagement).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage on website' }));
    expect(screen.getByRole('button', { name: 'Connecting to management…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save backup file' })).toBeDisabled();
    expect(sharing.benchmarkSharingRecoveryCopy).not.toHaveBeenCalled();
    expect(sharing.benchmarkSharingRecoveryExport).not.toHaveBeenCalled();
    finish();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Manage on website' })).toBeEnabled());
    expect(sharing.benchmarkSharingOpenManagement).toHaveBeenCalledExactlyOnceWith('00000000-0000-4000-8000-000000000001');
  });

  it.each([
    ['not_found', 'This website does not support direct management from the app yet. Try again after the website is updated.'],
    ['submission_deleted', 'This result has already been deleted from the website.'],
    ['ownership_missing', 'This device no longer has edit and delete access for this result.'],
  ])('explains a %s connection failure without displaying native details', async (serviceCode, message) => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingOpenManagement).mockRejectedValueOnce(new sharing.BenchmarkSharingError('transport', 'synthetic-secret-must-not-appear', true, { serviceCode }));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Manage on website' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expect(document.body.textContent).not.toContain('synthetic-secret-must-not-appear');
    expect(screen.getByRole('button', { name: 'Manage on website' })).toBeEnabled();
  });

  it('shows backup actions immediately without creating a backup automatically', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingRecoveryCopy).mockResolvedValue(true);
    vi.mocked(sharing.benchmarkSharingRecoveryExport).mockResolvedValue(true);
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    const backup = screen.getByText('Backup and restore').closest('details')!;
    expect(backup).toHaveAttribute('open');
    expect(screen.getByRole('button', { name: 'Save backup file' })).toBeVisible();
    expect(sharing.benchmarkSharingRecoveryCopy).not.toHaveBeenCalled();
    expect(sharing.benchmarkSharingRecoveryExport).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: 'Copy backup code' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryCopy).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
    await screen.findByText(/Backup code copied/);
    fireEvent.click(screen.getByRole('button', { name: 'Save backup file' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryExport).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001'));
    await screen.findByText('Backup file saved.');
  });

  it('lets an empty list restore from a backup file', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue({ items: [], next_cursor: null });
    vi.mocked(sharing.benchmarkSharingRecoveryImport).mockResolvedValue({ restored: 1 } as never);
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText('No results shared from this device yet.');
    fireEvent.click(screen.getByRole('button', { name: 'Restore from backup file' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryImport).toHaveBeenCalledOnce());
    await screen.findByText('Backup restored.');
  });

  it('does not report a saved backup when the file dialog is cancelled', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingRecoveryExport).mockResolvedValue(false);
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    fireEvent.click(screen.getByRole('button', { name: 'Save backup file' }));
    await waitFor(() => expect(sharing.benchmarkSharingRecoveryExport).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save backup file' })).toBeEnabled());
    expect(screen.queryByText('Backup file saved.')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens both empty and populated management lists', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValueOnce({ items: [], next_cursor: null });
    const { unmount } = render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText('No results shared from this device yet.');
    expect(screen.getByText(/^Shared results/).closest('details')).toHaveAttribute('open');
    unmount();
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValueOnce(page('00000000-0000-4000-8000-000000000001', null));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    await waitFor(() => expect(screen.getByText(/^Shared results/).closest('details')).toHaveAttribute('open'));
  });

  it('retries failures once per explicit retry instead of looping', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockRejectedValue(new Error('offline'));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('Shared results could not be loaded.')).toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
  });

  it('reports management and backup failures without raw values', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    vi.mocked(sharing.benchmarkSharingOpenManagement).mockRejectedValue(new Error('offline'));
    render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} />);
    await screen.findByText(/example\.test/);
    fireEvent.click(screen.getByRole('button', { name: 'Manage on website' }));
    await screen.findByText('Could not open result management. Try again.');
    vi.mocked(sharing.benchmarkSharingRecoveryCopy).mockRejectedValue(new Error('locked'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy backup code' }));
    await screen.findByText('The action could not be completed. Check the file or connection and try again.');
  });

  it('refreshes bindings when the revision changes', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue({ items: [], next_cursor: null });
    const { rerender } = render(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={0} />);
    await screen.findByText('No results shared from this device yet.');
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Backup and restore'));
    fireEvent.click(screen.getByText(/^Shared results/));
    await waitFor(() => expect(screen.getByText(/^Shared results/).closest('details')).not.toHaveAttribute('open'));
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000003', null));
    rerender(<BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} revision={1} />);
    await screen.findByText(/example\.test/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/^Shared results/).closest('details')).not.toHaveAttribute('open');
    expect(screen.getByText('Backup and restore').closest('details')).not.toHaveAttribute('open');
  });

  it('loads under StrictMode without sticking after setup cleanup', async () => {
    vi.mocked(sharing.benchmarkSharingOwnedList).mockResolvedValue(page('00000000-0000-4000-8000-000000000001', null));
    render(<StrictMode><BenchmarkOwnedList busy={false} copy={benchmarkCopy('en')} /></StrictMode>);
    await screen.findByText(/example\.test/);
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
    await screen.findByText(/example\.test/);
    expect(sharing.benchmarkSharingOwnedList).toHaveBeenCalledTimes(2);
  });
});
