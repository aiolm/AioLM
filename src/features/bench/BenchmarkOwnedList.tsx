import { useCallback, useEffect, useRef, useState } from 'react';
import {
  benchmarkSharingOwnedList,
  benchmarkSharingOpenManagement,
  benchmarkSharingRecoveryCopy,
  benchmarkSharingRecoveryExport,
  benchmarkSharingRecoveryImport,
  type OwnedEntry,
} from '../../shared/api/benchmarkSharing.ts';
import { isNativeRuntimeAvailable } from '../../shared/api/transport.ts';
import { getTaskSnapshot } from '../../shared/state/taskRegistry.ts';

type Copy = ReturnType<typeof import('./benchmarkCopy.ts').benchmarkCopy>;

const measuring = () => getTaskSnapshot().some((task) => task.kind === 'benchmark' && (task.state === 'running' || task.state === 'cancelling'));

/** Show the service host rather than the raw API path. */
function displayHost(destination: string): string {
  try {
    return new URL(destination).host;
  } catch {
    return destination;
  }
}

/** Permanent ownership records, paginated from the native registry independent of queue/history. */
export function BenchmarkOwnedList({ busy, copy, revision = 0 }: { busy: boolean; copy: Copy; revision?: number }) {
  const [items, setItems] = useState<OwnedEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const initialAttempted = useRef(false);
  // A revision refresh arriving mid-load must not be lost when the in-flight
  // page is discarded by generation invalidation.
  const pendingRefresh = useRef(false);

  const loadPage = useCallback(async (after?: string): Promise<boolean> => {
    if (!isNativeRuntimeAvailable() || measuring()) return false;
    if (inFlight.current) {
      // Queue only fresh reloads; paged "load more" stays user-initiated.
      if (after === undefined) pendingRefresh.current = true;
      return false;
    }
    inFlight.current = true;
    setLoading(true);
    setError(false);
    const gen = ++generation.current;
    try {
      const page = await benchmarkSharingOwnedList(after, 25);
      if (gen !== generation.current) return false;
      setItems((previous) => {
        const merged = after ? [...previous, ...page.items] : page.items;
        return [...new Map(merged.map((entry) => [entry.submission_id, entry])).values()];
      });
      setCursor(page.next_cursor);
      setStarted(true);
      return true;
    } catch {
      if (gen === generation.current) setError(true);
      return false;
    } finally {
      inFlight.current = false;
      setLoading(false);
      if (pendingRefresh.current) {
        pendingRefresh.current = false;
        void loadPage();
      }
    }
  }, []);

  // Guarded single initial load; failures surface an explicit retry instead of looping.
  // No generation invalidation on cleanup so StrictMode setup-cleanup-setup keeps
  // the first request; late responses after a real unmount are React no-ops.
  useEffect(() => {
    if (initialAttempted.current || !isNativeRuntimeAvailable() || busy || measuring()) return;
    initialAttempted.current = true;
    void loadPage().then((applied) => { if (!applied) initialAttempted.current = false; });
  }, [loadPage, busy]);

  // Refresh after prepare/import so new bindings appear even from an empty first load.
  const lastRevision = useRef(revision);
  useEffect(() => {
    if (revision === lastRevision.current) return;
    lastRevision.current = revision;
    generation.current += 1;
    setItems([]);
    setCursor(null);
    setStarted(false);
    setError(false);
    void loadPage();
  }, [revision, loadPage]);

  const importRecovery = async () => {
    if (busy || loading) return;
    setError(false);
    try {
      const result = await benchmarkSharingRecoveryImport();
      if (!result) return;
      generation.current += 1;
      setItems([]);
      setCursor(null);
      setStarted(false);
      await loadPage();
    } catch {
      setError(true);
    }
  };

  const act = async (submissionId: string, action: 'copy' | 'export' | 'manage') => {    if (busy || working) return;
    setWorking(submissionId);
    try {
      if (action === 'copy') await benchmarkSharingRecoveryCopy(submissionId);
      else if (action === 'export') await benchmarkSharingRecoveryExport(submissionId);
      else await benchmarkSharingOpenManagement(submissionId);
      setError(false);
    } catch {
      setError(true);
    } finally {
      setWorking(null);
    }
  };

  if (!isNativeRuntimeAvailable()) return null;
  if (!started && !loading && !error) return null;
  return (
    <section className="performance-card performance-details" aria-label={copy.ownedListTitle}>
      <h4>{copy.ownedListTitle}</h4>
      <p>{copy.ownedListHint}</p>
      <div className="performance-actions">
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || loading} onClick={() => void importRecovery()}>{copy.recoveryImport}</button>
      </div>
      {items.length > 0 && (
        <ul className="performance-queue-list">
          {items.map((entry) => (
            <li key={entry.submission_id}>
              <span>
                {entry.submission_id.slice(0, 8)} · {displayHost(entry.destination)} · {new Date(entry.created_at_ms).toLocaleString()}
              </span>
              <span className="performance-owned-actions">
                <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null} onClick={() => void act(entry.submission_id, 'copy')}>{copy.recoveryCopy}</button>
                <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null} onClick={() => void act(entry.submission_id, 'export')}>{copy.recoveryExport}</button>
                <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null} onClick={() => void act(entry.submission_id, 'manage')}>{copy.openManagement}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {started && items.length === 0 && !loading && <p role="status">{copy.ownedListEmpty}</p>}
      {cursor && (
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || loading} onClick={() => void loadPage(cursor)}>
          {copy.ownedListLoadMore}
        </button>
      )}
      {loading && <p role="status">{copy.historyLoading}</p>}
      {error && (
        <p role="alert">
          {copy.recoveryError}{' '}
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || loading} onClick={() => void loadPage()}>
            {copy.queueRetry}
          </button>
        </p>
      )}
    </section>
  );
}
