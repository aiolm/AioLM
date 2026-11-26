import { useCallback, useEffect, useRef, useState } from 'react';
import { hfCheckModelUpdates, hfUpdateModel, type ModelUpdateStatus } from '../../shared/api/models';
import { hfCancelDownload } from '../../shared/api/commands';
import { isIpcErrorKind } from '../../shared/api/ipcError';
import {
  createDownloadId,
  isDownloadTaskActive,
  modelDownloadTaskId,
  useModelDownloads,
} from '../../shared/state/modelDownloadTask';
import { finishTask, getTaskSnapshot, registerTask, subscribeTasks, updateTask } from '../../shared/state/taskRegistry';
import { modelDisplayName } from '../../shared/lib/displayPaths';
import { resolveModelDisplayName } from '../../shared/lib/modelNames';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';

/** A successful scan, not a filtered or previously displayed model list. */
export interface ModelUpdateCatalog {
  paths: string[];
  directory: string;
}

const currentTask = (taskId: string) =>
  getTaskSnapshot().find(task => task.id === taskId);

export function useModelUpdates({ active, directory, catalog, blocked }: {
  active: boolean;
  directory: string;
  catalog: ModelUpdateCatalog | null;
  blocked: boolean;
}) {
  const downloadTasks = useModelDownloads();
  const [request, setRequest] = useState(0);
  const [lookup, setLookup] = useState<{
    catalog: ModelUpdateCatalog;
    request: number;
    statuses: Record<string, ModelUpdateStatus>;
    checking: boolean;
    error?: string;
  } | null>(null);
  const [updating, setUpdating] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ catalog: ModelUpdateCatalog; message: string } | null>(null);
  const generation = useRef(0);
  const origin = useRef<{ disposed: boolean } | null>(null);
  const settledLookupRef = useRef<{ catalog: ModelUpdateCatalog; directory: string; request: number } | null>(null);
  const context = useRef({ active, directory, catalog, blocked });
  context.current = { active, directory, catalog, blocked };
  const busy = updating !== null || downloadTasks.some(isDownloadTaskActive);
  const eligible = active && !!catalog && catalog.directory === directory;

  useEffect(() => () => {
    if (origin.current) origin.current.disposed = true;
  }, []);

  useEffect(() => {
    const ownGeneration = ++generation.current;
    if (busy) {
      settledLookupRef.current = null;
      return;
    }
    if (!eligible || !catalog) return;
    if (settledLookupRef.current?.catalog === catalog
      && settledLookupRef.current.directory === directory
      && settledLookupRef.current.request === request) return;
    settledLookupRef.current = null;
    setLookup({ catalog, request, statuses: {}, checking: true });
    if (catalog.paths.length === 0) {
      settledLookupRef.current = { catalog, directory, request };
      setLookup({ catalog, request, statuses: {}, checking: false });
      return;
    }
    void hfCheckModelUpdates(catalog.paths, directory).then(statuses => {
      if (generation.current !== ownGeneration) return;
      settledLookupRef.current = { catalog, directory, request };
      setLookup({ catalog, request, statuses: Object.fromEntries(statuses.map(status => [status.path, status])), checking: false });
    }).catch(error => {
      if (generation.current !== ownGeneration) return;
      setLookup({ catalog, request, statuses: {}, checking: false, error: error instanceof Error ? error.message : String(error) });
    });
    return () => { generation.current += 1; };
  }, [eligible, catalog, directory, request, busy]);

  const refresh = useCallback(() => {
    setFailure(null);
    setRequest(value => value + 1);
  }, []);

  const update = async (path: string) => {
    const current = context.current;
    const status = lookup?.catalog === current.catalog && lookup.request === request && !lookup.checking
      ? lookup.statuses[path] : undefined;
    if (!current.active || !current.catalog || current.catalog.directory !== current.directory || current.blocked
      || origin.current !== null || status?.error || !status?.supported || !status.update_available || !status.latest_revision) return;
    const ownOrigin = { disposed: false };
    origin.current = ownOrigin;
    setUpdating(path);
    setFailure(null);
    const downloadId = createDownloadId();
    const taskId = modelDownloadTaskId(downloadId);
    const cancel = () => hfCancelDownload(downloadId);
    let superseded = false;
    // A replacement can appear and disappear before the next React render.
    const unsubscribe = subscribeTasks(() => {
      const next = currentTask(taskId);
      if (next && next.cancel !== cancel) superseded = true;
    });
    const ownsTask = () => !superseded && currentTask(taskId)?.cancel === cancel;
    registerTask({ id: taskId, kind: 'model-download', downloadKind: 'update', label: modelDisplayName(path),
      filePath: path, modelsDir: current.directory, phase: 'starting', received: 0, total: status.download_bytes, interruptible: true, cancel });
    // A snapshot may carry a declared or selected title; the path label is the fallback.
    void resolveModelDisplayName(path).then(resolved => {
      if (resolved && ownsTask()) updateTask(taskId, { label: resolved });
    });
    try {
      await hfUpdateModel(path, current.directory, status.latest_revision, downloadId);
      // A committed update must refresh every catalog even if its panel left,
      // its folder changed, or its task row was dismissed/replaced meanwhile.
      invalidateModelCatalog();
      if (ownsTask()) finishTask(taskId, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = isIpcErrorKind(error, 'cancelled');
      if (ownsTask()) finishTask(taskId, cancelled ? 'cancelled' : 'failed', message);
      if (!cancelled && !superseded && !ownOrigin.disposed && origin.current === ownOrigin
        && context.current.active && context.current.catalog === current.catalog && context.current.directory === current.directory) {
        setFailure({ catalog: current.catalog, message });
      }
    } finally {
      unsubscribe();
      // Local busy state belongs to the invocation, not the task row's lifetime.
      if (!ownOrigin.disposed && origin.current === ownOrigin) {
        origin.current = null;
        setUpdating(null);
      }
    }
  };

  const currentLookup = eligible && !busy && lookup?.catalog === catalog && lookup.request === request ? lookup : null;
  return {
    statuses: currentLookup?.statuses ?? {},
    checking: eligible && !busy && (!currentLookup || currentLookup.checking),
    lookupError: currentLookup?.error,
    updateError: eligible && failure?.catalog === catalog ? failure.message : undefined,
    updating,
    busy,
    refresh,
    update,
  };
}
