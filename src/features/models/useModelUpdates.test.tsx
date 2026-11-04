import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '../../shared/api/transport';
import type { ModelUpdateResult, ModelUpdateStatus } from '../../shared/api/models';
import { getTaskSnapshot, registerTask, removeTask } from '../../shared/state/taskRegistry';
import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';
import { MODEL_CATALOG_CHANGED } from '../model-settings/useModelCatalog';
import { useModelUpdates, type ModelUpdateCatalog } from './useModelUpdates';

vi.mock('../../shared/api/transport', () => ({ invoke: vi.fn(), isNativeRuntimeAvailable: () => true }));
vi.mock('../../shared/lib/notifications', () => ({ notifyCompletion: vi.fn().mockResolvedValue(undefined) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const catalog: ModelUpdateCatalog = { directory: '/synthetic/models', paths: ['/synthetic/models/model.gguf'] };
const available: ModelUpdateStatus = {
  path: catalog.paths[0], supported: true, repository: 'example/model', current_revision: 'a'.repeat(40),
  latest_revision: 'b'.repeat(40), update_available: true, changed_files: 1, removed_files: 0,
  download_bytes: 2048, reused_bytes: 4096,
};
const committed: ModelUpdateResult = {
  path: catalog.paths[0], revision: 'b'.repeat(40), downloaded_bytes: 2048, reused_bytes: 4096, updated_files: 1, removed_files: 0,
};
const initialProps = { active: true, directory: catalog.directory, catalog: catalog as ModelUpdateCatalog | null, blocked: false };

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  cleanup();
  removeTask(MODEL_DOWNLOAD_TASK_ID);
});

describe('model update lifecycle', () => {
  it.each(['rescan', 'folder'])('discards a late lookup after a %s and hides status while inactive', async change => {
    const oldLookup = deferred<ModelUpdateStatus[]>();
    const nextLookup = deferred<ModelUpdateStatus[]>();
    vi.mocked(invoke).mockReturnValueOnce(oldLookup.promise).mockReturnValueOnce(nextLookup.promise);
    const { result, rerender } = renderHook(props => useModelUpdates(props), { initialProps });
    const replacement = change === 'folder'
      ? { directory: '/synthetic/other', paths: ['/synthetic/other/model.gguf'] }
      : { ...catalog, paths: [...catalog.paths] };
    rerender({ ...initialProps, directory: replacement.directory, catalog: replacement });
    await act(async () => oldLookup.resolve([available]));
    expect(result.current.statuses).toEqual({});
    expect(result.current.checking).toBe(true);
    await act(async () => nextLookup.resolve([{ ...available, path: replacement.paths[0], update_available: false }]));
    expect(result.current.statuses[replacement.paths[0]].update_available).toBe(false);
    rerender({ ...initialProps, directory: replacement.directory, catalog: replacement, active: false });
    expect(result.current.statuses).toEqual({});
  });

  it('refreshes lookup failures and never starts an unconfirmed or blocked update', async () => {
    vi.mocked(invoke).mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce([{ ...available, update_available: false }])
      .mockResolvedValueOnce([available]);
    const { result, rerender } = renderHook(props => useModelUpdates(props), { initialProps });
    await waitFor(() => expect(result.current.lookupError).toBe('Network unavailable'));
    await act(async () => result.current.update(catalog.paths[0]));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.statuses[catalog.paths[0]]?.update_available).toBe(false));
    await act(async () => result.current.update(catalog.paths[0]));
    act(() => result.current.refresh());
    await waitFor(() => expect(result.current.statuses[catalog.paths[0]]?.update_available).toBe(true));
    rerender({ ...initialProps, blocked: true });
    await act(async () => result.current.update(catalog.paths[0]));
    expect(vi.mocked(invoke).mock.calls.every(([command]) => command === 'hf_check_model_updates')).toBe(true);
  });

  it('uses the confirmed revision, releases local busy after task removal, and refreshes only a committed model', async () => {
    const transfer = deferred<ModelUpdateResult>();
    vi.mocked(invoke).mockResolvedValueOnce([available]).mockReturnValueOnce(transfer.promise).mockResolvedValue([available]);
    const changed = vi.fn();
    window.addEventListener(MODEL_CATALOG_CHANGED, changed);
    try {
      const { result } = renderHook(() => useModelUpdates(initialProps));
      await waitFor(() => expect(result.current.checking).toBe(false));
      let updating!: Promise<void>;
      act(() => { updating = result.current.update(catalog.paths[0]); });
      expect(result.current.busy).toBe(true);
      expect(getTaskSnapshot()[0]).toMatchObject({ id: MODEL_DOWNLOAD_TASK_ID, received: 0, total: 2048, interruptible: true });
      expect(invoke).toHaveBeenCalledWith('hf_update_model', {
        path: catalog.paths[0], modelsDir: catalog.directory, expectedRevision: 'b'.repeat(40),
      });
      act(() => removeTask(MODEL_DOWNLOAD_TASK_ID));
      expect(result.current.busy).toBe(true);
      await act(async () => { transfer.resolve(committed); await updating; });
      expect(result.current.busy).toBe(false);
      expect(changed).toHaveBeenCalledTimes(1);
      expect(getTaskSnapshot()).toEqual([]);
    } finally { window.removeEventListener(MODEL_CATALOG_CHANGED, changed); }
  });

  it.each(['inactive', 'unmount'])('invalidates a committed model after %s without finishing a newer transfer', async exit => {
    const transfer = deferred<ModelUpdateResult>();
    vi.mocked(invoke).mockResolvedValueOnce([available]).mockReturnValueOnce(transfer.promise);
    const changed = vi.fn();
    window.addEventListener(MODEL_CATALOG_CHANGED, changed);
    try {
      const { result, unmount, rerender } = renderHook(props => useModelUpdates(props), { initialProps });
      await waitFor(() => expect(result.current.checking).toBe(false));
      let updating!: Promise<void>;
      act(() => { updating = result.current.update(catalog.paths[0]); });
      const cancelNew = vi.fn();
      act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: 'New transfer', interruptible: true, cancel: cancelNew }));
      if (exit === 'unmount') unmount();
      else rerender({ ...initialProps, active: false });
      await act(async () => { transfer.resolve(committed); await updating; });
      expect(changed).toHaveBeenCalledTimes(1);
      expect(getTaskSnapshot()[0]).toMatchObject({ label: 'New transfer', state: 'running', cancel: cancelNew });
    } finally { window.removeEventListener(MODEL_CATALOG_CHANGED, changed); }
  });

  it.each([
    { cause: 'Checksum mismatch', state: 'failed', error: 'Checksum mismatch' },
    { cause: 'model download cancelled', state: 'cancelled', error: undefined },
  ])('keeps catalog state intact after $state and allows checking again', async ({ cause, state, error }) => {
    const transfer = deferred<ModelUpdateResult>();
    vi.mocked(invoke).mockResolvedValueOnce([available]).mockReturnValueOnce(transfer.promise).mockResolvedValue([available]);
    const changed = vi.fn();
    window.addEventListener(MODEL_CATALOG_CHANGED, changed);
    try {
      const { result } = renderHook(() => useModelUpdates(initialProps));
      await waitFor(() => expect(result.current.checking).toBe(false));
      let updating!: Promise<void>;
      act(() => { updating = result.current.update(catalog.paths[0]); });
      await act(async () => { transfer.reject(new Error(cause)); await updating; });
      expect(result.current.updateError).toBe(error);
      expect(result.current.busy).toBe(false);
      expect(changed).not.toHaveBeenCalled();
      expect(getTaskSnapshot()[0].state).toBe(state);
      act(() => result.current.refresh());
      expect(result.current.updateError).toBeUndefined();
      await waitFor(() => expect(result.current.checking).toBe(false));
    } finally { window.removeEventListener(MODEL_CATALOG_CHANGED, changed); }
  });

  it('retires stale update errors even when a replacement task is removed before React renders', async () => {
    const transfer = deferred<ModelUpdateResult>();
    vi.mocked(invoke).mockResolvedValueOnce([available]).mockReturnValueOnce(transfer.promise).mockResolvedValue([available]);
    const { result } = renderHook(() => useModelUpdates(initialProps));
    await waitFor(() => expect(result.current.checking).toBe(false));
    let updating!: Promise<void>;
    act(() => { updating = result.current.update(catalog.paths[0]); });
    act(() => {
      registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: 'Replacement', interruptible: true, cancel: vi.fn() });
      removeTask(MODEL_DOWNLOAD_TASK_ID);
    });
    await act(async () => { transfer.reject(new Error('Old transfer failed')); await updating; });
    expect(result.current.updateError).toBeUndefined();
    expect(result.current.busy).toBe(false);
    expect(getTaskSnapshot()).toEqual([]);
  });
});
