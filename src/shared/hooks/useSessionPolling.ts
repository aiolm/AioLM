import { useEffect, useRef } from 'react';
import * as api from '../api/index';
import { createSessionPoller, type SessionSubscriber } from '../state/sessionPolling';

const sessions = createSessionPoller(async details => api.normalizeSessionList(
  details ? await api.sessionList() : await api.sessionSummaryList(),
));

/** Callback changes update the next delivery without restarting polling. */
export function useSessionPolling({ active, onData, onError, intervalMs, details }: SessionSubscriber & { active: boolean }): () => Promise<void> {
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  onDataRef.current = onData;
  onErrorRef.current = onError;
  useEffect(() => {
    if (!active) return;
    return sessions.subscribe({
      onData: value => onDataRef.current(value),
      onError: error => onErrorRef.current?.(error),
      intervalMs,
      details,
    });
  }, [active, intervalMs, details]);
  return sessions.refresh;
}
