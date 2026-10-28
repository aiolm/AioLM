import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useSyncExternalStore } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createConfigSaveQueue, type ConfigPatch } from '../../shared/state/configSaveQueue';
import type { AppStore } from '../../shared/state/store';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import SessionsPanel from './Sessions';

vi.mock('../model-settings/ModelSettingsProvider', () => ({ useModelSettings: () => null }));
vi.mock('../../shared/api/index', () => ({
  sessionList: vi.fn(async () => []), sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => Array.isArray(value) ? value : [],
  sessionStart: vi.fn(), sessionStop: vi.fn(), sessionUnload: vi.fn(),
  isNativeRuntimeAvailable: () => false, rtList: vi.fn(async () => []), providerRuntimes: vi.fn(async () => []),
}));

const work: api.SessionDefinition = {
  id: 'work', name: 'Work session', enabled: true,
  models: { primary_model: 'models/work.gguf', mmproj: '', draft_model: '' },
  gpu: { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null },
  execution: { ctx_size: 8192, temperature: 0.2 },
};
const other: api.SessionDefinition = { ...structuredClone(work), id: 'other', name: 'Other session' };
const later: api.SessionDefinition = { ...structuredClone(work), id: 'later', name: 'Later session' };
const base = {
  active_model: 'models/default.gguf', mmproj: '', spec_draft_model: '', port: 8080,
  ctx_size: 4096, temperature: 0.7, gpu: structuredClone(work.gpu),
  sessions: [work, other], stop_existing_sessions_on_load: false,
  synthetic_unrelated: { nested: ['keep exact'] },
} as unknown as api.AppConfig;

function queuedStore(transform: (saved: api.AppConfig) => api.AppConfig = saved => saved) {
  let current = structuredClone(base);
  const listeners = new Set<() => void>();
  let finishHead: (() => void) | undefined;
  let failHead: ((error: Error) => void) | undefined;
  const persisted: api.AppConfig[] = [];
  const persist = vi.fn(async (next: api.AppConfig) => {
    const snapshot = structuredClone(next);
    persisted.push(snapshot);
    if (persisted.length === 1) await new Promise<void>((resolve, reject) => { finishHead = resolve; failHead = reject; });
    return transform(snapshot);
  });
  const publish = (next: api.AppConfig) => { current = next; for (const notify of listeners) notify(); };
  const update = createConfigSaveQueue(() => current, publish, persist, () => undefined);
  const store = {
    get cfg() { return current; }, getConfig: () => current,
    updateConfig: vi.fn((patch: ConfigPatch<api.AppConfig>) => update(patch)),
    status: { state: 'stopped' }, busy: false, start: vi.fn(), stop: vi.fn(), refreshStatus: vi.fn(),
  } as unknown as AppStore;
  function Harness() {
    useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => current);
    return <I18nProvider initialLocale="en"><SessionsPanel store={store} /></I18nProvider>;
  }
  return { store, Harness, persist, persisted,
    release: () => { if (!finishHead) throw new Error('Head persistence not started'); finishHead(); },
    reject: (error: Error) => { if (!failHead) throw new Error('Head persistence not started'); failHead(error); },
  };
}

describe('session name saves in the configuration queue', () => {
  beforeEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); vi.clearAllMocks(); });

  it.each(['sessions', 'execution'] as const)('preserves earlier queued %s updates when saving a session name', async target => {
    const harness = queuedStore();
    render(<harness.Harness />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Work session' })).getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Renamed' } });

    let head!: Promise<api.AppConfig>;
    await act(async () => { head = harness.store.updateConfig({ port: 8181 }); });
    expect(harness.persist).toHaveBeenCalledOnce();
    let previous!: Promise<api.AppConfig>;
    act(() => {
      previous = harness.store.updateConfig(current => ({ sessions: target === 'sessions'
        ? [...(current.sessions ?? []), structuredClone(later)]
        : (current.sessions ?? []).map(item => item.id === 'work'
          ? { ...item, enabled: false, execution: { ...item.execution, ctx_size: 32768 } } : item) }));
    });
    // The earlier updater is queued, not published, while native persistence waits.
    expect(harness.store.cfg!.sessions).toEqual(base.sessions);
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    expect(harness.store.updateConfig).toHaveBeenCalledTimes(3);
    await act(async () => { harness.release(); await head; await previous; });
    await waitFor(() => expect(harness.persist).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save session' })).toBeEnabled());

    const savedWork = harness.store.cfg!.sessions!.find(item => item.id === 'work')!;
    expect(savedWork.name).toBe('Renamed');
    expect(harness.store.cfg!.port).toBe(8181);
    expect((harness.store.cfg as unknown as typeof base & { synthetic_unrelated: unknown }).synthetic_unrelated).toEqual({ nested: ['keep exact'] });
    expect(harness.store.cfg!.sessions!.find(item => item.id === 'other')).toEqual(other);
    expect(harness.persisted[1].sessions).toEqual(target === 'sessions'
      ? [...base.sessions!, later]
      : base.sessions!.map(item => item.id === 'work' ? { ...item, enabled: false, execution: { ...item.execution, ctx_size: 32768 } } : item));
    if (target === 'sessions') {
      expect(harness.store.cfg!.sessions!.find(item => item.id === 'later')).toEqual(later);
      expect(screen.getByRole('article', { name: 'Later session' })).toBeVisible();
    } else {
      expect(savedWork.execution?.ctx_size).toBe(32768);
      expect(savedWork.enabled).toBe(false);
    }
  });

  it('retains already-published newer execution settings and other sessions on a name save', async () => {
    const harness = queuedStore();
    render(<harness.Harness />);
    let head!: Promise<api.AppConfig>;
    await act(async () => { head = harness.store.updateConfig({ sessions: [
      { ...work, enabled: false, execution: { ...work.execution, ctx_size: 32768 } }, other, later,
    ] }); });
    await act(async () => { harness.release(); await head; });
    const row = within(screen.getByRole('article', { name: 'Work session' }));
    fireEvent.click(row.getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'Renamed' })).toBeVisible());
    expect(harness.store.cfg!.sessions).toEqual([other, later, { ...work, name: 'Renamed', enabled: false, execution: { ...work.execution, ctx_size: 32768 } }]);
  });

  it.each([
    ['  Focus session  ', 'Focus session'],
    ['   ', 'default.gguf'],
  ])('saves a new session with entered name %j only after explicit Save', async (name, savedName) => {
    const harness = queuedStore();
    render(<harness.Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(harness.store.updateConfig).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: name } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(harness.persist).toHaveBeenCalledOnce());
    const pending = harness.persisted[0].sessions!.find(item => item.id !== 'work' && item.id !== 'other')!;
    expect(pending).toEqual(expect.objectContaining({ id: expect.stringMatching(/^session-/), name: savedName, models: {
      primary_model: base.active_model, mmproj: '', draft_model: '',
    }, gpu: work.gpu, enabled: true }));
    await act(async () => harness.release());
    await waitFor(() => expect(screen.getByRole('article', { name: savedName })).toBeVisible());
    expect(harness.store.cfg!.sessions).toEqual([work, other, pending]);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('preserves the unsaved name and original definitions after failure, then saves on retry', async () => {
    const harness = queuedStore();
    render(<harness.Harness />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Work session' })).getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Keep my draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(harness.persist).toHaveBeenCalledOnce());
    await act(async () => harness.reject(new Error('Synthetic session name save failure')));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic session name save failure');
    expect(harness.store.cfg!.sessions).toEqual(base.sessions);
    expect(screen.getByLabelText('Session name')).toHaveValue('Keep my draft');
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(screen.getByRole('article', { name: 'Keep my draft' })).toBeVisible());
    expect(harness.store.cfg!.sessions!.find(item => item.id === 'work')?.name).toBe('Keep my draft');
    expect(harness.store.cfg!.sessions!.find(item => item.id === 'other')).toEqual(other);
  });

  it('uses the actual saved definitions and editor returned by persistence', async () => {
    const harness = queuedStore(saved => ({ ...saved, sessions: saved.sessions?.map(item => item.id === 'work'
      ? { ...item, name: 'Saved canonical name', execution: { ...item.execution, ctx_size: 24576 } } : item) }));
    render(<harness.Harness />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Work session' })).getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Requested name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(harness.persist).toHaveBeenCalledOnce());
    await act(async () => harness.release());
    expect(harness.store.cfg!.sessions!.find(item => item.id === 'work')).toEqual({ ...work, name: 'Saved canonical name', execution: { ...work.execution, ctx_size: 24576 } });
    expect(screen.getByLabelText('Session name')).toHaveValue('Saved canonical name');
    expect(screen.getByRole('article', { name: 'Saved canonical name' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
  });

  it('preserves another selected session and its later unsaved name when an older save completes', async () => {
    const harness = queuedStore();
    render(<harness.Harness />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Work session' })).getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Saved work name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(harness.persist).toHaveBeenCalledOnce());
    // Persistence can start before React commits the optimistic session row.
    await waitFor(() => expect(screen.getByRole('article', { name: 'Saved work name' })).toBeVisible());
    fireEvent.click(within(screen.getByRole('article', { name: 'Other session' })).getByRole('button', { name: /Other session/ }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Keep other draft' } });
    await act(async () => harness.release());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save session' })).toBeEnabled());
    expect(screen.getByRole('article', { name: 'Saved work name' })).toBeVisible();
    expect(screen.getByLabelText('Session name')).toHaveValue('Keep other draft');
    expect(harness.store.cfg!.sessions!.find(item => item.id === 'other')).toEqual(other);
    expect(within(screen.getByRole('article', { name: 'Other session' })).getByRole('button', { name: /Other session/ })).toHaveAttribute('aria-expanded', 'true');
  });

  it('does not recreate a session omitted from the authoritative saved configuration', async () => {
    const harness = queuedStore(saved => ({ ...saved, sessions: saved.sessions?.filter(item => item.id !== 'work') }));
    render(<harness.Harness />);
    fireEvent.click(within(screen.getByRole('article', { name: 'Work session' })).getByRole('button', { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Requested name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save session' }));
    await waitFor(() => expect(harness.persist).toHaveBeenCalledOnce());
    await act(async () => harness.release());
    expect(harness.store.cfg!.sessions).toEqual([other]);
    expect(screen.queryByRole('article', { name: 'Work session' })).not.toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Requested name' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Session name')).not.toBeInTheDocument();
    expect(screen.getByRole('article', { name: 'Other session' })).toBeVisible();
  });
});
