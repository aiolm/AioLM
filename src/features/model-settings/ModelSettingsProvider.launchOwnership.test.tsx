import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '../../shared/api/index';
import type { AppConfig } from '../../shared/api/types';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { ModelSettingsProvider, useModelSettings } from './ModelSettingsProvider';
// Compile the real lazy dependency before the interaction's ordinary DOM waits.
import './ModelSettingsDialog';

vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  isNativeRuntimeAvailable: () => false,
  providerCatalog: vi.fn(async () => [{ id: 'llama.cpp', engine: 'llama.cpp', server: 'llama-server', availability: { supported: true, detail: '' }, options: [] }]),
  providerRuntimes: vi.fn(async () => [{ id: 'b123-cpu', provider: 'llama.cpp', backend: 'cpu', build: 'b123', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: 'runtime', available: true, problems: [] }]),
  listModels: vi.fn(async () => ({ models: [
    { name: 'a.gguf', path: 'models/a.gguf', size_mb: 3, is_vision: false },
    { name: 'b.gguf', path: 'models/b.gguf', size_mb: 2, is_vision: false },
  ], truncated: false })),
  cancelModelScan: vi.fn(async () => undefined),
  rtList: vi.fn(async () => [{ backend: 'cpu', build: 'b123', dir: 'runtime', size_mb: 1 }]),
  deviceProfile: vi.fn(async () => ({ profile: { gpus: [] }, backends: [] })),
  rtProbe: vi.fn(async () => ({ backend: 'cpu', build: 'b123', devices: [], diagnostics: [], flags: [], state: 'available', server_help: '' })),
  modelMetadata: vi.fn(async () => ({})),
  estimateModelResources: vi.fn(async () => ({ vram_bytes: 0, ram_offload_bytes: 1024, ssd_offload_bytes: 0, required_vram_bytes: 0, host_memory_bytes: 1024, vram_capacity_bytes: null, ram_capacity_bytes: null, disk_bytes: 1024, disk_complete: true, model_bytes: 1024, auxiliary_bytes: 0, kv_bytes: null, notes: [] })),
  sessionList: vi.fn(async () => []),
  serverStatus: vi.fn(async () => ({ state: 'stopped' })),
  preflightLaunch: vi.fn(async (cfg: AppConfig) => structuredClone(cfg)),
  cancelLaunchPreflight: vi.fn(async () => false),
  sessionStart: vi.fn(async () => undefined),
  sessionStop: vi.fn(async () => undefined),
  applyRequestSettings: vi.fn(async (cfg: AppConfig) => cfg),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(finish => { resolve = finish; });
  return { promise, resolve };
}

function OpenTargets() {
  const settings = useModelSettings();
  return <>
    <button onClick={() => settings!.open({ target: { kind: 'default' }, section: 'model' })}>Open default target A</button>
    <button onClick={() => settings!.open({ target: { kind: 'session', sessionId: 'work' }, section: 'model' })}>Open session target B</button>
  </>;
}

function targets() {
  return createTestStore({ active_model: 'models/a.gguf', sessions: [{
    id: 'work', name: 'Work', enabled: true,
    models: { primary_model: 'models/b.gguf', mmproj: '', draft_model: '' },
    gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
  }] });
}

function editorActions(editor: HTMLElement) {
  // Keep action queries out of the editor's mounted, inactive option panels.
  const footer = editor.querySelector('footer');
  expect(footer).toBeInTheDocument();
  return within(footer!);
}

function profileActions(editor: HTMLElement) {
  // This banner is portalled outside the named settings-profile region.
  const banner = editor.querySelector<HTMLElement>('.settings-profile-banner');
  expect(banner).toBeInTheDocument();
  return within(banner!);
}

beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);

it('keeps an unrelated save free of launch cancellation after another target is handed off', async () => {
  const store = targets();
  const launchA = deferred<string>();
  const saveA = deferred<void>();
  const saveB = deferred<void>();
  vi.mocked(store.start).mockReturnValueOnce(launchA.promise);
  const save = store.updateConfig;
  let writes = 0;
  store.updateConfig = vi.fn(async patch => {
    await (++writes === 1 ? saveA.promise : saveB.promise);
    return save(patch);
  });
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);

  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open default target A' }));
    const editorA = await screen.findByRole('dialog', { name: 'Model & settings' });
    const start = editorActions(editorA).getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledTimes(1));
    expect(store.start).not.toHaveBeenCalled();
    await act(async () => saveA.resolve());
    await waitFor(() => expect(store.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument());
    // Loading continues after this modal closes, so another target can be edited.
    fireEvent.click(screen.getByRole('button', { name: 'Open session target B' }));
    const editorB = await screen.findByRole('dialog', { name: 'Model & settings' });
    expect(editorB).toHaveTextContent('Session: Work');
    const saveProfile = profileActions(editorB).getByRole('button', { name: 'Save profile' });
    await waitFor(() => expect(saveProfile).toBeEnabled());
    fireEvent.click(saveProfile);
    const saveConfirmation = screen.getByRole('dialog', { name: /^Save these changes to / });
    fireEvent.click(within(saveConfirmation).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(editorB).toHaveAttribute('aria-busy', 'true'));

    // A settings save owns no launch cancellation. Exercise any leaked action
    // before checking that it cannot stop either this target or the background one.
    const inheritedCancel = within(editorB).queryByRole('button', { name: 'Cancel' });
    if (inheritedCancel) fireEvent.click(inheritedCancel);
    expect(api.sessionStop).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    expect(api.cancelLaunchPreflight).not.toHaveBeenCalled();
    expect(inheritedCancel).not.toBeInTheDocument();

    await act(async () => saveB.resolve());
    await waitFor(() => expect(editorB).not.toHaveAttribute('aria-busy', 'true'));
    expect(store.cfg?.active_model).toBe('models/a.gguf');
    expect(store.cfg?.sessions?.find(session => session.id === 'work')?.models.primary_model).toBe('models/b.gguf');
    expect(api.sessionStart).not.toHaveBeenCalled();
    expect(store.start).toHaveBeenCalledOnce();
  } finally {
    await act(async () => { saveA.resolve(); saveB.resolve(); launchA.resolve('synthetic-completion'); });
  }
});

it('keeps the current launch cancellable when a previous handed-off launch completes', async () => {
  const store = targets();
  const sessionLaunch = deferred<api.SessionStatus>();
  const sessionComplete: api.SessionStatus = { id: 'work', name: 'Work', state: 'running', model: 'models/b.gguf', active_requests: 0, idle_seconds: 0 };
  const defaultLaunch = deferred<string>();
  const defaultRefresh = deferred<void>();
  vi.mocked(api.sessionStart).mockReturnValueOnce(sessionLaunch.promise);
  vi.mocked(store.start).mockReturnValueOnce(defaultLaunch.promise);
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);

  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open session target B' }));
    const sessionEditor = await screen.findByRole('dialog', { name: 'Model & settings' });
    const sessionStart = editorActions(sessionEditor).getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(sessionStart).toBeEnabled());
    fireEvent.click(sessionStart);
    await waitFor(() => expect(api.sessionStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument());

    // A named session's launch does not acquire the default AppStore's busy
    // flag. A default launch can begin while that session launch is handed off.
    fireEvent.click(screen.getByRole('button', { name: 'Open default target A' }));
    const defaultEditor = await screen.findByRole('dialog', { name: 'Model & settings' });
    const defaultStart = editorActions(defaultEditor).getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(defaultStart).toBeEnabled());
    const previousRefreshes = vi.mocked(store.refreshStatus).mock.calls.length;
    vi.mocked(store.refreshStatus).mockReturnValueOnce(defaultRefresh.promise);
    fireEvent.click(defaultStart);
    await waitFor(() => expect(store.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(store.refreshStatus).toHaveBeenCalledTimes(previousRefreshes + 1));
    expect(defaultEditor).toHaveAttribute('aria-busy', 'true');
    expect(editorActions(defaultEditor).getByRole('button', { name: 'Cancel' })).toBeEnabled();

    await act(async () => sessionLaunch.resolve(sessionComplete));
    await waitFor(() => expect(store.refreshStatus).toHaveBeenCalledTimes(previousRefreshes + 2));
    // The completed session must not remove the newer default operation's
    // cancellation action or redirect that action to the old session.
    fireEvent.click(editorActions(defaultEditor).getByRole('button', { name: 'Cancel' }));
    expect(store.stop).toHaveBeenCalledOnce();
    expect(api.sessionStop).not.toHaveBeenCalled();
    expect(api.cancelLaunchPreflight).not.toHaveBeenCalled();
    await act(async () => defaultRefresh.resolve());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument());
    expect(store.cfg?.active_model).toBe('models/a.gguf');
  } finally {
    await act(async () => { sessionLaunch.resolve(sessionComplete); defaultLaunch.resolve('synthetic-default-completion'); defaultRefresh.resolve(); });
  }
});
