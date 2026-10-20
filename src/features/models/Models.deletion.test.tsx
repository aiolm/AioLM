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
