import { useEffect, useState, type RefObject } from 'react';
import * as api from '../../shared/api/index';
import { shouldConfirmDestructive } from '../../shared/config/preferences';
import { useI18n } from '../../shared/i18n/i18n';
import {
  discardPendingDownload,
  findActiveDownloadForPending,
  refreshPendingDownloads,
  resumePendingDownload,
  usePendingDownloadsStore,
} from '../../shared/state/pendingDownloadsStore';
import type { AppStore } from '../../shared/state/store';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import { isMmprojPath } from './discoverUtils';
import type { DiscoverFeedback } from './discoverControllerTypes';
import type { useDiscoverCatalog } from './useDiscoverCatalog';

export function usePendingDownloads({
  active,
  latestStore,
  setError,
  setNotice,
  recordDownloadedChoice,
  setInstalledRevision,
  t,
}: {
  active: boolean;
  latestStore: RefObject<AppStore>;
  setInstalledRevision: ReturnType<typeof useDiscoverCatalog>['setInstalledRevision'];
  t: ReturnType<typeof useI18n>['t'];
} & Pick<DiscoverFeedback, 'setError' | 'setNotice' | 'recordDownloadedChoice'>) {
  const { entries, resumingIds, discardingIds } = usePendingDownloadsStore();
  const [discarding, setDiscarding] = useState<api.PendingDownload | null>(null);

  useEffect(() => {
    if (active) void refreshPendingDownloads();
  }, [active]);

  const pending = entries.filter(
    (entry) => !resumingIds.has(entry.id) && !findActiveDownloadForPending(entry),
  );

  const resumePending = async (entry: api.PendingDownload) => {
    if (
      !['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state) ||
      latestStore.current.busy
    ) {
      setError(t('ui.stopBeforeDownload'));
      return;
    }
    setError(null);
    setNotice(null);
    const result = await resumePendingDownload(entry, {
      onSuccess: (done) => {
        invalidateModelCatalog();
        setInstalledRevision((revision) => revision + 1);
        const projector = !entry.snapshot && isMmprojPath(entry.file_path ?? '');
        if (done.path) {
          recordDownloadedChoice({
            path: done.path,
            projector,
            repo: entry.repo_id,
            destination: entry.models_dir,
            filePath: entry.file_path ?? undefined,
            selected_file: entry.snapshot ? (entry.file_path ?? undefined) : undefined,
          });
        }
      },
    });
    if (result.outcome === 'failed' && result.error) {
      setError(result.error);
    }
  };

  const discardPending = async (entry: api.PendingDownload) => {
    try {
      await discardPendingDownload(entry.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDiscarding(null);
    }
  };

  const requestDiscard = (entry: api.PendingDownload) => {
    if (shouldConfirmDestructive()) setDiscarding(entry);
    else void discardPending(entry);
  };

  const discardBusy = discarding ? discardingIds.has(discarding.id) : false;

  return {
    pending,
    resumingIds,
    discardingIds,
    discarding,
    discardBusy,
    setDiscarding,
    resumePending,
    discardPending,
    requestDiscard,
  };
}
