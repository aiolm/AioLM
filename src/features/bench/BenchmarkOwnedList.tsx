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
import FeedbackBanner from '../../shared/ui/FeedbackBanner.tsx';
import { benchmarkManagementError } from './benchmarkManagementError';

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

function itemLabel(template: string, createdAtMs: number): string {
  return template.replace('{date}', new Date(createdAtMs).toLocaleString());
}

/** Stored management access, including prepared bindings and restored backups. */
export function BenchmarkOwnedList({ busy, copy, revision = 0 }: { busy: boolean; copy: Copy; revision?: number }) {
  const [items, setItems] = useState<OwnedEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [started, setStarted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [expanded, setExpanded] = useState(true);
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

  // Refresh after publish/import so new bindings appear even from an empty first load.
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
    if (busy || importing || loading || working) return;
    setImporting(true);
    setActionError(null);
    setNotice(null);
    try {
      const result = await benchmarkSharingRecoveryImport();
      if (!result) return;
      setNotice(copy.recoveryImported);
      generation.current += 1;
      setItems([]);
      setCursor(null);
      setStarted(false);
      await loadPage();
    } catch {
      setActionError(copy.ownedActionError);
    } finally {
      setImporting(false);
    }
  };

  const backup = async (submissionId: string, action: 'copy' | 'export') => {
    if (busy || working || importing) return;
    setWorking(submissionId);
    setActionError(null);
    setNotice(null);
    try {
      if (action === 'copy') {
        if (await benchmarkSharingRecoveryCopy(submissionId)) setNotice(copy.recoveryCopied);
      } else {
        if (await benchmarkSharingRecoveryExport(submissionId)) setNotice(copy.recoverySaved);
      }
    } catch {
      setActionError(copy.ownedActionError);
    } finally {
      setWorking(null);
    }
  };

  const manage = async (submissionId: string) => {
    if (busy || working || importing) return;
    setWorking(submissionId);
    setOpening(submissionId);
    setActionError(null);
    try {
      await benchmarkSharingOpenManagement(submissionId);
    } catch (error) {
      setActionError(benchmarkManagementError(error, copy));
    } finally {
      setWorking(null);
      setOpening(null);
    }
  };

  if (!isNativeRuntimeAvailable()) return null;
  if (!started && !loading && !error) return null;
  return (
    <details className="app-card app-card--flush performance-card performance-details" open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
      <summary>{copy.ownedListTitle}{items.length > 0 ? ` · ${items.length}${cursor ? '+' : ''}` : ''}</summary>
      <p>{copy.ownedListHint}</p>
      {items.length > 0 && (
        <ul className="performance-owned-list">
          {items.map((entry) => (
            <li key={entry.submission_id}>
              <span>
                {itemLabel(copy.ownedItemTitle, entry.created_at_ms)} · {displayHost(entry.destination)}
              </span>
              <span className="performance-owned-actions">
                <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null || importing} data-icon="open" onClick={() => void manage(entry.submission_id)}>{opening === entry.submission_id ? copy.managementOpening : copy.openManagement}</button>
              </span>
            </li>
          ))}
        </ul>
      )}
      {started && items.length === 0 && !loading && <p role="status">{copy.ownedListEmpty}</p>}
      {cursor && (
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || loading} data-icon="refresh" onClick={() => void loadPage(cursor)}>
          {copy.ownedListLoadMore}
        </button>
      )}
      {loading && <p role="status">{copy.historyLoading}</p>}
      {error && (
        <FeedbackBanner tone="error" className="performance-notice" action={{ label: copy.retry, disabled: busy || loading, onClick: () => void loadPage() }}>
          {copy.ownedListError}
        </FeedbackBanner>
      )}
      {actionError && <FeedbackBanner tone="error" className="performance-notice">{actionError}</FeedbackBanner>}
      {notice && <FeedbackBanner tone="success" className="performance-notice">{notice}</FeedbackBanner>}
      <details className="performance-backup" open>
        <summary>{copy.backupTitle}</summary>
        <p>{copy.backupHint}</p>
        <div className="performance-actions">
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || importing || loading || working !== null} data-icon="upload" onClick={() => void importRecovery()}>{copy.recoveryImport}</button>
        </div>
        {items.length > 0 && (
          <ul className="performance-owned-list">
            {items.map((entry) => (
              <li key={entry.submission_id}>
                <span>{itemLabel(copy.ownedItemTitle, entry.created_at_ms)}</span>
                <span className="performance-owned-actions">
                  <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null || importing} data-icon="download" onClick={() => void backup(entry.submission_id, 'export')}>{copy.recoveryExport}</button>
                  <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || working !== null || importing} data-icon="copy" onClick={() => void backup(entry.submission_id, 'copy')}>{copy.recoveryCopy}</button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </details>
    </details>
  );
}
