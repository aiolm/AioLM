import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import * as api from '../api/index';
import { useSessionPolling } from './useSessionPolling';

vi.mock('../api/index', () => ({
  sessionList: vi.fn(async () => []),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => value,
}));
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('keeps polling stable when fallback callbacks change and stops when inactive', async () => {
  vi.useFakeTimers();
  const received: number[] = [];
  const { rerender, unmount } = renderHook(({ active, revision }) => useSessionPolling({
    active, onData: () => { received.push(revision); },
  }), { initialProps: { active: true, revision: 1 } });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(api.sessionSummaryList).toHaveBeenCalledOnce();
  rerender({ active: true, revision: 2 });
  expect(api.sessionSummaryList).toHaveBeenCalledOnce();
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(received).toEqual([1, 2]);
  rerender({ active: false, revision: 3 });
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(api.sessionSummaryList).toHaveBeenCalledTimes(2);
  unmount();
});
