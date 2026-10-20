import { useRef, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/index';
import type { AppConfig } from '../../shared/api/types';
import type { AppStore } from '../../shared/state/store';
import { createConfigSaveQueue } from '../../shared/state/configSaveQueue';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import ModelsPanel from './Models';

vi.mock('../../shared/api/index', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/index')>(),
  isNativeRuntimeAvailable: vi.fn(() => true),
  listModels: vi.fn(), cancelModelScan: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []), deleteModel: vi.fn(),
}));

const alpha = '/models/alpha.gguf';
const beta = '/models/beta.gguf';
const bindingRefusal = 'select another model/projector/draft before deleting the active file';
const catalog = [alpha, beta].map(path => ({ path, name: path.split('/').pop()!, size_mb: 1, is_vision: false }));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(complete => { resolve = complete; });
  return { promise, resolve };
}

function fixture(activeModel = alpha, failure?: string, pauseAfterGuard = false) {
  const initial: AppConfig = { ...structuredClone(testConfig), models_dir: '/models', active_model: activeModel, ctx_size: 8192, temperature: 0.35 };
  let saved = structuredClone(initial);
  const writes: AppConfig[] = [];
  const guardReads: AppConfig[] = [];
  const removed = new Set<string>();
  const entry = deferred();
  const guarded = deferred();
  const completion = deferred();
  let nextSaveResponse: { started: ReturnType<typeof deferred>; response: ReturnType<typeof deferred> } | undefined;
  vi.mocked(api.listModels).mockImplementation(async () => ({ models: catalog.filter(model => !removed.has(model.path)), truncated: false }));
  vi.mocked(api.deleteModel).mockImplementation(async path => {
    await entry.promise;
    const current = structuredClone(saved);
    guardReads.push(current);
    if ([current.active_model, current.mmproj, current.spec_draft_model].includes(path)) throw new Error(bindingRefusal);
    guarded.resolve();
    if (pauseAfterGuard) await completion.promise;
    if (failure) throw new Error(failure);
    removed.add(path);
  });

  function View() {
    const [cfg, setCfg] = useState(initial);
    const current = useRef(cfg);
    const [updateConfig] = useState(() => createConfigSaveQueue<AppConfig>(
      () => current.current,
      next => { current.current = next; setCfg(next); },
      async next => {
        saved = structuredClone(next);
        writes.push(structuredClone(next));
        const held = nextSaveResponse;
        nextSaveResponse = undefined;
        if (held) {
          held.started.resolve();
          await held.response.promise;
        }
        return structuredClone(next);
      },
      error => { throw error; },
    ));
    const store: AppStore = {
      cfg, status: { state: 'stopped' }, busy: false,
      bootState: 'ready', bootError: null, actionError: null, statusPollError: null,
      getConfig: () => current.current, getConfigRevision: () => writes.length + 1,
      updateConfig, loadConfig: async () => undefined, refreshStatus: async () => undefined,
      start: async () => '', stop: async () => undefined,
      clearActionError: () => undefined, clearErrors: () => undefined,
    };
    return <I18nProvider initialLocale="en">
      <output data-testid="saved-model-config">{JSON.stringify(cfg)}</output>
      <ModelsPanel store={store} compact onSelectModel={async model => { await updateConfig({ active_model: model.path }); }} />
    </I18nProvider>;
  }

  return {
    initial, View, writes, guardReads, removed, saved: () => structuredClone(saved), release: entry.resolve,
    guarded: guarded.promise, complete: completion.resolve,
    holdNextSaveResponse() {
      const hold = { started: deferred(), response: deferred() };
      nextSaveResponse = hold;
      return { started: hold.started.promise, release: hold.response.resolve };
    },
  };
}

async function beginAlphaDeletion() {
  const remove = await screen.findByRole('button', { name: 'Delete: alpha.gguf' });
  await waitFor(() => expect(remove).toBeEnabled());
  fireEvent.click(remove);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  await waitFor(() => expect(api.deleteModel).toHaveBeenCalledOnce());
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete model' })).not.toBeInTheDocument());
}

async function selectBeta() {
  const select = screen.getByRole('button', { name: 'Configure & run: beta.gguf' });
  expect(select).toBeEnabled();
  fireEvent.click(select);
  await waitFor(() => expect(JSON.parse(screen.getByTestId('saved-model-config').textContent!).active_model).toBe(beta));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(true);
  vi.mocked(api.sessionList).mockResolvedValue([]);
});

describe('model deletion and current saved selection', () => {
  it('preserves a newer saved selection when deferred native deletion enters after that selection', async () => {
    const f = fixture(); render(<f.View />);
    await beginAlphaDeletion();
    expect(f.guardReads).toEqual([]);
    await selectBeta();
    await waitFor(() => expect(f.writes).toHaveLength(1));
    const selected = f.saved();
    expect(selected).toEqual({ ...f.initial, active_model: beta });
    expect(f.initial.active_model).toBe(alpha);
    await act(async () => { f.release(); await vi.mocked(api.deleteModel).mock.results[0].value; });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
    expect(f.guardReads).toEqual([selected]);
    expect(f.removed.has(alpha)).toBe(true);
    expect(f.saved()).toEqual(selected);
    expect(JSON.parse(screen.getByTestId('saved-model-config').textContent!)).toEqual(selected);
    expect(f.initial.active_model).toBe(alpha);
  });

  it('retains the selected bound model when native entry refuses its deletion', async () => {
    const f = fixture(); render(<f.View />);
    await beginAlphaDeletion();
    await act(async () => { f.release(); await vi.mocked(api.deleteModel).mock.results[0].value.catch(() => undefined); });
    expect(await screen.findByText(new RegExp(bindingRefusal))).toBeVisible();
    expect(f.guardReads).toEqual([f.initial]);
    expect(f.removed.size).toBe(0);
    expect(f.writes).toEqual([]);
    expect(f.saved()).toEqual(f.initial);
  });

  it('preserves an already saved different selection when deleting an unbound model', async () => {
    const f = fixture(beta); render(<f.View />);
    await beginAlphaDeletion();
    await act(async () => { f.release(); await vi.mocked(api.deleteModel).mock.results[0].value; });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
    expect(f.guardReads).toEqual([f.initial]);
    expect(f.removed.has(alpha)).toBe(true);
    expect(f.writes).toEqual([]);
    expect(f.saved()).toEqual(f.initial);
  });

  it('preserves a newer saved selection when deletion fails after the binding check', async () => {
    const f = fixture(alpha, 'Synthetic delete failed'); render(<f.View />);
    await beginAlphaDeletion();
    await selectBeta();
    await waitFor(() => expect(f.writes).toHaveLength(1));
    const selected = f.saved();
    await act(async () => { f.release(); await vi.mocked(api.deleteModel).mock.results[0].value.catch(() => undefined); });
    expect(await screen.findByText(/Synthetic delete failed/)).toBeVisible();
    expect(f.guardReads).toEqual([selected]);
    expect(f.removed.size).toBe(0);
    expect(f.saved()).toEqual(selected);
    expect(f.initial.active_model).toBe(alpha);
  });

  it('preserves a choice queued before deletion cleanup reaches the save queue', async () => {
    const f = fixture(alpha, undefined, true); render(<f.View />);
    await beginAlphaDeletion();
    await selectBeta();
    await act(async () => { f.release(); await f.guarded; });
    expect(f.guardReads).toEqual([{ ...f.initial, active_model: beta }]);

    // Deletion has already accepted an unbound file. A separate config save
    // can commit while its native work/response remains outstanding.
    const held = f.holdNextSaveResponse();
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: alpha.gguf' }));
    await act(async () => { await held.started; });
    expect(f.saved()).toEqual(f.initial);
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: beta.gguf' }));
    expect(JSON.parse(screen.getByTestId('saved-model-config').textContent!).active_model).toBe(alpha);

    await act(async () => { f.complete(); await vi.mocked(api.deleteModel).mock.results[0].value; });
    expect(f.removed.has(alpha)).toBe(true);
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
    const selected = { ...f.initial, active_model: beta };
    expect(f.saved()).toEqual(selected);
    expect(JSON.parse(screen.getByTestId('saved-model-config').textContent!)).toEqual(selected);
    expect(f.initial.active_model).toBe(alpha);
  });

  it('still clears a rebound current target after an unbound deletion was accepted', async () => {
    const f = fixture(alpha, undefined, true); render(<f.View />);
    await beginAlphaDeletion();
    await selectBeta();
    await act(async () => { f.release(); await f.guarded; });
    expect(f.guardReads).toEqual([{ ...f.initial, active_model: beta }]);
    const held = f.holdNextSaveResponse();
    fireEvent.click(screen.getByRole('button', { name: 'Configure & run: alpha.gguf' }));
    await act(async () => { await held.started; });
    expect(f.saved()).toEqual(f.initial);

    await act(async () => { f.complete(); await vi.mocked(api.deleteModel).mock.results[0].value; });
    await act(async () => { held.release(); });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
    expect(f.saved()).toEqual({ ...f.initial, active_model: '' });
    expect(f.removed.has(alpha)).toBe(true);
    expect(f.initial.active_model).toBe(alpha);
  });
});

type PendingDeleteOutcome = 'success' | 'failure' | 'disposed';
function pendingDeleteCompletion() {
  let resolve!: (outcome: PendingDeleteOutcome) => void;
  const promise = new Promise<PendingDeleteOutcome>(complete => { resolve = complete; });
  return { promise, resolve };
}

function pendingDeletionFixture() {
  const initial: AppConfig = { ...structuredClone(testConfig), models_dir: '/models', active_model: alpha, ctx_size: 8192, temperature: 0.35 };
  let saved = structuredClone(initial);
  let disposed = false;
  const writes: AppConfig[] = [];
  const removed = new Set<string>();
  const guardReads: Array<{ path: string; config: AppConfig }> = [];
  const requests: Array<{
    path: string; shards: string[] | undefined;
    entry: ReturnType<typeof deferred>;
    guarded: ReturnType<typeof deferred>;
    completion: ReturnType<typeof pendingDeleteCompletion>;
    native: Promise<void>;
  }> = [];

  vi.mocked(api.listModels).mockImplementation(async () => ({ models: catalog.filter(model => !removed.has(model.path)), truncated: false }));
  vi.mocked(api.deleteModel).mockImplementation((path, shards) => {
    // Every invocation owns a request; the boundary must expose duplicates.
    const entry = deferred();
    const guarded = deferred();
    const completion = pendingDeleteCompletion();
    const native = (async () => {
      try {
        await entry.promise;
        if (disposed) throw new Error('Synthetic pending deletion disposed');
        const current = structuredClone(saved);
        guardReads.push({ path, config: current });
        if ([current.active_model, current.mmproj, current.spec_draft_model].includes(path)) throw new Error(bindingRefusal);
        guarded.resolve();
        const outcome = await completion.promise;
        if (disposed || outcome === 'disposed') throw new Error('Synthetic pending deletion disposed');
        if (outcome === 'failure') throw new Error('Synthetic pending delete failed');
        removed.add(path);
      } finally {
        // Refusal/disposal also settles the handshake and unused completion.
        guarded.resolve();
        completion.resolve('disposed');
      }
    })();
    requests.push({ path, shards, entry, guarded, completion, native });
    // Attach a rejection observer immediately, including early-assertion cleanup.
    void native.catch(() => undefined);
    return native;
  });

  function View() {
    const [cfg, setCfg] = useState(initial);
    const current = useRef(cfg);
    const [updateConfig] = useState(() => createConfigSaveQueue<AppConfig>(
      () => current.current,
      next => { current.current = next; setCfg(next); },
      async next => { saved = structuredClone(next); writes.push(structuredClone(next)); return structuredClone(next); },
      error => { throw error; },
    ));
    const store: AppStore = {
      cfg, status: { state: 'stopped' }, busy: false,
      bootState: 'ready', bootError: null, actionError: null, statusPollError: null,
      getConfig: () => current.current, getConfigRevision: () => writes.length + 1,
      updateConfig, loadConfig: async () => undefined, refreshStatus: async () => undefined,
      start: async () => '', stop: async () => undefined,
      clearActionError: () => undefined, clearErrors: () => undefined,
    };
    return <I18nProvider initialLocale="en">
      <output data-testid="saved-model-config">{JSON.stringify(cfg)}</output>
      <ModelsPanel store={store} compact onSelectModel={async model => { await updateConfig({ active_model: model.path }); }} />
    </I18nProvider>;
  }

  return {
    initial, View, requests, writes, removed, guardReads,
    saved: () => structuredClone(saved),
    async dispose() {
      disposed = true;
      for (const request of requests) { request.entry.resolve(); request.completion.resolve('disposed'); }
      await Promise.allSettled(requests.map(request => request.native));
    },
  };
}

async function withPendingDeletionFixture(run: (f: ReturnType<typeof pendingDeletionFixture>) => Promise<void>) {
  const f = pendingDeletionFixture();
  const view = render(<f.View />);
  try { await run(f); }
  finally {
    // Unmount cancels product scan/poll subscriptions before reaping every issued request.
    view.unmount();
    await act(async () => { await f.dispose(); });
  }
}

async function confirmPendingDeletion(path: string) {
  const name = path.split('/').pop()!;
  const remove = await screen.findByRole('button', { name: `Delete: ${name}` });
  await waitFor(() => expect(remove).toBeEnabled());
  fireEvent.click(remove);
  fireEvent.click(await screen.findByRole('button', { name: 'Delete model' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete model' })).not.toBeInTheDocument());
}

describe('model deletion request ownership', () => {
  it('issues one same-path request before native entry and preserves a newer saved selection', async () => {
    await withPendingDeletionFixture(async f => {
      await confirmPendingDeletion(alpha);
      expect(api.deleteModel).toHaveBeenCalledTimes(1);
      expect(f.requests).toHaveLength(1);
      expect(f.guardReads).toEqual([]);
      await confirmPendingDeletion(alpha);
      await confirmPendingDeletion(alpha);
      // These are actual repeated component confirmations, before any delivery.
      expect(api.deleteModel).toHaveBeenCalledTimes(1);
      expect(f.requests).toHaveLength(1);
      expect(f.guardReads).toEqual([]);
      await selectBeta();
      await waitFor(() => expect(f.writes).toHaveLength(1));
      const selected = { ...f.initial, active_model: beta };
      expect(f.saved()).toEqual(selected);
      const request = f.requests[0];
      await act(async () => { request.entry.resolve(); await request.guarded.promise; });
      expect(f.guardReads).toEqual([{ path: alpha, config: selected }]);
      await act(async () => { request.completion.resolve('success'); await request.native; });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
      expect(f.removed).toEqual(new Set([alpha]));
      expect(f.saved()).toEqual(selected);
      expect(JSON.parse(screen.getByTestId('saved-model-config').textContent!)).toEqual(selected);
      expect(f.writes).toEqual([selected]);
      expect(f.initial.active_model).toBe(alpha);
    });
  });

  it('keeps ownership through accepted native work and allows another card selection', async () => {
    await withPendingDeletionFixture(async f => {
      await confirmPendingDeletion(alpha);
      await selectBeta();
      const request = f.requests[0];
      await act(async () => { request.entry.resolve(); await request.guarded.promise; });
      await confirmPendingDeletion(alpha);
      expect(api.deleteModel).toHaveBeenCalledTimes(1);
      // The accepted deletion remains pending, but selection is still available.
      const select = screen.getByRole('button', { name: 'Configure & run: beta.gguf' });
      expect(select).toBeEnabled();
      fireEvent.click(select);
      await waitFor(() => expect(f.writes).toHaveLength(2));
      const selected = { ...f.initial, active_model: beta };
      await act(async () => { request.completion.resolve('failure'); await request.native.catch(() => undefined); });
      expect(await screen.findByText(/Synthetic pending delete failed/)).toBeVisible();
      expect(f.saved()).toEqual(selected);
      expect(f.writes).toEqual([selected, selected]);
      expect(f.removed.size).toBe(0);
    });
  });

  it('allows a same-path retry after native failure without losing the saved selection', async () => {
    await withPendingDeletionFixture(async f => {
      await confirmPendingDeletion(alpha);
      await selectBeta();
      const selected = { ...f.initial, active_model: beta };
      const first = f.requests[0];
      await act(async () => { first.entry.resolve(); await first.guarded.promise; });
      await act(async () => { first.completion.resolve('failure'); await first.native.catch(() => undefined); });
      expect(await screen.findByText(/Synthetic pending delete failed/)).toBeVisible();
      await confirmPendingDeletion(alpha);
      expect(api.deleteModel).toHaveBeenCalledTimes(2);
      expect(f.requests.map(request => request.path)).toEqual([alpha, alpha]);
      const retry = f.requests[1];
      await act(async () => { retry.entry.resolve(); await retry.guarded.promise; });
      await act(async () => { retry.completion.resolve('success'); await retry.native; });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
      expect(f.guardReads).toEqual([{ path: alpha, config: selected }, { path: alpha, config: selected }]);
      expect(f.saved()).toEqual(selected);
      expect(f.writes).toEqual([selected]);
      expect(f.removed).toEqual(new Set([alpha]));
    });
  });

  it('allows a different target while the first waits and still refuses the bound target', async () => {
    await withPendingDeletionFixture(async f => {
      await confirmPendingDeletion(alpha);
      await selectBeta();
      await confirmPendingDeletion(beta);
      expect(api.deleteModel).toHaveBeenCalledTimes(2);
      expect(f.requests.map(request => request.path)).toEqual([alpha, beta]);
      expect(f.guardReads).toEqual([]);
      const selected = { ...f.initial, active_model: beta };
      // Beta is still bound. Its independent request must refuse before success.
      const bound = f.requests[1];
      await act(async () => { bound.entry.resolve(); await bound.native.catch(() => undefined); });
      expect(await screen.findByText(new RegExp(bindingRefusal))).toBeVisible();
      expect(f.guardReads).toEqual([{ path: beta, config: selected }]);
      expect(f.removed.size).toBe(0);
      const first = f.requests[0];
      await act(async () => { first.entry.resolve(); await first.guarded.promise; });
      await act(async () => { first.completion.resolve('success'); await first.native; });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
      expect(screen.getByRole('button', { name: 'Delete: beta.gguf' })).toBeEnabled();
      expect(f.removed).toEqual(new Set([alpha]));
      expect(f.saved()).toEqual(selected);
      expect(f.writes).toEqual([selected]);
    });
  });

  it('releases ownership after bound-model refusal so a later unbound retry can proceed', async () => {
    await withPendingDeletionFixture(async f => {
      await confirmPendingDeletion(alpha);
      const first = f.requests[0];
      await act(async () => { first.entry.resolve(); await first.native.catch(() => undefined); });
      expect(await screen.findByText(new RegExp(bindingRefusal))).toBeVisible();
      expect(f.guardReads).toEqual([{ path: alpha, config: f.initial }]);
      expect(f.writes).toEqual([]);
      expect(f.removed.size).toBe(0);
      await confirmPendingDeletion(alpha);
      expect(api.deleteModel).toHaveBeenCalledTimes(2);
      await selectBeta();
      const retry = f.requests[1];
      await act(async () => { retry.entry.resolve(); await retry.guarded.promise; });
      await act(async () => { retry.completion.resolve('success'); await retry.native; });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Delete: alpha.gguf' })).not.toBeInTheDocument());
      const selected = { ...f.initial, active_model: beta };
      expect(f.saved()).toEqual(selected);
      expect(f.writes).toEqual([selected]);
      expect(f.removed).toEqual(new Set([alpha]));
    });
  });
});
