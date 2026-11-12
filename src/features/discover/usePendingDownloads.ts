import { useCallback, useEffect, useState, type RefObject } from 'react';
import * as api from '../../shared/api/index';
import { isIpcErrorKind } from '../../shared/api/ipcError';
import type { AppStore } from '../../shared/state/store';
import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';
import { registerTask } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import { shouldConfirmDestructive } from '../../shared/config/preferences';
import type { DiscoverFeedback } from './discoverControllerTypes';
import type { useDiscoverCatalog } from './useDiscoverCatalog';
import { finishTransferTask, transferActive } from './discoverTransferTasks';

export function usePendingDownloads({ active, downloadBusy: transferring, latestStore, setError, setNotice, setInstalledRevision, t }: {
  active: boolean; downloadBusy: boolean; latestStore: RefObject<AppStore>;
  setInstalledRevision: ReturnType<typeof useDiscoverCatalog>['setInstalledRevision'];
  t: ReturnType<typeof useI18n>['t'];
} & Pick<DiscoverFeedback, 'setError' | 'setNotice'>) {
  // Interrupted downloads that can continue with one click. Read when the
  // panel opens and whenever a download stops, so a pause shows up at once.
  const [pending, setPending] = useState<api.PendingDownload[]>([]);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<api.PendingDownload | null>(null);
  const [discardBusy, setDiscardBusy] = useState(false);
  const downloadBusy = transferring || resumingId !== null;
  const refreshPending = useCallback(async () => {
    try { setPending(await api.hfPendingDownloads()); } catch { /* Browser preview and read failures leave the list empty. */ }
  }, []);
  useEffect(() => {
    if (active && !downloadBusy) void refreshPending();
  }, [active, downloadBusy, refreshPending]);

  // Starts the same download again with what was recorded for it; the backend
  // continues each file from the bytes it kept.
  const resumePending = async (entry: api.PendingDownload) => {
    if (transferActive()) return;
    if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state) || latestStore.current.busy) {
      setError(t('ui.stopBeforeDownload')); return;
    }
    const cancelDownload = () => api.hfCancelDownload();
    registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: entry.label, phase: 'starting',
      received: entry.received, total: entry.total, interruptible: true, pausable: true, cancel: cancelDownload });
    setResumingId(entry.id); setError(null); setNotice(null);
    try {
      if (entry.snapshot) await api.hfDownloadSnapshot(entry.repo_id, entry.models_dir, entry.file_path ?? undefined, entry.revision ?? '');
      else await api.hfDownloadModel(entry.repo_id, entry.file_path ?? '', entry.models_dir, entry.include_companions ? true : undefined, entry.revision ?? '');
      finishTransferTask(cancelDownload, 'completed');
      invalidateModelCatalog();
      setInstalledRevision(revision => revision + 1);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = isIpcErrorKind(cause, 'cancelled');
      finishTransferTask(cancelDownload, cancelled ? 'cancelled' : 'failed', message);
      if (!cancelled) setError(message);
    } finally {
      setResumingId(null);
    }
  };

  const discardPending = async (entry: api.PendingDownload) => {
    setDiscardBusy(true);
    try {
      await api.hfDiscardDownload(entry.id);
      await refreshPending();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscardBusy(false); setDiscarding(null);
    }
  };

  const requestDiscard = (entry: api.PendingDownload) => {
    if (shouldConfirmDestructive()) setDiscarding(entry); else void discardPending(entry);
  };
  return { downloadBusy, pending, resumingId, discarding, discardBusy, setDiscarding, resumePending, discardPending, requestDiscard };
}
