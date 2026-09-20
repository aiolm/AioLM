import type { SessionStatus } from '../api/types';
import { SESSION_STATUS_CHANGED_EVENT } from '../runtime/sessionUtils';

export interface SessionSubscriber {
  onData: (sessions: SessionStatus[]) => void;
  onError?: (error: unknown) => void;
  intervalMs?: number;
  details?: boolean;
}

/** One in-flight IPC request and timer serve every visible session consumer. */
export function createSessionPoller(load: (details: boolean) => Promise<SessionStatus[]>) {
  const subscribers = new Set<SessionSubscriber>();
  let pending: Promise<void> | undefined;
  let pendingHasDetails = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: SessionStatus[] | undefined;
  let snapshotHasDetails = false;
  let generation = 0;
  let invalidated = false;
  const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const enabled = () => subscribers.size > 0 && visible();
  const clearTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (!enabled() || pending) return;
    const interval = Math.min(...Array.from(subscribers, item => Math.max(250, item.intervalMs ?? 3000)));
    timer = setTimeout(() => { timer = undefined; void refresh(); }, interval);
  };
  const refresh = (): Promise<void> => {
    if (pending) return pending;
    clearTimer();
    invalidated = false;
    const requestedGeneration = generation;
    const requestedDetails = Array.from(subscribers).some(item => item.details);
    pendingHasDetails = requestedDetails;
    pending = Promise.resolve().then(() => load(requestedDetails)).then(sessions => {
      if (requestedGeneration !== generation) return;
      snapshot = sessions;
      snapshotHasDetails = requestedDetails;
      for (const subscriber of subscribers) {
        if (!subscriber.details || requestedDetails) subscriber.onData(sessions);
      }
    }, error => {
      if (requestedGeneration !== generation) return;
      for (const subscriber of subscribers) subscriber.onError?.(error);
    }).finally(() => {
      pending = undefined;
      pendingHasDetails = false;
      if ((invalidated || requestedGeneration !== generation) && enabled()) void refresh();
      else schedule();
    });
    return pending;
  };
  const invalidate = () => {
    invalidated = true;
    if (enabled()) void refresh();
  };
  const onVisibility = () => {
    if (visible()) invalidate();
    else clearTimer();
  };
  return {
    refresh,
    subscribe(subscriber: SessionSubscriber): () => void {
      subscribers.add(subscriber);
      if (subscribers.size === 1) {
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener(SESSION_STATUS_CHANGED_EVENT, invalidate);
      }
      if (snapshot && (!subscriber.details || snapshotHasDetails)) subscriber.onData(snapshot);
      if (enabled()) {
        if (subscriber.details && !snapshotHasDetails && !pendingHasDetails) invalidate();
        else if (!snapshot) void refresh();
        else schedule();
      }
      return () => {
        subscribers.delete(subscriber);
        if (subscribers.size) { schedule(); return; }
        clearTimer();
        snapshot = undefined;
        snapshotHasDetails = false;
        generation += 1;
        document.removeEventListener('visibilitychange', onVisibility);
        window.removeEventListener(SESSION_STATUS_CHANGED_EVENT, invalidate);
      };
    },
  };
}
