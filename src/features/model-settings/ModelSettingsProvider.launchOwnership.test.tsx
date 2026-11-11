import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import * as api from '../../shared/api/index';
import type { AppConfig } from '../../shared/api/types';
import { I18nProvider } from '../../shared/i18n/i18n';
import { modelSettingsCopy } from './modelSettingsCopy';
import { createTestStore } from '../../testing/appStore';
import { ModelSettingsProvider, useModelSettings } from './ModelSettingsProvider';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import TaskStrip from '../../shared/ui/TaskStrip';
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
  cancelLaunch: vi.fn(async () => undefined),
  sessionStart: vi.fn(async () => undefined),
  sessionStop: vi.fn(async () => undefined),
  applyRequestSettings: vi.fn(async (cfg: AppConfig) => cfg),
}));

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((finish, fail) => { resolve = finish; reject = fail; });
  return { promise, resolve, reject };
}

function OpenTargets() {
  const settings = useModelSettings();
  return <>
    <button onClick={() => settings!.open({ target: { kind: 'default' }, section: 'model' })}>Open default target A</button>
    <button onClick={() => settings!.open({ target: { kind: 'session', sessionId: 'work' }, section: 'model' })}>Open session target B</button>
    <TaskStrip launchesOnly />
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
afterEach(() => { cleanup(); for (const task of getTaskSnapshot()) removeTask(task.id); });

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
    expect(api.cancelLaunch).not.toHaveBeenCalled();
    expect(inheritedCancel).not.toBeInTheDocument();

    await act(async () => saveB.resolve());
    await waitFor(() => expect(editorB).not.toHaveAttribute('aria-busy', 'true'));
    expect(store.cfg?.active_model).toBe('models/a.gguf');
    expect(store.cfg?.sessions?.find(session => session.id === 'work')?.models.primary_model).toBe('models/b.gguf');
    expect(api.sessionStart).not.toHaveBeenCalled();
    expect(store.start).toHaveBeenCalledOnce();
    await act(async () => launchA.resolve('synthetic-completion'));
    expect(editorB).toBeInTheDocument();
  } finally {
    await act(async () => { saveA.resolve(); saveB.resolve(); launchA.resolve('synthetic-completion'); });
  }
});

it('keeps the current launch cancellable outside the editor when a prior launch completes', async () => {
  const store = targets();
  const sessionLaunch = deferred<api.SessionStatus>();
  const sessionComplete: api.SessionStatus = { id: 'work', name: 'Work', state: 'running', model: 'models/b.gguf', active_requests: 0, idle_seconds: 0 };
  const defaultLaunch = deferred<string>();
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
    await waitFor(() => expect(sessionEditor).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Open default target A' }));
    const defaultEditor = await screen.findByRole('dialog', { name: 'Model & settings' });
    const defaultStart = editorActions(defaultEditor).getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(defaultStart).toBeEnabled());
    fireEvent.click(defaultStart);
    await waitFor(() => expect(store.start).toHaveBeenCalledOnce());
    await waitFor(() => expect(defaultEditor).not.toBeInTheDocument());
    const defaultTask = getTaskSnapshot().find(task => task.targetId === 'default')!;
    const row = screen.getByTestId('launch-task-strip').querySelector<HTMLElement>(`[data-task-id="${defaultTask.id}"]`)!;
    expect(within(row).getByRole('progressbar')).not.toHaveAttribute('value');
    await act(async () => sessionLaunch.resolve(sessionComplete));
    fireEvent.click(within(row).getByRole('button', { name: 'Cancel' }));
    expect(store.stop).toHaveBeenCalledExactlyOnceWith(defaultTask.id);
    expect(api.sessionStop).not.toHaveBeenCalled();
    expect(api.cancelLaunch).not.toHaveBeenCalled();
    expect(row).toHaveTextContent('Cancelling');
  } finally {
    await act(async () => { sessionLaunch.resolve(sessionComplete); defaultLaunch.reject(new Error('server start cancelled')); });
  }
});

it.each(['en', 'ko', 'ja', 'zh'] as const)('keeps a cancelled handed-off launch quiet and its saved settings in %s', async locale => {
  const copy = modelSettingsCopy[locale];
  const store = targets();
  const sessionLaunch = deferred<api.SessionStatus>();
  const preflight = deferred<AppConfig>();
  vi.mocked(api.sessionStart).mockReturnValueOnce(sessionLaunch.promise);
  vi.mocked(api.preflightLaunch).mockReturnValueOnce(preflight.promise);
  render(<I18nProvider initialLocale={locale}><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);

  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open session target B' }));
    const editor = await screen.findByRole('dialog', { name: copy.title });
    const start = editorActions(editor).getByRole('button', { name: copy.start });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(api.preflightLaunch).toHaveBeenCalledOnce());
    await waitFor(() => expect(editor).not.toBeInTheDocument());
    await act(async () => preflight.resolve(structuredClone(vi.mocked(api.preflightLaunch).mock.calls[0][0])));
    await waitFor(() => expect(api.sessionStart).toHaveBeenCalledOnce());
    fireEvent.click(within(screen.getByTestId('launch-task-strip')).getByRole('button', { name: copy.cancel }));
    expect(api.cancelLaunch).toHaveBeenCalledExactlyOnceWith(vi.mocked(api.preflightLaunch).mock.calls[0][1], 'work');
    expect(api.sessionStop).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    await act(async () => { sessionLaunch.reject(new Error('server start cancelled')); });
    await waitFor(() => expect(screen.queryByRole('dialog', { name: copy.title })).not.toBeInTheDocument());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText('server start cancelled')).not.toBeInTheDocument();
    // Cancelling the launch does not undo the save that preceded it.
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(store.cfg?.sessions?.find(session => session.id === 'work')?.models.primary_model).toBe('models/b.gguf');
  } finally {
    await act(async () => { preflight.resolve(store.cfg!); sessionLaunch.resolve({ id: 'work', name: 'Work', state: 'stopped', model: 'models/b.gguf', active_requests: 0, idle_seconds: 0 }); });
  }
});

it('keeps a handed-off session launch failure that mentions cancellation visible with its full detail', async () => {
  const store = targets();
  const sessionLaunch = deferred<api.SessionStatus>();
  vi.mocked(api.sessionStart).mockReturnValueOnce(sessionLaunch.promise);
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);
  const failure = 'llama-server exited before ready (exit code 1)\nload_tensors: request cancelled by allocator after 0 of 291 tensors\nmodel: /synthetic/cancelled-runs/a.gguf\n' + 'synthetic placement detail retained verbatim\n'.repeat(8);

  try {
    fireEvent.click(screen.getByRole('button', { name: 'Open session target B' }));
    const editor = await screen.findByRole('dialog', { name: 'Model & settings' });
    const start = editorActions(editor).getByRole('button', { name: 'Save profile & start' });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() => expect(api.sessionStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Model & settings' })).not.toBeInTheDocument());
    await act(async () => { sessionLaunch.reject(new Error(failure)); });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('llama-server exited before ready (exit code 1)');
    expect(alert).toHaveTextContent('request cancelled by allocator');
    expect(alert.querySelector('pre')?.textContent).toBe(failure);
  } finally {
    await act(async () => { sessionLaunch.resolve({ id: 'work', name: 'Work', state: 'stopped', model: 'models/b.gguf', active_requests: 0, idle_seconds: 0 }); });
  }
});

it.each(['cancelled', 'failed'] as const)('keeps launch ownership live while saving and preserves the editor on a %s save', async outcome => {
  const store = targets();
  const gate = deferred<void>();
  const save = store.updateConfig;
  store.updateConfig = vi.fn(async patch => { await gate.promise; return save(patch); });
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open default target A' }));
  const editor = await screen.findByRole('dialog', { name: 'Model & settings' });
  const start = editorActions(editor).getByRole('button', { name: 'Save profile & start' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  expect(within(editor).getByRole('progressbar', { name: /Preparing model launch/ })).not.toHaveAttribute('value');
  await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
  expect(within(editor).getByRole('progressbar', { name: /Saving/ })).not.toHaveAttribute('value');
  expect(within(editor).getByRole('button', { name: 'Close' })).toBeDisabled();
  if (outcome === 'cancelled') {
    fireEvent.click(editorActions(editor).getByRole('button', { name: 'Cancel' }));
    await act(async () => gate.resolve());
    await waitFor(() => expect(editor).not.toBeInTheDocument());
    expect(within(screen.getByTestId('launch-task-strip')).getByRole('status')).toHaveTextContent('Cancelled');
    expect(store.cfg?.active_model).toBe('models/a.gguf');
  } else {
    await act(async () => gate.reject(new Error('disk full')));
    expect(editor).toBeInTheDocument();
    expect(within(editor).getByRole('alert')).toHaveTextContent('disk full');
    expect(start).toBeEnabled();
  }
  expect(api.preflightLaunch).not.toHaveBeenCalled();
  expect(api.cancelLaunch).toHaveBeenCalledTimes(outcome === 'cancelled' ? 1 : 0);
  expect(store.start).not.toHaveBeenCalled();
  expect(store.stop).not.toHaveBeenCalled();
});

it('keeps a late preflight failure outside a newer editor and recovers the saved original target', async () => {
  const store = targets();
  const preflight = deferred<AppConfig>();
  vi.mocked(api.preflightLaunch).mockReturnValueOnce(preflight.promise);
  render(<I18nProvider initialLocale="en"><ModelSettingsProvider store={store}><OpenTargets /></ModelSettingsProvider></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Open session target B' }));
  const original = await screen.findByRole('dialog', { name: 'Model & settings' });
  const start = editorActions(original).getByRole('button', { name: 'Save profile & start' });
  await waitFor(() => expect(start).toBeEnabled());
  fireEvent.click(start);
  await waitFor(() => expect(api.preflightLaunch).toHaveBeenCalledOnce());
  expect(original).not.toBeInTheDocument();
  expect(store.updateConfig).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: 'Open default target A' }));
  const newer = await screen.findByRole('dialog', { name: 'Model & settings' });
  await act(async () => preflight.reject(new Error('selected runtime cannot load this model')));
  expect(newer).toBeInTheDocument();
  expect(newer).toHaveTextContent('Default execution');
  expect(api.sessionStart).not.toHaveBeenCalled();
  fireEvent.click(within(newer).getByRole('button', { name: 'Close' }));
  const strip = within(screen.getByTestId('launch-task-strip'));
  expect(strip.getByRole('alert')).toHaveTextContent('selected runtime cannot load this model');
  fireEvent.click(strip.getByRole('button', { name: 'Review saved model settings' }));
  const recovered = await screen.findByRole('dialog', { name: 'Model & settings' });
  expect(recovered).toHaveTextContent('Session: Work');
  expect(recovered.querySelector<HTMLInputElement>('input[aria-label="Model path"]')).toHaveValue('models/b.gguf');
  expect(store.cfg?.sessions?.find(session => session.id === 'work')?.models.primary_model).toBe('models/b.gguf');
});
