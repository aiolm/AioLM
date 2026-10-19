import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor, cleanup, within } from '@testing-library/react';
import { createElement } from 'react';
import ProviderEnvironments from './ProviderEnvironments';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as api from '../../shared/api/index';
import { notifyCompletion } from '../../shared/lib/notifications';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import TaskStrip from '../../shared/ui/TaskStrip';

vi.mock('../../shared/lib/notifications', () => ({ notifyCompletion: vi.fn(async () => undefined) }));

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

function renderPanel(resourcesInUse = false, onBusyChange?: (busy: boolean) => void, backgroundTasks = false) {
  const panel = createElement(ProviderEnvironments, { active: true, resourcesInUse, onBusyChange });
  return render(createElement(I18nProvider, {
    initialLocale: 'en',
    children: backgroundTasks ? createElement('div', null, createElement(TaskStrip), panel) : panel,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.providerCatalog.mockResolvedValue(catalog());
  mocked.providerRuntimes.mockResolvedValue([runtime()]);
  mocked.rtCancel.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

const exportButton = () => screen.findByRole('button', { name: 'Export Python runtime bundle' });
// Provider-scoped labels stay distinct from the llama panel's runtime bundle
// buttons, which keep the generic wording.
const importButton = () => screen.findByRole('button', { name: 'Import Python runtime bundle' });
const importButtonNow = () => screen.getByRole('button', { name: 'Import Python runtime bundle' });
const environmentTask = () => getTaskSnapshot().find(task => task.id === 'provider-environment-operation');

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

describe('provider portable import/export', () => {
  it('explains the model-session lock before submitting runtime changes or transfers', async () => {
    renderPanel(true);
    await screen.findByText('0.31.0 (portable-0-31-0-synthetic) · cpu · Installed by AioLM');
    fireEvent.change(screen.getByRole('textbox', { name: 'Python executable path' }), { target: { value: '/synthetic/python' } });
    const actions = ['Install isolated environment 0.31.0', 'Register existing Python environment', 'Remove', 'Export Python runtime bundle', 'Import Python runtime bundle'];
    for (const name of actions) {
      const button = screen.getByRole('button', { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(screen.getByText('Unload all model sessions before changing or transferring runtimes.')).toBeVisible();
    for (const command of ['providerInstall', 'providerRegister', 'providerRemove', 'providerPortableExport', 'providerPortableImport']) {
      expect(mocked[command]).not.toHaveBeenCalled();
    }
  });

  it('exports through IPC and reports the archive path and digest', async () => {
    mocked.providerPortableExport.mockResolvedValue({
      path: '/synthetic/aiolm-vllm-portable.zip', provider: 'vllm',
      runtime_id: 'portable-0-31-0-synthetic', variant: 'standard', version: '0.31.0',
      archive_sha256: 'synthetic-digest', bytes: 128, wheels: 6,
    });
    renderPanel();
    const providerRuntimes = await screen.findByRole('group', { name: 'vLLM · Runtime' });
    expect(within(providerRuntimes).getByText('0.31.0 (portable-0-31-0-synthetic) · cpu · Installed by AioLM')).toBeVisible();
    fireEvent.click(within(providerRuntimes).getByRole('button', { name: 'Export Python runtime bundle' }));
    await waitFor(() => expect(mocked.providerPortableExport).toHaveBeenCalledWith('vllm', 'portable-0-31-0-synthetic'));
    await screen.findByTestId('portable-result');
    expect(screen.getByTestId('portable-result').textContent).toContain('/synthetic/aiolm-vllm-portable.zip');
    expect(screen.getByTestId('portable-result').textContent).toContain('synthetic-digest');
    expect(notifyCompletion).not.toHaveBeenCalled();
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
    await screen.findByText('0.31.0-new (portable-0-31-0-new) · cpu · Installed by AioLM');
    expect(notifyCompletion).not.toHaveBeenCalled();
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
    await screen.findByText('0.31.0 (portable-0-31-0-synthetic) · cpu · Installed by AioLM');
    fireEvent.click(await importButton());
    await waitFor(() => expect(mocked.providerPortableImport).toHaveBeenCalled());
    await screen.findByText(/SHA-256/);
    expect(screen.queryByTestId('portable-result')).toBeNull();
    expect(screen.getByText('0.31.0 (portable-0-31-0-synthetic) · cpu · Installed by AioLM')).toBeTruthy();
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

  it('disables repeated cancellation while the backend finishes cleanup and keeps runtime actions locked', async () => {
    const operation = deferred<unknown>();
    const cancellation = deferred<void>();
    const onBusyChange = vi.fn();
    mocked.providerPortableImport.mockReturnValue(operation.promise);
    mocked.rtCancel.mockReturnValue(cancellation.promise);
    renderPanel(false, onBusyChange);
    fireEvent.click(await importButton());
    const cancelButton = await screen.findByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButton);
    expect(environmentTask()?.state).toBe('cancelling');
    expect(screen.getByRole('button', { name: 'Cancelling' })).toBeDisabled();
    fireEvent.click(cancelButton);
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
    await act(async () => cancellation.resolve());
    expect(screen.getByRole('button', { name: 'Cancelling' })).toBeDisabled();
    expect(importButtonNow()).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    await act(async () => operation.reject('portable runtime operation cancelled'));
    expect(environmentTask()?.state).toBe('cancelled');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButtonNow()).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(notifyCompletion).not.toHaveBeenCalled();
  });

  it.each([
    ['export', 'portable runtime export cancelled'],
    ['import', 'portable runtime import cancelled'],
  ])('leaves a dismissed %s picker cancelled without an error banner', async (operation, message) => {
    mocked[operation === 'export' ? 'providerPortableExport' : 'providerPortableImport'].mockRejectedValue(new Error(message));
    renderPanel();
    fireEvent.click(await (operation === 'export' ? exportButton() : importButton()));
    await waitFor(() => expect(environmentTask()?.state).toBe('cancelled'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByTestId('portable-result')).toBeNull();
    expect(notifyCompletion).not.toHaveBeenCalled();
  });

  it('keeps a real bundle failure visible even when the diagnostic mentions cancellation', async () => {
    mocked.providerPortableImport.mockRejectedValue('wheel installation failed: dependency resolution cancelled by an upstream error');
    renderPanel();
    fireEvent.click(await importButton());
    expect(await screen.findByRole('alert')).toHaveTextContent('dependency resolution cancelled by an upstream error');
    expect(environmentTask()?.state).toBe('failed');
    expect(notifyCompletion).not.toHaveBeenCalled();
  });

  it('reports a cancellation request failure while keeping the active operation locked', async () => {
    const operation = deferred<unknown>();
    mocked.providerPortableImport.mockReturnValue(operation.promise);
    mocked.rtCancel.mockRejectedValueOnce('synthetic cancellation IPC unavailable');
    renderPanel();
    fireEvent.click(await importButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('synthetic cancellation IPC unavailable');
    expect(importButtonNow()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(mocked.rtCancel).toHaveBeenCalledTimes(2);
    await act(async () => operation.reject('portable runtime operation cancelled'));
    expect(environmentTask()?.state).toBe('cancelled');
    expect(importButtonNow()).toBeEnabled();
  });

  it('does not apply a late cancellation request error to a later runtime operation', async () => {
    const firstOperation = deferred<unknown>();
    const nextOperation = deferred<unknown>();
    const cancellation = deferred<void>();
    mocked.providerPortableImport.mockReturnValueOnce(firstOperation.promise).mockReturnValueOnce(nextOperation.promise);
    mocked.rtCancel.mockReturnValue(cancellation.promise);
    renderPanel();
    fireEvent.click(await importButton());
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await act(async () => firstOperation.reject('portable runtime operation cancelled'));
    fireEvent.click(importButtonNow());
    await act(async () => cancellation.reject('synthetic late cancellation IPC error'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(environmentTask()?.state).toBe('running');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(importButtonNow()).toBeDisabled();
    await act(async () => nextOperation.resolve({ provider: 'vllm', id: 'portable-0-31-0-next' }));
    expect(environmentTask()?.state).toBe('completed');
  });

  it('keeps globally cancelled work active and retryable after its cancellation request fails', async () => {
    const operation = deferred<unknown>();
    const onBusyChange = vi.fn();
    mocked.providerPortableImport.mockReturnValue(operation.promise);
    mocked.rtCancel.mockRejectedValueOnce('synthetic global cancellation IPC unavailable');
    renderPanel(false, onBusyChange, true);
    fireEvent.click(await importButton());
    const strip = within(screen.getByRole('complementary', { name: 'Background tasks' }));
    fireEvent.click(strip.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(environmentTask()?.state).toBe('running'));
    expect(strip.getByText(/synthetic global cancellation IPC unavailable/)).toBeVisible();
    expect(screen.getByRole('alert')).toHaveTextContent('synthetic global cancellation IPC unavailable');
    expect(importButtonNow()).toBeDisabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(strip.getByRole('button', { name: 'Cancel' }));
    expect(mocked.rtCancel).toHaveBeenCalledTimes(2);
    await act(async () => undefined);
    expect(environmentTask()?.state).toBe('cancelling');
    expect(strip.getByRole('button', { name: 'Cancelling' })).toBeDisabled();
    expect(importButtonNow()).toBeDisabled();
    await act(async () => operation.reject('portable runtime operation cancelled'));
    expect(environmentTask()?.state).toBe('cancelled');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(importButtonNow()).toBeEnabled();
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it('does not let a global cancellation rejection replace the next operation with a failed task', async () => {
    const firstOperation = deferred<unknown>();
    const nextOperation = deferred<unknown>();
    const cancellation = deferred<void>();
    mocked.providerPortableImport.mockReturnValueOnce(firstOperation.promise).mockReturnValueOnce(nextOperation.promise);
    mocked.rtCancel.mockReturnValue(cancellation.promise);
    renderPanel(false, undefined, true);
    fireEvent.click(await importButton());
    const strip = within(screen.getByRole('complementary', { name: 'Background tasks' }));
    fireEvent.click(strip.getByRole('button', { name: 'Cancel' }));
    await act(async () => firstOperation.reject('portable runtime operation cancelled'));
    fireEvent.click(importButtonNow());
    await act(async () => cancellation.reject('synthetic previous cancellation IPC error'));
    expect(environmentTask()?.state).toBe('running');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(strip.getByRole('button', { name: 'Cancel' })).toBeEnabled();
    expect(importButtonNow()).toBeDisabled();
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
    await act(async () => nextOperation.resolve({ provider: 'vllm', id: 'portable-0-31-0-next' }));
    expect(environmentTask()?.state).toBe('completed');
  });

  it('ignores a retained cancellation callback from an earlier operation without cancelling the new one', async () => {
    const firstOperation = deferred<unknown>();
    const nextOperation = deferred<unknown>();
    mocked.providerPortableImport.mockReturnValueOnce(firstOperation.promise).mockReturnValueOnce(nextOperation.promise);
    renderPanel(false, undefined, true);
    fireEvent.click(await importButton());
    const previousCancel = environmentTask()?.cancel;
    expect(previousCancel).toBeDefined();
    await act(async () => firstOperation.reject('portable runtime operation cancelled'));
    fireEvent.click(importButtonNow());
    await act(async () => previousCancel?.());
    expect(mocked.rtCancel).not.toHaveBeenCalled();
    expect(environmentTask()?.state).toBe('running');
    const strip = within(screen.getByRole('complementary', { name: 'Background tasks' }));
    fireEvent.click(strip.getByRole('button', { name: 'Cancel' }));
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
    expect(environmentTask()?.state).toBe('cancelling');
    await act(async () => previousCancel?.());
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
    await act(async () => nextOperation.reject('portable runtime operation cancelled'));
    expect(environmentTask()?.state).toBe('cancelled');
  });
});

describe('provider environment installation', () => {
  it('announces a completed installation as a download', async () => {
    mocked.providerInstall.mockResolvedValue(runtime());
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Install isolated environment 0.31.0' }));
    await waitFor(() => expect(environmentTask()?.state).toBe('completed'));
    expect(vi.mocked(notifyCompletion).mock.calls).toEqual([['download']]);
  });

  it.each(['runtime installation cancelled', 'runtime probe cancelled'])('shows %s as cancellation without an error banner', async message => {
    mocked.providerInstall.mockRejectedValue(message);
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Install isolated environment 0.31.0' }));
    await waitFor(() => expect(environmentTask()?.state).toBe('cancelled'));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(notifyCompletion).not.toHaveBeenCalled();
  });
});
