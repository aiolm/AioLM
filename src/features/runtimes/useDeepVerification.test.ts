import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import type { AppStore } from '../../shared/state/store';
import { getTaskSnapshot } from '../../shared/state/taskRegistry';
import * as api from '../../shared/api/index';
import { DEEP_VERIFICATION_TASK, useDeepVerification } from './useDeepVerification';

vi.mock('../../shared/api/index', () => ({
  verifyModelDeeply: vi.fn(),
  verifyCancel: vi.fn(async () => undefined),
}));
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const store = { cfg: { active_model: 'models/a.gguf' }, getConfig: () => ({ active_model: 'models/a.gguf' }) } as unknown as AppStore;
const task = () => getTaskSnapshot().find(item => item.id === DEEP_VERIFICATION_TASK);

describe('deep verification', () => {
  beforeEach(() => vi.clearAllMocks());

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
    mocked.verifyModelDeeply.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    act(() => result.current.cancel());
    expect(api.verifyCancel).toHaveBeenCalledOnce();
    expect(task()).toMatchObject({ state: 'cancelling' });
  });

  it('does not start a second run while one is in flight', () => {
    mocked.verifyModelDeeply.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useDeepVerification(store, 'en'));
    act(() => result.current.start());
    act(() => result.current.start());
    expect(api.verifyModelDeeply).toHaveBeenCalledOnce();
  });
});
