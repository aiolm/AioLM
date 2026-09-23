import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import BenchPanel from './Bench';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as repository from './benchmarkRepository';
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
vi.mock('../../shared/api/index', () => ({ deviceProfile: vi.fn(async () => null) }));
vi.mock('./benchmarkRepository', () => ({ initializeBenchmarkHistory: vi.fn(), loadBenchmarkHistoryPage: vi.fn(), rememberBenchmarkResult: vi.fn(), identifyBenchmarkModel: vi.fn(), loadAllBenchmarkHistory: vi.fn() }));

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
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('native benchmark history UI', () => {
  it('loads recovered partial results asynchronously and surfaces unreadable-file warnings', async () => {
    vi.mocked(repository.initializeBenchmarkHistory).mockResolvedValue({ records: [recovered], total: 2, next_offset: null, warnings: ['Stored file could not be read'] });
    renderPanel();
    const history = await screen.findByRole('combobox', { name: 'Result history' });
    fireEvent.click(history);
    fireEvent.click(screen.getByRole('option', { name: /recovered.gguf/ }));
    expect(screen.getByText('Recovered interrupted run')).toBeInTheDocument();
    expect(screen.getByText(/Some records could not be read/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review public result' })).toBeEnabled();
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
});
