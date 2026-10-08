import { useSyncExternalStore } from 'react';
import { notifySessionStatusChanged } from '../runtime/sessionEvents.ts';

const pending = new Set<symbol>();
const listeners = new Set<() => void>();
const inProgress = () => pending.size > 0;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Pending lifecycle commands hold runtime resources before status polling catches up.
 * This is command activity only; the backend remains the source of readiness. */
export async function withSessionTransition<T>(operation: () => Promise<T>): Promise<T> {
  const token = Symbol();
  const wasBusy = inProgress();
  pending.add(token);
  if (!wasBusy) for (const listener of listeners) listener();
  notifySessionStatusChanged();
  try {
    return await operation();
  } finally {
    pending.delete(token);
    if (!inProgress()) for (const listener of listeners) listener();
    notifySessionStatusChanged();
  }
}

export function useSessionTransitionInProgress(): boolean {
  return useSyncExternalStore(subscribe, inProgress, () => false);
}
