import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import ProviderEnvironments from './ProviderEnvironments';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api/index';

vi.mock('../../shared/api/index', () => ({
  isNativeRuntimeAvailable: () => false,
  providerCatalog: vi.fn(),
  providerRuntimes: vi.fn(),
  providerInstall: vi.fn(),
  providerRegister: vi.fn(),
  providerRemove: vi.fn(),
  providerPortableExport: vi.fn(),
  providerPortableImport: vi.fn(),
  rtCancel: vi.fn(),
  runtimeLabel: (runtime: { version?: string; id: string }) => runtime.version ?? runtime.id,
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const catalog = (overrides = {}) => ([
  {
    id: 'vllm', engine: 'vllm', server: 'vllm', managed_version: '0.31.0',
    managed_variant: null,
    availability: { supported: true, detail: '' },
    options: [],
    ...overrides,
  },
]);

const runtime = (overrides = {}) => ({
  provider: 'vllm', id: 'portable-0-31-0-synthetic', engine: 'vllm', server: 'vllm',
  version: '0.31.0', accelerator: 'cpu', installation: 'managed',
  location: '/synthetic/runtime', available: true, problems: [],
  ...overrides,
});

function renderPanel() {
  return render(createElement(I18nProvider, {
    initialLocale: 'en',
    children: createElement(ProviderEnvironments, { active: true }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.providerCatalog.mockResolvedValue(catalog());
  mocked.providerRuntimes.mockResolvedValue([runtime()]);
});

afterEach(() => {
  cleanup();
});

const exportButton = () => screen.findByRole('button', { name: 'Export Python runtime bundle' });
// Provider-scoped labels stay distinct from the llama panel's runtime bundle
// buttons, which keep the generic wording.
const importButton = () => screen.findByRole('button', { name: 'Import Python runtime bundle' });
const importButtonNow = () => screen.getByRole('button', { name: 'Import Python runtime bundle' });

describe('provider portable import/export', () => {
  it('exports through IPC and reports the archive path and digest', async () => {
    mocked.providerPortableExport.mockResolvedValue({
      path: '/synthetic/aiolm-vllm-portable.zip', provider: 'vllm',
      runtime_id: 'portable-0-31-0-synthetic', variant: 'standard', version: '0.31.0',
      archive_sha256: 'synthetic-digest', bytes: 128, wheels: 6,
    });
    renderPanel();
    fireEvent.click(await exportButton());
    await waitFor(() => expect(mocked.providerPortableExport).toHaveBeenCalledWith('vllm', 'portable-0-31-0-synthetic'));
    await screen.findByTestId('portable-result');
    expect(screen.getByTestId('portable-result').textContent).toContain('/synthetic/aiolm-vllm-portable.zip');
    expect(screen.getByTestId('portable-result').textContent).toContain('synthetic-digest');
  });

  it('imports through IPC and refreshes the runtime list', async () => {
    mocked.providerPortableImport.mockResolvedValue({ provider: 'vllm', id: 'portable-0-31-0-new', kind: 'managed', python: '/synthetic/new' });
    mocked.providerRuntimes
      .mockResolvedValueOnce([runtime()])
      .mockResolvedValueOnce([runtime(), runtime({ id: 'portable-0-31-0-new', version: '0.31.0-new' })]);
    renderPanel();
    fireEvent.click(await importButton());
    await waitFor(() => expect(mocked.providerPortableImport).toHaveBeenCalled());
    await screen.findByTestId('portable-result');
    expect(screen.getByTestId('portable-result').textContent).toContain('portable-0-31-0-new');
    await waitFor(() => expect(mocked.providerRuntimes.mock.calls.length).toBeGreaterThanOrEqual(2));
    await screen.findByText('0.31.0-new');
  });

  it('mounts export failures as an error banner without a result', async () => {
    mocked.providerPortableExport.mockRejectedValue(new Error('portable bundle was built for linux but this host is windows'));
    renderPanel();
    fireEvent.click(await exportButton());
    await waitFor(() => expect(mocked.providerPortableExport).toHaveBeenCalled());
    await screen.findByText(/was built for linux/);
    expect(screen.queryByTestId('portable-result')).toBeNull();
  });

  it('mounts import failures and keeps the existing list', async () => {
    mocked.providerPortableImport.mockRejectedValue(new Error('wheel synthetic.whl failed its SHA-256 check'));
    renderPanel();
    await screen.findByText('0.31.0');
    fireEvent.click(await importButton());
    await waitFor(() => expect(mocked.providerPortableImport).toHaveBeenCalled());
    await screen.findByText(/SHA-256/);
    expect(screen.queryByTestId('portable-result')).toBeNull();
    expect(screen.getByText('0.31.0')).toBeTruthy();
  });

  it('locks concurrent operations while one is in flight', async () => {
    let release!: (value: unknown) => void;
    mocked.providerPortableImport.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    renderPanel();
    fireEvent.click(await importButton());
    await waitFor(() => expect(mocked.providerPortableImport).toHaveBeenCalledTimes(1));
    // Portable operations register task cancellation like installs do.
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(importButtonNow());
    fireEvent.click(importButtonNow());
    expect(mocked.providerPortableImport).toHaveBeenCalledTimes(1);
    release({ provider: 'vllm', id: 'portable-0-31-0-new', kind: 'managed', python: '/synthetic/new' });
    await screen.findByTestId('portable-result');
  });
});
