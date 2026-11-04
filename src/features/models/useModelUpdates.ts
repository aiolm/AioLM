import { useCallback, useEffect, useRef, useState } from 'react';
import { hfCheckModelUpdates, hfUpdateModel, type ModelUpdateStatus } from '../../shared/api/models';
import { hfCancelDownload } from '../../shared/api/commands';
import { MODEL_DOWNLOAD_TASK_ID, useModelDownload } from '../../shared/state/modelDownloadTask';
import { finishTask, getTaskSnapshot, registerTask, subscribeTasks } from '../../shared/state/taskRegistry';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';

/** A successful scan, not a filtered or previously displayed model list. */
export interface ModelUpdateCatalog {
  paths: string[];
  directory: string;
}

const currentTask = () => getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);

export function useModelUpdates({ active, directory, catalog, blocked }: {
  active: boolean;
  directory: string;
  catalog: ModelUpdateCatalog | null;
  blocked: boolean;
}) {
  const task = useModelDownload();
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
  const context = useRef({ active, directory, catalog, blocked });
  context.current = { active, directory, catalog, blocked };
  const busy = updating !== null || task?.state === 'running' || task?.state === 'cancelling';
  const eligible = active && !!catalog && catalog.directory === directory;

  useEffect(() => () => {
    if (origin.current) origin.current.disposed = true;
  }, []);

  useEffect(() => {
    const ownGeneration = ++generation.current;
    if (!eligible || !catalog || busy) return;
    setLookup({ catalog, request, statuses: {}, checking: true });
    if (catalog.paths.length === 0) {
      setLookup({ catalog, request, statuses: {}, checking: false });
      return;
    }
    void hfCheckModelUpdates(catalog.paths, directory).then(statuses => {
      if (generation.current !== ownGeneration) return;
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
    const task = currentTask();
    if (!current.active || !current.catalog || current.catalog.directory !== current.directory || current.blocked
      || origin.current !== null || task?.state === 'running' || task?.state === 'cancelling' || status?.error || !status?.supported || !status.update_available || !status.latest_revision) return;
    const ownOrigin = { disposed: false };
    origin.current = ownOrigin;
    setUpdating(path);
    setFailure(null);
    const cancel = () => hfCancelDownload();
    let superseded = false;
    // A replacement can appear and disappear before the next React render.
    const unsubscribe = subscribeTasks(() => {
      const next = currentTask();
      if (next && next.cancel !== cancel) superseded = true;
    });
    const ownsTask = () => !superseded && currentTask()?.cancel === cancel;
    registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: path,
      phase: 'starting', received: 0, total: status.download_bytes, interruptible: true, cancel });
    try {
      await hfUpdateModel(path, current.directory, status.latest_revision);
      // A committed update must refresh every catalog even if its panel left,
      // its folder changed, or its task row was dismissed/replaced meanwhile.
      invalidateModelCatalog();
      if (ownsTask()) finishTask(MODEL_DOWNLOAD_TASK_ID, 'completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = message === 'model download cancelled';
      if (ownsTask()) finishTask(MODEL_DOWNLOAD_TASK_ID, cancelled ? 'cancelled' : 'failed', message);
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
