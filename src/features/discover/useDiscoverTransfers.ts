import { useEffect, useRef, useState, type RefObject } from 'react';
import * as api from '../../shared/api/index';
import { isIpcErrorKind } from '../../shared/api/ipcError';
import type { AppStore } from '../../shared/state/store';
import { MODEL_DOWNLOAD_TASK_ID, useModelDownload } from '../../shared/state/modelDownloadTask';
import { getTaskSnapshot, registerTask, subscribeTasks, updateTask } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import { firstShard, isMmprojPath, markInstalled, selectedBundleContains, shardTotal, validateHfRepoId, type HfFileGroup, type HfSafetensorsGroup } from './discoverUtils';
import { matches, type DiscoverFeedback, type DiscoverProps, type TransferContext, type TransferOrigin } from './discoverControllerTypes';
import { currentTransferTask, finishTransferTask, ownsTransferTask, transferActive } from './discoverTransferTasks';
import type { useDiscoverCatalog } from './useDiscoverCatalog';

/** Transfer ownership survives repository changes but never leaks completion into them. */
export function useDiscoverTransfers({ store, latestStore, catalog, includeCompanions, modelSettings, guard, t,
  setError, setNotice, setDownloadedChoice, onSelectModel, onOpenModels }: DiscoverProps & DiscoverFeedback & {
  latestStore: RefObject<AppStore>; catalog: ReturnType<typeof useDiscoverCatalog>; includeCompanions: boolean;
  modelSettings: ReturnType<typeof useModelSettings>; guard: ReturnType<typeof useDraftGuard>; t: ReturnType<typeof useI18n>['t'];
}) {
  const { selected, inspectGeneration, setInstalledLookup, setInstalledRevision } = catalog;
  const modelsDir = store.cfg?.models_dir ?? '';
  const [downloading, setDownloading] = useState<string | null>(null);
  const transferOrigin = useRef<TransferOrigin | null>(null);
  // The progress stream is owned app-wide so it survives leaving this page;
  // this panel just renders the record it publishes.
  const downloadTask = useModelDownload();
  const progress = downloadTask && downloadTask.received !== undefined
    ? { file_path: downloadTask.label, received: downloadTask.received, total: downloadTask.total ?? 0 }
    : null;
  const speedBps = downloadTask?.speedBps ?? null;
  // The configured engine and runtime are part of what a late completion is
  // checked against: changing either while a file downloads means the result
  // no longer belongs to the execution setup it started under.
  const latestTransferContext = useRef<TransferContext | null>(null);
  latestTransferContext.current = selected && store.cfg ? {
    repo: selected.id,
    destination: modelsDir,
    provider: api.providerOf(store.cfg),
    runtime: store.cfg.active_runtime ?? '',
    activeModel: store.cfg.active_model,
    mmproj: store.cfg.mmproj,
  } : null;
  useEffect(() => () => { if (transferOrigin.current) transferOrigin.current.disposed = true; }, []);
  // Observe task replacement synchronously; a replacement can be registered
  // and cleared before React renders another snapshot of the task registry.
  useEffect(() => subscribeTasks(() => {
    const origin = transferOrigin.current;
    const task = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
    if (origin?.taskCancel && task && task.cancel !== origin.taskCancel) origin.superseded = true;
  }), []);

  const canUpdateTransferPanel = (origin: TransferOrigin) => transferOrigin.current === origin && !origin.disposed;
  const ownsTransferOrigin = (origin: TransferOrigin) => {
    const task = currentTransferTask();
    return canUpdateTransferPanel(origin) && origin.taskCancel !== null && !origin.cancelled && !origin.superseded
      && (!task || task.cancel === origin.taskCancel);
  };
  const ownsCurrentRepository = (origin: TransferOrigin): boolean => {
    const current = latestTransferContext.current;
    return ownsTransferOrigin(origin) && origin.inspectionGeneration === inspectGeneration.current
      && !!current && current.repo === origin.repo && current.destination === origin.destination;
  };
  const ownsCurrentDownload = (origin: TransferOrigin) => {
    const current = latestTransferContext.current;
    return ownsTransferOrigin(origin) && !!current
      && origin.inspectionGeneration === inspectGeneration.current
      && current.repo === origin.repo
      && current.destination === origin.destination
      && current.provider === origin.provider
      && current.runtime === origin.runtime
      && current.activeModel === origin.activeModel
      && current.mmproj === origin.mmproj;
  };

  const download = async ({ file, files: parts, displayPath, sizeBytes }: HfFileGroup) => {
    if (!selected || !store.cfg || transferActive()) return;
    // Bind the transfer to the repository and destination it started from.
    // It outlives a selection change, and another repository's file of the
    // same name must not inherit its result.
    const repoId = selected.id;
    const destination = store.cfg.models_dir;
    const execution = { provider: api.providerOf(store.cfg), runtime: store.cfg.active_runtime ?? '' };
    const origin: TransferOrigin = {
      repo: repoId,
      file: file.path,
      inspectionGeneration: inspectGeneration.current,
      destination,
      ...execution,
      activeModel: store.cfg.active_model,
      mmproj: store.cfg.mmproj,
      taskCancel: null,
      superseded: false,
      cancelled: false,
      disposed: false,
    };
    if (!validateHfRepoId(selected.id)) {
      setError(t("ui.invalidRepoId"));
      return;
    }
    if (!["stopped", "failed", "crashed"].includes(store.status.state)) {
      setError(t("ui.stopBeforeDownload"));
      return;
    }
    setDownloading(file.path);
    transferOrigin.current = origin;
    setDownloadedChoice(null);
    // Show the row immediately, before the first native progress event, so the
    // strip and this card both have something the moment the click lands.
    const cancelDownload = () => api.hfCancelDownload();
    origin.taskCancel = cancelDownload;
    registerTask({
      id: MODEL_DOWNLOAD_TASK_ID,
      kind: "model-download",
      label: displayPath,
      phase: "starting",
      received: 0,
      total: sizeBytes,
      interruptible: true,
      pausable: true,
      cancel: cancelDownload,
    });
    setError(null);
    setNotice(null);
    let transferred = false;
    try {
      // Companions are an explicit per-download request, offered whenever the
      // repository supplies them; no engine has to be selected to ask for them.
      const downloaded = includeCompanions && file.companions_available
        ? await api.hfDownloadModel(repoId, file.path, destination, true)
        : await api.hfDownloadModel(repoId, file.path, destination);
      transferred = true;
      finishTransferTask(origin.taskCancel, 'completed');
      invalidateModelCatalog();
      // Mark it installed now and re-read after: the row must stop offering a
      // download the instant the transfer lands, and the lookup then confirms
      // it against the destination directory. Applied only while the panel is
      // still showing what was downloaded.
      if (canUpdateTransferPanel(origin)) {
        setInstalledLookup((current) => {
          if (!matches(current, repoId, destination)) return current;
          let entries = current!.entries;
          const parent = downloaded.path.slice(0, Math.max(downloaded.path.lastIndexOf('/'), downloaded.path.lastIndexOf('\\')) + 1);
          for (const part of parts) entries = markInstalled(entries, part.path, parent + part.path.split('/').pop()!, part.size_bytes);
          return { ...current!, entries };
        });
        setInstalledRevision((revision) => revision + 1);
      }
      let modelPath = downloaded.path;
      if (shardTotal(file.path)) {
        const entries = await api.hfInstalledFiles(repoId, [firstShard(file.path)], destination);
        const first = entries.find(entry => entry.path === firstShard(file.path));
        if (!first || first.missing_shards.length > 0) {
          if (ownsCurrentRepository(origin)) setNotice({ message: t('ui.downloadedModel', { file: displayPath }), repo: repoId, destination });
          return;
        }
        modelPath = first.local_path;
      }
      if (modelSettings) {
        const projector = file.is_mmproj || isMmprojPath(file.path);
        if (ownsCurrentRepository(origin)) {
          setDownloadedChoice({ path: modelPath, projector, repo: repoId, destination });
          setNotice({ message: t(projector ? 'ui.downloadedProjector' : 'ui.downloadedModel', { file: displayPath }), repo: repoId, destination });
        }
        return;
      }
      if (file.is_mmproj || isMmprojPath(file.path)) {
        if (!ownsCurrentDownload(origin)) return;
        const applied = await guard.run(async () => {
          if (!ownsCurrentDownload(origin)) return;
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
          await latestStore.current.updateConfig({ mmproj: downloaded.path });
        });
        if (applied && ownsCurrentDownload(origin)) setNotice({ message: t("ui.downloadedProjector", { file: displayPath }), repo: repoId, destination });
      } else {
        if (!ownsCurrentDownload(origin)) return;
        const applied = onSelectModel
          ? await guard.run(async () => {
            if (!ownsCurrentDownload(origin)) return;
            if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
            await onSelectModel(modelPath); onOpenModels?.();
          })
          : await guard.run(async () => {
            if (!ownsCurrentDownload(origin)) return;
            if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
            await latestStore.current.updateConfig({ active_model: modelPath });
          });
        if (applied && ownsCurrentDownload(origin)) setNotice({ message: t("ui.downloadedModel", { file: displayPath }), repo: repoId, destination });
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const cancelled = isIpcErrorKind(caught, 'cancelled');
      // A download that never reached the native stream ends here, so the row
      // has to be closed from this side or it would sit there running forever.
      if (!transferred) finishTransferTask(origin.taskCancel, cancelled ? 'cancelled' : 'failed', message);
      if (!cancelled && ownsTransferTask(origin.taskCancel) && canUpdateTransferPanel(origin)) setError(message);
    } finally {
      if (!transferred) {
        invalidateModelCatalog();
        if (canUpdateTransferPanel(origin)) setInstalledRevision(revision => revision + 1);
      }
      if (canUpdateTransferPanel(origin)) setDownloading(null);
    }
  };

  const cancel = async () => {
    const task = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
    if (!task || !['running', 'cancelling'].includes(task.state)) return;
    const cancelToken = task.cancel;
    if (!cancelToken) return;
    const origin = downloading && transferOrigin.current?.file === downloading && transferOrigin.current.taskCancel === cancelToken
      ? transferOrigin.current : null;
    if (origin) origin.cancelled = true;
    updateTask(MODEL_DOWNLOAD_TASK_ID, { state: 'cancelling' });
    try {
      await api.hfCancelDownload();
    } catch (caught) {
      if (ownsTransferTask(cancelToken)) {
        if (origin && transferOrigin.current === origin) origin.cancelled = false;
        updateTask(MODEL_DOWNLOAD_TASK_ID, { state: 'running' });
        if (!origin || canUpdateTransferPanel(origin)) setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  };

  const downloadSnapshot = async (group?: HfSafetensorsGroup) => {
    if (!selected || !store.cfg || transferActive()) return;
    if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state) || latestStore.current.busy) {
      setError(t('ui.stopBeforeDownload')); return;
    }
    const repo = selected.id;
    const destination = store.cfg.models_dir;
    const selectedFile = group?.file.path;
    const transferFile = selectedFile ?? repo;
    const origin: TransferOrigin = {
      repo,
      file: transferFile,
      inspectionGeneration: inspectGeneration.current,
      destination,
      provider: api.providerOf(store.cfg),
      runtime: store.cfg.active_runtime ?? '',
      activeModel: store.cfg.active_model,
      mmproj: store.cfg.mmproj,
      taskCancel: null,
      superseded: false,
      cancelled: false,
      disposed: false,
    };
    setDownloadedChoice(null);
    setDownloading(transferFile); setError(null); setNotice(null);
    transferOrigin.current = origin;
    const cancelDownload = () => api.hfCancelDownload();
    origin.taskCancel = cancelDownload;
    registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: group?.displayPath ?? repo, phase: 'starting',
      received: 0, total: 0, interruptible: true, pausable: true, cancel: cancelDownload });
    try {
      const artifact = selectedFile
        ? await api.hfDownloadSnapshot(repo, destination, selectedFile)
        : await api.hfDownloadSnapshot(repo, destination);
      invalidateModelCatalog(); finishTransferTask(cancelDownload, 'completed');
      if (canUpdateTransferPanel(origin)) setInstalledRevision(revision => revision + 1);
      const matchesSelection = selectedFile ? selectedBundleContains(artifact, selectedFile) : artifact.selected_file === undefined;
      if (ownsCurrentRepository(origin) && matchesSelection && !artifact.incomplete && artifact.missing.length === 0) {
        setDownloadedChoice({ path: artifact.path, projector: false, repo, destination,
          selected_file: artifact.selected_file, selected_weight_files: artifact.selected_weight_files });
        setNotice({ message: t('ui.downloadedModel', { file: group?.displayPath ?? repo }), repo, destination });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = isIpcErrorKind(cause, 'cancelled');
      if (ownsTransferTask(cancelDownload)) {
        finishTransferTask(cancelDownload, cancelled ? 'cancelled' : 'failed', message);
        if (canUpdateTransferPanel(origin)) setInstalledRevision(revision => revision + 1);
        if (!cancelled && ownsCurrentDownload(origin)) setError(message);
      }
    } finally {
      if (canUpdateTransferPanel(origin)) setDownloading(null);
    }
  };

  return { downloading, transferOrigin, downloadTask, progress, speedBps, download, downloadSnapshot, cancel };
}
