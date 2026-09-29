import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import BenchPanel from './Bench';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as repository from './benchmarkRepository';
import { exportBenchmarkResults } from './benchmarkExport';
import { testConfig } from '../../testing/appStore';
import type { AppStore } from '../../shared/state/store';
import type { PerformanceBenchmarkRecord } from './performanceRecords';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true }));
vi.mock('../../shared/api/benchmarkSharing', () => ({
  benchmarkSharingOwnedList: vi.fn(async () => ({ items: [], next_cursor: null })),
  benchmarkSharingRecoveryCopy: vi.fn(async () => true),
  benchmarkSharingRecoveryExport: vi.fn(async () => true),
  benchmarkSharingRecoveryImport: vi.fn(async () => null),
  benchmarkSharingOpenManagement: vi.fn(async () => undefined),
  benchmarkSharingPrepare: vi.fn(),
  benchmarkSharingBeginVerification: vi.fn(),
  benchmarkSharingPollVerification: vi.fn(),
  benchmarkSharingSubmit: vi.fn(),
  benchmarkSharingCancel: vi.fn(async () => undefined),
}));
vi.mock('../../shared/sharing/benchmarkOutbox', () => ({ listQueuedBenchmarks: vi.fn(async () => []), enqueuePublicBenchmark: vi.fn(), enqueuePublicationBenchmark: vi.fn(), getQueuedBenchmark: vi.fn(async () => undefined), dispatchSelectedBenchmark: vi.fn(async () => 0), removeQueuedBenchmark: vi.fn(), retryQueuedBenchmark: vi.fn() }));
vi.mock('../../shared/api/index', () => ({
  deviceProfile: vi.fn(async () => null),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', devices: [], diagnostics: [], server_help: '' })),
}));
vi.mock('./benchmarkRepository', () => ({ deleteBenchmarkHistoryRecord: vi.fn(), initializeBenchmarkHistory: vi.fn(), loadBenchmarkHistoryPage: vi.fn(), rememberBenchmarkResult: vi.fn(), loadAllBenchmarkHistory: vi.fn() }));
vi.mock('./benchmarkExport', () => ({ exportBenchmarkResults: vi.fn() }));

const recovered: PerformanceBenchmarkRecord = {
  schemaVersion: 1, id: 'recovered', createdAt: 1, model: 'models/recovered.gguf', backend: 'cpu', build: 'b1',
  request: { run_id: 'recovered', context_profile: 'novel_en', prompt_lengths: [1024], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true },
  result: { run_id: 'recovered', rows: [], status: 'partial', message: 'Recovered interrupted run', args: [], runtime_version: '1', context_size: 4096, parallel: 1 },
};
const store = { cfg: testConfig, status: { state: 'stopped' }, busy: false, refreshStatus: vi.fn(), stop: vi.fn() } as unknown as AppStore;
const renderPanel = () => render(<I18nProvider initialLocale="en"><BenchPanel store={store} /></I18nProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  for (const task of getTaskSnapshot()) removeTask(task.id);
  vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 1, next_offset: null });
  vi.mocked(exportBenchmarkResults).mockResolvedValue('saved');
  vi.mocked(repository.deleteBenchmarkHistoryRecord).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('native benchmark history UI', () => {
  it('waits for confirmed native deletion and refreshes the history cursor without losing older results', async () => {
    const older = { ...recovered, id: 'older', model: 'models/older.gguf' };
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: 1 });
    vi.mocked(repository.loadBenchmarkHistoryPage).mockResolvedValue({ records: [older], total: 1, next_offset: null });
    let finish!: () => void;
    vi.mocked(repository.deleteBenchmarkHistoryRecord).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete result' }));
    expect(repository.deleteBenchmarkHistoryRecord).not.toHaveBeenCalled();
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete result' }));
    expect(repository.deleteBenchmarkHistoryRecord).toHaveBeenCalledExactlyOnceWith('recovered');
    expect(within(dialog).getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true);
    expect(screen.getByRole('combobox', { name: 'Result history' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Export result' })).toBeDisabled();
    finish();
    await screen.findByText('Result deleted.');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Result history' })).toHaveTextContent('older.gguf'));
    expect(repository.loadBenchmarkHistoryPage).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole('button', { name: 'Load older results' })).not.toBeInTheDocument();
    expect(screen.queryByText('Recovered interrupted run')).toBeInTheDocument();
  });

  it('keeps the selected record and offers retry when native deletion fails', async () => {
    vi.mocked(repository.deleteBenchmarkHistoryRecord).mockRejectedValueOnce(new Error('history locked'));
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete result' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete result' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('Could not delete the result. Try again.');
    expect(within(dialog).getByRole('button', { name: 'Delete result' })).toBeEnabled();
    expect(screen.queryByText('Result deleted.')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('combobox', { name: 'Result history' })).toHaveTextContent('recovered.gguf');
  });

  it('keeps successful deletion applied when the subsequent history refresh fails', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: 1 });
    vi.mocked(repository.loadBenchmarkHistoryPage).mockRejectedValueOnce(new Error('read failed'));
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete result' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete result' }));
    await screen.findByText('Result deleted.');
    await screen.findByText(/History could not be loaded or migrated/);
    expect(screen.queryByText('Recovered interrupted run')).not.toBeInTheDocument();
    vi.mocked(repository.loadBenchmarkHistoryPage).mockResolvedValueOnce({ records: [{ ...recovered, id: 'older', model: 'models/older.gguf' }], total: 1, next_offset: null });
    fireEvent.click(screen.getByRole('button', { name: 'Load older results' }));
    await waitFor(() => expect(repository.loadBenchmarkHistoryPage).toHaveBeenLastCalledWith(0));
    expect(await screen.findByRole('combobox', { name: 'Result history' })).toBeEnabled();
  });

  it('loads recovered partial results asynchronously and surfaces unreadable-file warnings', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: null, warnings: ['Stored file could not be read'] });
    renderPanel();
    const history = await screen.findByRole('combobox', { name: 'Result history' });
    fireEvent.click(history);
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    expect(screen.getByText('Recovered interrupted run')).toBeInTheDocument();
    expect(screen.getByText(/Some records could not be read/)).toBeInTheDocument();
    expect(screen.getByText('Share result')).toBeInTheDocument();
  });

  it('loads older pages using the native cursor and keeps recovered records selectable', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: 1 });
    const older = { ...recovered, id: 'older', model: 'models/older.gguf' };
    vi.mocked(repository.loadBenchmarkHistoryPage).mockResolvedValue({ records: [older], total: 2, next_offset: null });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Load older results' }));
    await waitFor(() => expect(repository.loadBenchmarkHistoryPage).toHaveBeenCalledWith(1));
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    expect(await screen.findByRole('option', { name: /older.gguf/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load older results' })).not.toBeInTheDocument();
  });

  it('distinguishes a website-owned result from an unacknowledged local copy', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [{ ...recovered, localState: 'cached' }], total: 1, next_offset: null });
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    expect(screen.getByText('Saved on the website · local copy')).toBeInTheDocument();
    expect(screen.getByText(/Existing and unuploaded records are retained/)).toBeInTheDocument();
    expect(screen.queryByText('Stored on this device')).not.toBeInTheDocument();
  });

  it('offers retry after native migration failure without replacing history with browser defaults', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockRejectedValueOnce(new Error('disk unavailable'));
    renderPanel();
    expect(await screen.findByRole('alert')).toHaveTextContent('History could not be loaded or migrated');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('combobox', { name: 'Result history' })).toBeInTheDocument();
    expect(repository.initializeBenchmarkHistory).toHaveBeenCalledTimes(2);
  });

  it('exports the selected record and all saved records through the save dialog', async () => {
    const older = { ...recovered, id: 'older', model: 'models/older.gguf' };
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: 1 });
    vi.mocked(repository.loadAllBenchmarkHistory).mockResolvedValue([recovered, older]);
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export result' }));
    expect(await screen.findByText('File saved.')).toBeVisible();
    expect(exportBenchmarkResults).toHaveBeenNthCalledWith(1, [recovered], 'selected', 'xlsx', 'en');
    expect(repository.loadAllBenchmarkHistory).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export all history' }));
    await waitFor(() => expect(exportBenchmarkResults).toHaveBeenNthCalledWith(2, [recovered, older], 'all', 'xlsx', 'en'));
    expect(repository.loadAllBenchmarkHistory).toHaveBeenCalledOnce();
  });

  it('disables export while a save dialog is open and treats cancellation quietly', async () => {
    let finish!: (outcome: Awaited<ReturnType<typeof exportBenchmarkResults>>) => void;
    vi.mocked(exportBenchmarkResults).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    const button = screen.getByRole('button', { name: 'Export result' });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(exportBenchmarkResults).toHaveBeenCalledOnce();
    finish('cancelled');
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('File saved.')).not.toBeInTheDocument();
    expect(screen.queryByText(/Could not export the file/)).not.toBeInTheDocument();
  });

  it('reports a write error without claiming the history could not be loaded', async () => {
    vi.mocked(exportBenchmarkResults).mockRejectedValueOnce('Permission denied');
    renderPanel();
    fireEvent.click(await screen.findByRole('combobox', { name: 'Result history' }));
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export result' }));
    expect((await screen.findByText('Could not export the file. Permission denied')).closest('[role="alert"]')).toBeVisible();
    expect(screen.queryByText(/History could not be loaded or migrated/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export result' })).toBeEnabled();
  });
});
