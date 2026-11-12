import { useCallback, useRef, useState, type MouseEvent } from 'react';
import * as api from '../../shared/api/index';
import { useI18n } from '../../shared/i18n/i18n';
import { modelActions } from '../../shared/i18n/modelActions';
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from '../models/modelExecutionState';
import { estimateRemainingSeconds } from '../../shared/lib/transfer';
import type { DiscoverProps, DownloadedChoice, DownloadNotice } from './discoverControllerTypes';
import { useDiscoverCatalog } from './useDiscoverCatalog';
import { useDiscoverTransfers } from './useDiscoverTransfers';
import { usePendingDownloads } from './usePendingDownloads';

/** Composes catalog, transfer and dialog handoff without assigning an artifact an engine. */
export function useDiscoverController({ store, active = true, onSelectModel, onOpenModels }: DiscoverProps) {
  const { t, locale } = useI18n();
  const [includeCompanions, setIncludeCompanions] = useState(false);
  const modelSettings = useModelSettings();
  const modelCopy = modelActions(locale);
  // A completed transfer names only its artifact, not an execution setup.
  const [downloadedChoice, setDownloadedChoice] = useState<DownloadedChoice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<DownloadNotice | null>(null);
  const guard = useDraftGuard();
  const latestStore = useRef(store); latestStore.current = store;
  const modelsDir = store.cfg?.models_dir ?? '';
  const resetFeedback = useCallback(() => { setError(null); setNotice(null); setDownloadedChoice(null); }, []);
  const catalog = useDiscoverCatalog({ active, modelsDir, resetFeedback, setIncludeCompanions, setError });
  const transfers = useDiscoverTransfers({ store, latestStore, catalog, includeCompanions, modelSettings, guard, t,
    setError, setNotice, setDownloadedChoice, onSelectModel, onOpenModels });
  const { downloading, downloadTask, progress, speedBps } = transfers;
  const transferring = !!downloading || downloadTask?.state === 'running' || downloadTask?.state === 'cancelling';
  const pendingDownloads = usePendingDownloads({ active, downloadBusy: transferring, latestStore, setError, setNotice,
    setInstalledRevision: catalog.setInstalledRevision, t });
  const { selected } = catalog;
  const currentDownloadedChoice = downloadedChoice?.repo === selected?.id && downloadedChoice?.destination === modelsDir ? downloadedChoice : null;

  // Configuration starts from the engine and runtime that are configured right
  // now; the model settings editor then reports compatibility and owns any
  // engine change. Discover never picks an engine for the artifact.
  const configureDownloaded = (choice: { path: string; projector: boolean }) => {
    const cfg = latestStore.current.getConfig();
    if (!cfg) return;
    try {
      const config = choice.projector ? { ...cfg, mmproj: choice.path }
        : { ...cfg, ...previewExecution(cfg, choice.path), active_model: choice.path };
      if (modelSettings) modelSettings.open({ target: { kind: 'default' }, config, section: choice.projector ? 'adapters' : 'model' });
      else void guard.run(async () => {
        if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
        await latestStore.current.updateConfig(current => choice.projector ? { mmproj: choice.path }
          : { ...previewExecution(current, choice.path), active_model: choice.path });
        if (onSelectModel && !choice.projector) await onSelectModel(choice.path);
        onOpenModels?.();
      }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const openModelCard = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!selected || !api.isNativeRuntimeAvailable()) return;
    event.preventDefault();
    void api.hfOpenModelCard(selected.id).catch((caught: unknown) => {
      setError(caught instanceof Error ? caught.message : String(caught));
    });
  };
  const remainingSeconds = progress ? estimateRemainingSeconds(progress.received, progress.total, speedBps) : null;
  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100))
    : undefined;
  return { store, t, locale, includeCompanions, setIncludeCompanions, modelCopy, error, setError, notice, setNotice,
    modelsDir, currentDownloadedChoice, configureDownloaded, remainingSeconds, progressPercent,
    ...catalog, ...transfers, ...pendingDownloads, openModelCard };
}
