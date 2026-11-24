import type { AppUpdateInfo, AppUpdateProgress } from '../../shared/api/appUpdates';
import { appendDownloadSample, estimateDownloadSpeed, type DownloadSample } from '../../shared/lib/transfer';
import { finishTask, getTaskSnapshot, registerTask, updateTask } from '../../shared/state/taskRegistry';

export const APP_UPDATE_TASK_ID = "app-update-download";

export interface UpdateState {
  phase: "idle" | "checking" | "checked" | "error" | "installer-started" | AppUpdateProgress["phase"];
  info: AppUpdateInfo | null;
  progress: AppUpdateProgress | null;
  error: string | null;
  errorKind: "check" | "install" | null;
  dismissedVersion: string | null;
}

interface UpdateClient {
  isNative: () => boolean;
  check: () => Promise<AppUpdateInfo>;
  install: (version: string) => Promise<void>;
  listen: (onProgress: (progress: AppUpdateProgress) => void) => Promise<() => void>;
}

export function isUpdateBusy(phase: UpdateState["phase"]): boolean {
  return ["checking", "downloading", "verifying", "installing", "installer-started"].includes(phase);
}

/** One store spans startup, settings and navigation, including StrictMode's effect replay. */
export function createUpdateStore(client: UpdateClient) {
  let state: UpdateState = {
    phase: "idle", info: null, progress: null, error: null, errorKind: null, dismissedVersion: null,
  };
  const subscribers = new Set<() => void>();
  let startupChecked = false;
  let checking: Promise<void> | null = null;
  let installing: Promise<void> | null = null;
  const publish = (patch: Partial<UpdateState>) => {
    state = { ...state, ...patch };
    subscribers.forEach(notify => notify());
  };

  const check = (): Promise<void> => {
    if (checking) return checking;
    if (!client.isNative() || isUpdateBusy(state.phase)) return Promise.resolve();
    publish({ phase: "checking", error: null, errorKind: null, progress: null });
    checking = Promise.resolve().then(client.check).then(info => {
      publish({ info, phase: "checked" });
    }).catch((error: unknown) => {
      publish({ phase: "error", error: error instanceof Error ? error.message : String(error), errorKind: "check" });
    }).finally(() => { checking = null; });
    return checking;
  };

  const install = (): Promise<void> => {
    if (installing) return installing;
    const info = state.info;
    if (!client.isNative() || isUpdateBusy(state.phase) || !info?.available || !info.can_install || !info.latest_version) return Promise.resolve();
    publish({ phase: "downloading", error: null, errorKind: null, progress: null });
    registerTask({
      id: APP_UPDATE_TASK_ID,
      kind: "other",
      downloadKind: "app-update",
      label: `AioLM ${info.latest_version}`,
      phase: "downloading",
      received: 0,
      interruptible: true,
    });
    installing = (async () => {
      let unlisten: (() => void) | undefined;
      let acceptingProgress = true;
      let samples: DownloadSample[] = [];
      try {
        // Subscribe before starting so even a small, cached installer reports its progress.
        unlisten = await client.listen(progress => {
          if (!acceptingProgress) return;
          if (!["downloading", "verifying", "installing"].includes(progress.phase)) return;
          if (!Number.isFinite(progress.downloaded) || progress.downloaded < 0) return;
          const total = progress.total !== null && Number.isFinite(progress.total) && progress.total > 0 ? progress.total : null;
          publish({ phase: progress.phase, progress: { ...progress, total } });
          if (progress.phase === "downloading") {
            samples = appendDownloadSample(samples, progress.downloaded, Date.now());
            const currentTask = getTaskSnapshot().find((task) => task.id === APP_UPDATE_TASK_ID);
            const estimatedSpeed = estimateDownloadSpeed(samples);
            const speedBps = estimatedSpeed ?? (currentTask?.phase === "downloading" ? currentTask.speedBps : undefined);
            updateTask(APP_UPDATE_TASK_ID, {
              phase: "downloading",
              received: progress.downloaded,
              total: total ?? undefined,
              speedBps,
            });
          } else {
            samples = [];
            updateTask(APP_UPDATE_TASK_ID, {
              phase: progress.phase,
              received: total ? progress.downloaded : undefined,
              total: total ?? undefined,
              speedBps: undefined,
            });
          }
        });
        await client.install(info.latest_version!);
        publish({ phase: "installer-started" });
        finishTask(APP_UPDATE_TASK_ID, "completed");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        publish({ phase: "error", error: message, errorKind: "install", progress: null });
        finishTask(APP_UPDATE_TASK_ID, "failed", message);
      } finally {
        acceptingProgress = false;
        unlisten?.();
        installing = null;
      }
    })();
    return installing;
  };

  return {
    getSnapshot: () => state,
    subscribe: (notify: () => void) => { subscribers.add(notify); return () => { subscribers.delete(notify); }; },
    isNative: client.isNative,
    check,
    checkOnStartup: () => {
      if (startupChecked || !client.isNative()) return Promise.resolve();
      startupChecked = true;
      return check();
    },
    install,
    dismiss: () => publish({ dismissedVersion: state.info?.latest_version ?? null }),
  };
}

export type AppUpdateStore = ReturnType<typeof createUpdateStore>;
