import { useEffect, useRef } from 'react';
import * as api from '../api/index';
import { createSessionPoller, type SessionSubscriber } from '../state/sessionPolling';
import { trackInitialRead } from '../ui/initialLayout';

const sessions = createSessionPoller(async details => api.normalizeSessionList(
  details ? await api.sessionList('refresh') : await api.sessionSummaryList(),
));

/** Callback changes update the next delivery without restarting polling. */
export function useSessionPolling({ active, onData, onError, intervalMs, details }: SessionSubscriber & { active: boolean }): () => Promise<void> {
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onErrorRef.current = onError;
  useEffect(() => {
    if (!active) return;
    // A new detail consumer awaits its own first result, even during a shared refresh.
    let completeInitial = () => {};
    if (details) {
      const initial = new Promise<void>(resolve => { completeInitial = resolve; });
      void trackInitialRead(() => initial);
    }
    const unsubscribe = sessions.subscribe({
      onData: value => { try { onDataRef.current(value); } finally { completeInitial(); } },
      onError: error => { try { onErrorRef.current?.(error); } finally { completeInitial(); } },
      intervalMs,
      details,
    });
    return () => { unsubscribe(); completeInitial(); };
  }, [active, intervalMs, details]);
  return sessions.refresh;
}
