import { useEffect, useRef, useState, type RefObject } from 'react';
import * as api from '../../shared/api/index';
import { isIpcErrorKind } from '../../shared/api/ipcError';
import {
  createDownloadId,
  isDownloadTaskActive,
  modelDownloadTaskId,
  useModelDownloads,
} from '../../shared/state/modelDownloadTask';
import {
  recordCompletedDownload,
  refreshPendingDownloads,
} from '../../shared/state/pendingDownloadsStore';
import type { AppStore } from '../../shared/state/store';
import { getTaskSnapshot, registerTask, subscribeTasks, updateTask } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import {
  firstShard,
  isMmprojPath,
  markInstalled,
  selectedBundleContains,
  shardTotal,
  validateHfRepoId,
  type HfFileGroup,
  type HfSafetensorsGroup,
} from './discoverUtils';
import {
  matches,
  type DiscoverFeedback,
  type DiscoverProps,
  type TransferContext,
  type TransferOrigin,
} from './discoverControllerTypes';
import {
  findDownloadTask,
  finishTransferTask,
  hasActiveDownloadMatching,
  ownsTransferTask,
} from './discoverTransferTasks';
import type { useDiscoverCatalog } from './useDiscoverCatalog';

/** Transfer ownership survives repository changes and concurrent transfers never collide. */
export function useDiscoverTransfers({
  store,
  latestStore,
  catalog,
  includeCompanions,
  modelSettings,
  guard,
  t,
  setError,
  setNotice,
  recordDownloadedChoice,
  clearDownloadedChoice,
  onSelectModel,
  onOpenModels,
}: DiscoverProps &
  DiscoverFeedback & {
    latestStore: RefObject<AppStore>;
    catalog: ReturnType<typeof useDiscoverCatalog>;
    includeCompanions: boolean;
    modelSettings: ReturnType<typeof useModelSettings>;
    guard: ReturnType<typeof useDraftGuard>;
    t: ReturnType<typeof useI18n>['t'];
  }) {
  const { selected, inspectGeneration, setInstalledLookup, setInstalledRevision } = catalog;
  const modelsDir = store.cfg?.models_dir ?? '';
  const [localActiveKeys, setLocalActiveKeys] = useState<string[]>([]);
  const activeOriginsRef = useRef<Map<string, TransferOrigin>>(new Map());
  const unmountedRef = useRef(false);

  const activeDownloads = useModelDownloads().filter(isDownloadTaskActive);

  const latestTransferContext = useRef<TransferContext | null>(null);
  latestTransferContext.current =
    selected && store.cfg
      ? {
          repo: selected.id,
          destination: modelsDir,
          provider: api.providerOf(store.cfg),
          runtime: store.cfg.active_runtime ?? '',
          activeModel: store.cfg.active_model,
          mmproj: store.cfg.mmproj,
        }
      : null;

  useEffect(
    () => () => {
      unmountedRef.current = true;
      for (const origin of activeOriginsRef.current.values()) {
        origin.disposed = true;
      }
    },
    [],
  );

  // Observe task replacement synchronously per tracked transfer ID.
  useEffect(
    () =>
      subscribeTasks(() => {
        const snapshot = getTaskSnapshot();
        for (const [taskId, origin] of activeOriginsRef.current) {
          const task = snapshot.find((item) => item.id === taskId);
          if (origin.taskCancel && task && task.cancel !== origin.taskCancel) {
            origin.superseded = true;
          }
        }
      }),
    [],
  );

  const canUpdateTransferPanel = (origin: TransferOrigin) =>
    !unmountedRef.current &&
    !origin.disposed &&
    activeOriginsRef.current.get(origin.taskId) === origin;

  const ownsTransferOrigin = (origin: TransferOrigin) => {
    const task = findDownloadTask(origin.taskId);
    return (
      canUpdateTransferPanel(origin) &&
      origin.taskCancel !== null &&
      !origin.cancelled &&
      !origin.superseded &&
      (!task || task.cancel === origin.taskCancel)
    );
  };

  const ownsCurrentRepository = (origin: TransferOrigin): boolean => {
    const current = latestTransferContext.current;
    return (
      ownsTransferOrigin(origin) &&
      origin.inspectionGeneration === inspectGeneration.current &&
      !!current &&
      current.repo === origin.repo &&
      current.destination === origin.destination
    );
  };

  const ownsCurrentDownload = (origin: TransferOrigin) => {
    const current = latestTransferContext.current;
    return (
      ownsTransferOrigin(origin) &&
      !!current &&
      origin.inspectionGeneration === inspectGeneration.current &&
      current.repo === origin.repo &&
      current.destination === origin.destination &&
      current.provider === origin.provider &&
      current.runtime === origin.runtime &&
      current.activeModel === origin.activeModel &&
      current.mmproj === origin.mmproj
    );
  };

  const download = async ({ file, files: parts, displayPath, sizeBytes }: HfFileGroup) => {
    if (!selected || !store.cfg) return;
    if (!validateHfRepoId(selected.id)) {
      setError(t('ui.invalidRepoId'));
      return;
    }
    if (!['stopped', 'failed', 'crashed'].includes(store.status.state)) {
      setError(t('ui.stopBeforeDownload'));
      return;
    }
    const repoId = selected.id;
    const destination = store.cfg.models_dir;
    const partPaths = new Set(parts.map((part) => part.path));
    if (
      hasActiveDownloadMatching(
        (task) =>
          task.repoId === repoId &&
          task.downloadKind === 'gguf' &&
          (!task.modelsDir || task.modelsDir === destination) &&
          !!task.filePath &&
          partPaths.has(task.filePath),
      )
    ) {
      return;
    }

    const downloadId = createDownloadId();
    const taskId = modelDownloadTaskId(downloadId);
    const downloadCompanions = includeCompanions && file.companions_available;
    const origin: TransferOrigin = {
      taskId,
      downloadId,
      repo: repoId,
      file: file.path,
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
    const cancelDownload = () => api.hfCancelDownload(downloadId);
    origin.taskCancel = cancelDownload;
    activeOriginsRef.current.set(taskId, origin);
    setLocalActiveKeys((current) => [...current, taskId]);
    clearDownloadedChoice({ repo: repoId, destination, filePath: file.path });
    setError(null);
    setNotice(null);

    registerTask({
      id: taskId,
      kind: 'model-download',
      downloadKind: 'gguf',
      repoId,
      filePath: file.path,
      includeCompanions: downloadCompanions,
      modelsDir: destination,
      label: displayPath,
      phase: 'starting',
      received: 0,
      total: sizeBytes,
      interruptible: true,
      pausable: true,
      cancel: cancelDownload,
    });

    let transferred = false;
    try {
      const downloaded = downloadCompanions
        ? await api.hfDownloadModel(repoId, file.path, destination, true, undefined, downloadId)
        : await api.hfDownloadModel(
            repoId,
            file.path,
            destination,
            undefined,
            undefined,
            downloadId,
          );
      transferred = true;
      finishTransferTask(taskId, origin.taskCancel, 'completed');
      invalidateModelCatalog();
      if (canUpdateTransferPanel(origin)) {
        setInstalledLookup((current) => {
          if (!matches(current, repoId, destination)) return current;
          let entries = current!.entries;
          const parent = downloaded.path.slice(
            0,
            Math.max(downloaded.path.lastIndexOf('/'), downloaded.path.lastIndexOf('\\')) + 1,
          );
          for (const part of parts) {
            entries = markInstalled(
              entries,
              part.path,
              parent + part.path.split('/').pop()!,
              part.size_bytes,
            );
          }
          return { ...current!, entries };
        });
        setInstalledRevision((revision) => revision + 1);
      }
      let modelPath = downloaded.path;
      const projector = file.is_mmproj || isMmprojPath(file.path);
      if (shardTotal(file.path)) {
        const entries = await api.hfInstalledFiles(repoId, [firstShard(file.path)], destination);
        const first = entries.find((entry) => entry.path === firstShard(file.path));
        if (!first || first.missing_shards.length > 0) {
          recordCompletedDownload({
            id: downloadId,
            repoId,
            label: displayPath,
            filePath: file.path,
            path: modelPath,
            projector,
            kind: 'gguf',
          });
          if (ownsCurrentRepository(origin)) {
            setNotice({
              message: t('ui.downloadedModelReady', { file: displayPath }),
              repo: repoId,
              destination,
            });
          }
          return;
        }
        modelPath = first.local_path;
      }
      recordCompletedDownload({
        id: downloadId,
        repoId,
        label: displayPath,
        filePath: file.path,
        path: modelPath,
        projector,
        kind: 'gguf',
      });
      if (modelSettings) {
        if (ownsCurrentRepository(origin)) {
          recordDownloadedChoice({
            path: modelPath,
            projector,
            repo: repoId,
            destination,
            filePath: file.path,
          });
          setNotice({
            message: t(projector ? 'ui.downloadedProjectorReady' : 'ui.downloadedModelReady', {
              file: displayPath,
            }),
            repo: repoId,
            destination,
          });
        }
        return;
      }
      if (projector) {
        if (!ownsCurrentDownload(origin)) return;
        const applied = await guard.run(async () => {
          if (!ownsCurrentDownload(origin)) return;
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) {
            throw new Error(t('ui.stopBeforeDownload'));
          }
          await latestStore.current.updateConfig({ mmproj: downloaded.path });
        });
        if (applied && ownsCurrentDownload(origin)) {
          setNotice({
            message: t('ui.downloadedProjector', { file: displayPath }),
            repo: repoId,
            destination,
          });
        }
      } else {
        if (!ownsCurrentDownload(origin)) return;
        const applied = onSelectModel
          ? await guard.run(async () => {
              if (!ownsCurrentDownload(origin)) return;
              if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) {
                throw new Error(t('ui.stopBeforeDownload'));
              }
              await onSelectModel(modelPath);
              onOpenModels?.();
            })
          : await guard.run(async () => {
              if (!ownsCurrentDownload(origin)) return;
              if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) {
                throw new Error(t('ui.stopBeforeDownload'));
              }
              await latestStore.current.updateConfig({ active_model: modelPath });
            });
        if (applied && ownsCurrentDownload(origin)) {
          setNotice({
            message: t('ui.downloadedModel', { file: displayPath }),
            repo: repoId,
            destination,
          });
        }
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const cancelled = isIpcErrorKind(caught, 'cancelled');
      if (!transferred) {
        finishTransferTask(taskId, origin.taskCancel, cancelled ? 'cancelled' : 'failed', message);
      }
      if (!cancelled && ownsTransferTask(taskId, origin.taskCancel) && canUpdateTransferPanel(origin)) {
        setError(message);
      }
    } finally {
      if (!transferred) {
        invalidateModelCatalog();
        if (canUpdateTransferPanel(origin)) setInstalledRevision((revision) => revision + 1);
      }
      activeOriginsRef.current.delete(taskId);
      if (!unmountedRef.current) {
        setLocalActiveKeys((current) => current.filter((key) => key !== taskId));
      }
      void refreshPendingDownloads({ force: true });
    }
  };

  const cancel = async (taskId: string) => {
    const task = findDownloadTask(taskId);
    if (!task || !isDownloadTaskActive(task)) return;
    const cancelToken = task.cancel;
    if (!cancelToken) return;
    const trackedOrigin = activeOriginsRef.current.get(taskId);
    const origin =
      trackedOrigin && trackedOrigin.taskCancel === cancelToken ? trackedOrigin : null;
    if (origin) origin.cancelled = true;
    updateTask(taskId, { state: 'cancelling' });
    try {
      await cancelToken();
    } catch (caught) {
      if (ownsTransferTask(taskId, cancelToken)) {
        if (origin && activeOriginsRef.current.get(taskId) === origin) {
          origin.cancelled = false;
        }
        updateTask(taskId, { state: 'running' });
        if (!origin || canUpdateTransferPanel(origin)) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    }
  };

  const downloadSnapshot = async (group?: HfSafetensorsGroup) => {
    if (!selected || !store.cfg) return;
    if (
      !['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state) ||
      latestStore.current.busy
    ) {
      setError(t('ui.stopBeforeDownload'));
      return;
    }
    const repo = selected.id;
    const destination = store.cfg.models_dir;
    const selectedFile = group?.file.path;
    const transferFile = selectedFile ?? repo;
    if (
      hasActiveDownloadMatching(
        (task) =>
          task.repoId === repo &&
          task.downloadKind === 'snapshot' &&
          (!task.modelsDir || task.modelsDir === destination) &&
          (task.filePath ?? '') === (selectedFile ?? ''),
      )
    ) {
      return;
    }

    const downloadId = createDownloadId();
    const taskId = modelDownloadTaskId(downloadId);
    const cancelDownload = () => api.hfCancelDownload(downloadId);
    const origin: TransferOrigin = {
      taskId,
      downloadId,
      repo,
      file: transferFile,
      inspectionGeneration: inspectGeneration.current,
      destination,
      provider: api.providerOf(store.cfg),
      runtime: store.cfg.active_runtime ?? '',
      activeModel: store.cfg.active_model,
      mmproj: store.cfg.mmproj,
      taskCancel: cancelDownload,
      superseded: false,
      cancelled: false,
      disposed: false,
    };
    activeOriginsRef.current.set(taskId, origin);
    setLocalActiveKeys((current) => [...current, taskId]);
    clearDownloadedChoice({ repo, destination, filePath: selectedFile });
    setError(null);
    setNotice(null);

    registerTask({
      id: taskId,
      kind: 'model-download',
      downloadKind: 'snapshot',
      repoId: repo,
      filePath: selectedFile,
      modelsDir: destination,
      label: group?.displayPath ?? repo,
      phase: 'starting',
      received: 0,
      total: group?.sizeBytes ?? 0,
      interruptible: true,
      pausable: true,
      cancel: cancelDownload,
    });

    try {
      const artifact = selectedFile
        ? await api.hfDownloadSnapshot(repo, destination, selectedFile, undefined, downloadId)
        : await api.hfDownloadSnapshot(repo, destination, undefined, undefined, downloadId);
      invalidateModelCatalog();
      finishTransferTask(taskId, cancelDownload, 'completed');
      if (canUpdateTransferPanel(origin)) setInstalledRevision((revision) => revision + 1);
      const matchesSelection = selectedFile
        ? selectedBundleContains(artifact, selectedFile)
        : artifact.selected_file === undefined;
      if (matchesSelection && !artifact.incomplete && artifact.missing.length === 0) {
        recordCompletedDownload({
          id: downloadId,
          repoId: repo,
          label: group?.displayPath ?? repo,
          filePath: selectedFile,
          selectedFile: artifact.selected_file,
          path: artifact.path,
          kind: 'snapshot',
        });
        if (ownsCurrentRepository(origin)) {
          recordDownloadedChoice({
            path: artifact.path,
            projector: false,
            repo,
            destination,
            filePath: selectedFile,
            selected_file: artifact.selected_file,
            selected_weight_files: artifact.selected_weight_files,
          });
          setNotice({
            message: t('ui.downloadedModelReady', { file: group?.displayPath ?? repo }),
            repo,
            destination,
          });
        }
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = isIpcErrorKind(cause, 'cancelled');
      if (ownsTransferTask(taskId, cancelDownload)) {
        finishTransferTask(taskId, cancelDownload, cancelled ? 'cancelled' : 'failed', message);
        if (canUpdateTransferPanel(origin)) setInstalledRevision((revision) => revision + 1);
        if (!cancelled && canUpdateTransferPanel(origin)) setError(message);
      }
    } finally {
      activeOriginsRef.current.delete(taskId);
      if (!unmountedRef.current) {
        setLocalActiveKeys((current) => current.filter((key) => key !== taskId));
      }
      void refreshPendingDownloads({ force: true });
    }
  };

  return {
    activeDownloads,
    localActiveCount: localActiveKeys.length,
    download,
    downloadSnapshot,
    cancel,
  };
}
