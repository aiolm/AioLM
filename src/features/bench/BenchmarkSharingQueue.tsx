import { useEffect, useState } from 'react';
import { listQueuedBenchmarks, removeQueuedBenchmark } from '../../shared/sharing/benchmarkOutbox';
import type { benchmarkCopy } from './benchmarkCopy';

type Entries = Awaited<ReturnType<typeof listQueuedBenchmarks>>;
type Copy = ReturnType<typeof benchmarkCopy>;

export function BenchmarkSharingQueue({ active, busy, revision, copy }: { active: boolean; busy: boolean; revision: number; copy: Copy }) {
  const [entries, setEntries] = useState<Entries>([]);
  const [error, setError] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [cursor, setCursor] = useState<[number, string] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active || busy) return;
    let current = true;
    void listQueuedBenchmarks({ limit: 100 }).then(value => { if (current) {
      setEntries(value); setError(false);
      const last = value[value.length - 1];
      setCursor(value.length === 100 && last ? [last.createdAt, last.id] : null);
    } })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [active, busy, revision]);
  const loadMore = async () => {
    if (!cursor || busy || loading) return;
    setLoading(true);
    try {
      const page = await listQueuedBenchmarks({ limit: 100, after: cursor });
      setEntries(previous => [...new Map([...previous, ...page].map(entry => [entry.id, entry])).values()]);
      const last = page[page.length - 1];
      setCursor(page.length === 100 && last ? [last.createdAt, last.id] : null); setError(false);
    } catch { setError(true); }
    finally { setLoading(false); }
  };
  const remove = async (id: string) => {
    if (busy || removing) return;
    setRemoving(id);
    try { await removeQueuedBenchmark(id); setEntries(previous => previous.filter(entry => entry.id !== id)); setError(false); }
    catch { setError(true); }
    finally { setRemoving(null); }
  };
  if (!entries.length && !cursor) return error ? <p className="performance-notice" role="status">{copy.queueReadError}</p> : null;
  return <details className="performance-card performance-details">
    <summary>{copy.sharingQueue} · {entries.length}{cursor ? '+' : ''}</summary><p>{copy.queueHint}</p><p>{copy.queueRemoveHint}</p>
    <ul className="performance-queue-list">{entries.map(entry => <li key={entry.id}>
      <span>{entry.payload.model.sha256?.slice(0, 12) ?? copy.identityUnknown} · {entry.payload.measurements.rows.length} {copy.totalTests} · {entry.state === 'sent' ? entry.source && entry.localAcknowledgedAt === undefined ? copy.queueLocalMaintenance : copy.queueSent : entry.state === 'rejected' ? copy.queueRejected : copy.queuePending}</span>
      <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || removing !== null || (entry.state === 'sending' && (entry.leaseUntil ?? 0) > Date.now())} onClick={() => void remove(entry.id)}>{copy.removeQueued}</button>
    </li>)}</ul>
    {cursor && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || loading} onClick={() => void loadMore()}>{copy.loadMore}</button>}
    {error && <p role="alert">{copy.queueReadError}</p>}
  </details>;
}
