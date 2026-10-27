import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { AppConfig } from './types';
import { sessionStart, sessionStop, sessionUnload } from './commands';
import { invoke } from './transport.ts';
import { useSessionTransitionInProgress, withSessionTransition } from '../state/sessionTransitions';
import { SESSION_STATUS_CHANGED_EVENT } from '../runtime/sessionUtils';

vi.mock('./transport.ts', () => ({ invoke: vi.fn(), isNativeRuntimeAvailable: () => true, NATIVE_RUNTIME_ERROR: 'Unavailable' }));
afterEach(() => { vi.clearAllMocks(); });

it.each(['start', 'stop', 'unload'] as const)('holds the runtime lock while session %s awaits IPC and preserves its arguments and result', async action => {
  const { result } = renderHook(useSessionTransitionInProgress);
  let resolve!: (value: unknown) => void;
  vi.mocked(invoke).mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const cfg = { active_model: 'synthetic.gguf' } as AppConfig;
  const ready = { id: 'synthetic-session', name: 'Synthetic session', state: 'running' };
  let operation!: Promise<unknown>;
  act(() => {
    operation = action === 'start' ? sessionStart('synthetic-session', cfg, false)
      : action === 'stop' ? sessionStop('synthetic-session') : sessionUnload('synthetic-session');
  });
  expect(result.current).toBe(true);
  expect(invoke).toHaveBeenCalledExactlyOnceWith(`session_${action}`, action === 'start'
    ? { sessionId: 'synthetic-session', cfg, stopExisting: false } : { sessionId: 'synthetic-session' });
  await act(async () => { resolve(action === 'start' ? ready : undefined); expect(await operation).toEqual(action === 'start' ? ready : undefined); });
  expect(result.current).toBe(false);
});

it('keeps the lock when cancellation finishes before the overlapping load settles and propagates the load failure', async () => {
  const { result } = renderHook(useSessionTransitionInProgress);
  let reject!: (reason: Error) => void;
  let resolveStop!: () => void;
  const failure = new Error('Synthetic load cancelled.');
  vi.mocked(invoke).mockImplementationOnce(() => new Promise((_done, fail) => { reject = fail; }))
    .mockImplementationOnce(() => new Promise<void>(done => { resolveStop = done; }));
  let start!: Promise<unknown>; let stop!: Promise<void>;
  act(() => { start = sessionStart('synthetic-session', {} as AppConfig); stop = sessionStop('synthetic-session'); });
  await act(async () => { resolveStop(); await stop; });
  expect(result.current).toBe(true);
  await act(async () => { reject(failure); await expect(start).rejects.toBe(failure); });
  expect(result.current).toBe(false);
});

it('releases failed synchronous commands and requests fresh native status without manufacturing readiness', async () => {
  const { result } = renderHook(useSessionTransitionInProgress);
  const changed = vi.fn();
  window.addEventListener(SESSION_STATUS_CHANGED_EVENT, changed);
  const failure = new Error('Synthetic IPC unavailable.');
  try {
    await act(async () => { await expect(withSessionTransition(() => { throw failure; })).rejects.toBe(failure); });
    expect(result.current).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed.mock.calls.every(([event]) => event.type === SESSION_STATUS_CHANGED_EVENT && !('detail' in event))).toBe(true);
  } finally {
    window.removeEventListener(SESSION_STATUS_CHANGED_EVENT, changed);
  }
});
