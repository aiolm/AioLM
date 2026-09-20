import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SessionStatus } from '../api/types';
import { SESSION_STATUS_CHANGED_EVENT } from '../runtime/sessionUtils';
import { createSessionPoller } from './sessionPolling';

const status: SessionStatus[] = [{ id: 'test', name: 'Test session', state: 'running' }];
const unsubscribers: (() => void)[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
  for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('shares one request and timer, including concurrent explicit refreshes', async () => {
  let resolve: (value: SessionStatus[]) => void = () => undefined;
  const load = vi.fn(() => new Promise<SessionStatus[]>(done => { resolve = done; }));
  const poller = createSessionPoller(load);
  const first = vi.fn(); const second = vi.fn();
  unsubscribers.push(poller.subscribe({ onData: first }), poller.subscribe({ onData: second }));
  const pending = poller.refresh();
  expect(poller.refresh()).toBe(pending);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(load).toHaveBeenCalledOnce();
  resolve(status);
  await pending;
  expect(first).toHaveBeenCalledWith(status);
  expect(second).toHaveBeenCalledWith(status);
  await vi.advanceTimersByTimeAsync(3000);
  expect(load).toHaveBeenCalledTimes(2);
  unsubscribers.splice(0).forEach(unsubscribe => unsubscribe());
  resolve(status);
  await poller.refresh();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledTimes(2);
});

it('pauses hidden windows and coalesces status changes during a pending request', async () => {
  const load = vi.fn(async () => status);
  const poller = createSessionPoller(load);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  unsubscribers.push(poller.subscribe({ onData: vi.fn() }));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  await poller.refresh();
  expect(load).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(load).toHaveBeenCalledOnce();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange'));
  window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
  window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
  await vi.advanceTimersByTimeAsync(0);
  expect(load).toHaveBeenCalledTimes(3);
});

it('loads diagnostics only while a detail consumer is subscribed', async () => {
  const load = vi.fn(async () => status);
  const poller = createSessionPoller(load);
  unsubscribers.push(poller.subscribe({ onData: vi.fn() }));
  await poller.refresh();
  expect(load).toHaveBeenLastCalledWith(false);
  const detail = vi.fn();
  const unsubscribe = poller.subscribe({ onData: detail, details: true, intervalMs: 1500 });
  expect(detail).not.toHaveBeenCalled();
  await poller.refresh();
  expect(load).toHaveBeenLastCalledWith(true);
  expect(detail).toHaveBeenCalledWith(status);
  unsubscribe();
  await vi.advanceTimersByTimeAsync(3000);
  expect(load).toHaveBeenLastCalledWith(false);
});

it('does not deliver an old request into a new subscription lifetime', async () => {
  let resolve: (value: SessionStatus[]) => void = () => undefined;
  const load = vi.fn(() => new Promise<SessionStatus[]>(done => { resolve = done; }));
  const poller = createSessionPoller(load);
  const unsubscribe = poller.subscribe({ onData: vi.fn() });
  const old = poller.refresh();
  await Promise.resolve();
  unsubscribe();
  const current = vi.fn();
  unsubscribers.push(poller.subscribe({ onData: current }));
  resolve(status);
  await old;
  expect(current).not.toHaveBeenCalled();
  await Promise.resolve();
  resolve([]);
  await poller.refresh();
  expect(current).toHaveBeenCalledWith([]);
});

it('delivers failures and resumes polling on the next interval', async () => {
  const error = new Error('Session status unavailable');
  const load = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(status);
  const onError = vi.fn(); const onData = vi.fn();
  const poller = createSessionPoller(load);
  unsubscribers.push(poller.subscribe({ onError, onData }));
  await poller.refresh();
  expect(onError).toHaveBeenCalledWith(error);
  await vi.advanceTimersByTimeAsync(3000);
  expect(onData).toHaveBeenCalledWith(status);
});
