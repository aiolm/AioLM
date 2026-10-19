import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { AppStore } from '../../shared/state/store';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import * as api from '../../shared/api/index';
import { DEEP_VERIFICATION_TASK, useDeepVerification } from './useDeepVerification';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';

vi.mock('../../shared/api/index', () => ({
  verifyModelDeeply: vi.fn(),
  verifyCancel: vi.fn(async () => undefined),
}));
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const store = { cfg: { active_model: 'models/a.gguf' }, getConfig: () => ({ active_model: 'models/a.gguf' }) } as unknown as AppStore;
const task = () => getTaskSnapshot().find(item => item.id === DEEP_VERIFICATION_TASK);

describe('deep verification', () => {
  beforeEach(() => {
    removeTask(DEEP_VERIFICATION_TASK);
    vi.clearAllMocks();
  });

  it('reports its run through the task strip so the panel can be left', async () => {
    // It reads the model twice and can take the better part of an hour; a button
    // that simply appears to hang for that long is not something to ship.
    let settle: (value: unknown) => void = () => {};
    mocked.verifyModelDeeply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    expect(task()).toMatchObject({ state: 'running', kind: 'runtime', interruptible: true });

    await act(async () => { settle({ verdict: 'pass', detail: 'median KLD 0.0019', suite_version: 1, recorded_at: '' }); });
    expect(task()).toMatchObject({ state: 'completed' });
    expect(result.current.record?.verdict).toBe('pass');
  });

  it('marks a diverging verdict as a failure rather than a completed run', async () => {
    mocked.verifyModelDeeply.mockResolvedValue({ verdict: 'fail', detail: 'median KLD 1.48', suite_version: 1, recorded_at: '' });
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    await act(async () => { result.current.start(); });
    expect(task()).toMatchObject({ state: 'failed' });
  });

  it('asks the run to stop and shows it as cancelling until it does', async () => {
    let rejectRun!: (cause: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValue(new Promise((_resolve, reject) => { rejectRun = reject; }));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    expect(task()?.cancel).toBeTypeOf('function');
    act(() => result.current.cancel());
    expect(api.verifyCancel).toHaveBeenCalledOnce();
    expect(task()).toMatchObject({ state: 'cancelling' });
    await act(async () => { rejectRun(new Error('deep verification cancelled')); });
  });

  it('restores the running task and surfaces the error when cancellation fails so it can be retried from the task strip', async () => {
    let failVerify!: (reason: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValue(new Promise((_resolve, reject) => { failVerify = reject; }));
    mocked.verifyCancel.mockRejectedValueOnce(new Error('synthetic verify cancel IPC error'));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    await act(async () => { await task()?.cancel?.(); });
    expect(task()).toMatchObject({ state: 'running', detail: 'synthetic verify cancel IPC error' });
    expect(result.current.error).toBe('synthetic verify cancel IPC error');
    expect(result.current.busy).toBe(true);

    mocked.verifyCancel.mockResolvedValueOnce(undefined);
    await act(async () => { await task()?.cancel?.(); });
    expect(api.verifyCancel).toHaveBeenCalledTimes(2);
    expect(task()).toMatchObject({ state: 'cancelling' });
    await act(async () => { failVerify(new Error('deep verification cancelled')); });
    expect(task()).toMatchObject({ state: 'cancelled' });
    expect(result.current.error).toBeNull();
    expect(result.current.busy).toBe(false);
  });

  it('ignores a retained cancellation callback or late cancellation rejection from an earlier run', async () => {
    let failFirst!: (reason: unknown) => void;
    let finishSecond!: (value: unknown) => void;
    let failCancel!: (reason: unknown) => void;
    mocked.verifyModelDeeply
      .mockReturnValueOnce(new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { finishSecond = resolve; }));
    mocked.verifyCancel.mockReturnValueOnce(new Promise((_resolve, reject) => { failCancel = reject; }));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    const firstCancel = task()?.cancel;
    act(() => { void firstCancel?.(); });
    await act(async () => { failFirst(new Error('deep verification cancelled')); });
    expect(result.current.busy).toBe(false);

    act(() => result.current.start());
    await act(async () => { failCancel(new Error('late cancel IPC error')); });
    await act(async () => { await firstCancel?.(); });
    expect(api.verifyCancel).toHaveBeenCalledOnce();
    expect(task()).toMatchObject({ state: 'running', detail: 'Comparing this GPU selection against the host' });
    expect(result.current.error).toBeNull();
    await act(async () => { finishSecond({ verdict: 'pass', detail: 'second pass', suite_version: 1, recorded_at: '' }); });
    expect(task()).toMatchObject({ state: 'completed' });
  });

  it('does not start a second run while one is in flight', async () => {
    let rejectRun!: (cause: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValue(new Promise((_resolve, reject) => { rejectRun = reject; }));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    act(() => result.current.start());
    expect(api.verifyModelDeeply).toHaveBeenCalledOnce();
    await act(async () => { rejectRun(new Error('deep verification cancelled')); });
  });

  it('does not attach a late result to a changed runtime or re-registered build', async () => {
    let settle: (value: unknown) => void = () => {};
    mocked.verifyModelDeeply.mockReturnValue(new Promise(resolve => { settle = resolve; }));
    const holder = { cfg: { active_model: 'models/a.gguf', active_runtime: 'original' } };
    const selected = { getConfig: () => holder.cfg } as unknown as AppStore;
    const { result, rerender } = renderHook(() => useDeepVerification(selected, 'en'));
    act(() => result.current.start());
    holder.cfg = { ...holder.cfg, active_runtime: 'replacement' };
    rerender();
    await act(async () => settle({ verdict: 'pass', detail: 'original runtime only', suite_version: 1, recorded_at: '' }));
    expect(result.current.record).toBeNull();
    expect(task()).toMatchObject({ state: 'completed', detail: 'original runtime only' });

    mocked.verifyModelDeeply.mockResolvedValue({ verdict: 'pass', detail: 'replacement runtime', suite_version: 1, recorded_at: '' });
    await act(async () => result.current.start());
    expect(result.current.record?.detail).toBe('replacement runtime');
    act(() => notifyRuntimeInventoryChanged());
    expect(result.current.record).toBeNull();
  });

  it('records genuine errors mentioning cancel or unrelated cancellation sentinels as failures rather than cancellations', async () => {
    mocked.verifyModelDeeply.mockRejectedValueOnce(new Error('runtime probe cancelled'));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    await act(async () => { result.current.start(); });
    expect(task()).toMatchObject({ state: 'failed', detail: 'runtime probe cancelled' });
    expect(result.current.error).toBe('runtime probe cancelled');

    let rejectSecond!: (reason: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSecond = reject; }));
    act(() => result.current.start());
    act(() => result.current.cancel());
    await act(async () => { rejectSecond(new Error('GPU device lost while cancelling context')); });
    expect(task()).toMatchObject({ state: 'failed', detail: 'GPU device lost while cancelling context' });
    expect(result.current.error).toBe('GPU device lost while cancelling context');
  });

  it('shares active verification ownership across mounted Runtimes panels and remounts', async () => {
    let settle!: (value: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    const firstPanel = renderHook(() => useDeepVerification(store, 'en'));
    const secondPanel = renderHook(() => useDeepVerification(store, 'en'));

    act(() => firstPanel.result.current.start());
    expect(firstPanel.result.current.busy).toBe(true);
    expect(secondPanel.result.current.busy).toBe(true);

    // Starting from the second mounted panel must not overwrite the in-flight run.
    act(() => secondPanel.result.current.start());
    expect(api.verifyModelDeeply).toHaveBeenCalledOnce();

    // Unmounting the originating panel must leave the shared run controllable and observable.
    firstPanel.unmount();
    expect(secondPanel.result.current.busy).toBe(true);
    act(() => secondPanel.result.current.cancel());
    expect(api.verifyCancel).toHaveBeenCalledOnce();
    expect(task()).toMatchObject({ state: 'cancelling' });

    await act(async () => {
      settle({ verdict: 'pass', detail: 'shared across panels', suite_version: 1, recorded_at: '' });
    });
    expect(secondPanel.result.current.busy).toBe(false);
    expect(secondPanel.result.current.record?.detail).toBe('shared across panels');
  });

  it('keeps ownership until the native request settles even if its task row disappears', async () => {
    let settle!: (value: unknown) => void;
    mocked.verifyModelDeeply.mockReturnValueOnce(new Promise(resolve => { settle = resolve; }));
    const first = renderHook(() => useDeepVerification(store, 'en'));
    act(() => first.result.current.start());
    act(() => removeTask(DEEP_VERIFICATION_TASK));
    const second = renderHook(() => useDeepVerification(store, 'en'));
    try {
      expect(second.result.current.busy).toBe(true);
      act(() => second.result.current.start());
      expect(api.verifyModelDeeply).toHaveBeenCalledOnce();
      act(() => second.result.current.cancel());
      expect(api.verifyCancel).toHaveBeenCalledOnce();
    } finally {
      await act(async () => { settle({ verdict: 'pass', detail: 'retained owner', suite_version: 1, recorded_at: '' }); });
    }
    expect(first.result.current.busy).toBe(false);
    expect(second.result.current.busy).toBe(false);
    expect(first.result.current.record?.detail).toBe('retained owner');
    expect(second.result.current.record?.detail).toBe('retained owner');
  });
});
