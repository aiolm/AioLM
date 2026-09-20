import { useEffect } from "react";
import * as api from "../api/index";
import { estimateDownloadSpeed, type DownloadSample } from "../lib/transfer";
import { finishTask, getTaskSnapshot, registerTask, updateTask, useTasks, type AppTask } from "./taskRegistry";

export const MODEL_DOWNLOAD_TASK_ID = "model-download";

/** Enough samples to smooth a rate without lagging behind a real slowdown. */
const MAX_SPEED_SAMPLES = 30;

/** Turn one progress event into the fields the task row shows. */
export function downloadTaskPatch(
  next: api.ModelDownloadProgress,
  samples: DownloadSample[],
): Partial<Omit<AppTask, "id">> {
  return {
    label: next.file_path || next.repo_id,
    phase: next.phase,
    received: next.received,
    total: next.total,
    speedBps: next.phase === "downloading" ? estimateDownloadSpeed(samples) ?? undefined : undefined,
  };
}

/**
 * Own the model-download progress stream for the whole app.
 *
 * This used to live inside the Discover panel and unsubscribed whenever that
 * panel stopped being the active view, so walking to another page during a
 * multi-gigabyte download lost the progress, the speed, and the cancel button.
 * The download itself never stopped — only the report did. Holding the
 * subscription at app level and publishing it as a task keeps it visible in the
 * bottom strip from anywhere, and lets Discover read the same record rather
 * than keeping a second copy of it.
 */
export function useModelDownloadTask(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let samples: DownloadSample[] = [];
    void api.onModelDownloadProgress((next) => {
      if (disposed) return;
      if (next.phase === "complete" || next.phase === "cancelled") {
        samples = [];
        finishTask(MODEL_DOWNLOAD_TASK_ID, next.phase === "complete" ? "completed" : "cancelled");
        return;
      }
      samples = next.phase === "downloading"
        ? [...samples, { received: next.received, at: Date.now() }].slice(-MAX_SPEED_SAMPLES)
        : [];
      const patch = downloadTaskPatch(next, samples);
      // A row already on screen is patched in place, so restarting a download
      // cannot leave a stale row behind or open a second one.
      if (getTaskSnapshot().some((task) => task.id === MODEL_DOWNLOAD_TASK_ID)) {
        updateTask(MODEL_DOWNLOAD_TASK_ID, { ...patch, state: "running" });
      } else {
        registerTask({
          id: MODEL_DOWNLOAD_TASK_ID,
          kind: "model-download",
          label: "",
          interruptible: true,
          cancel: () => api.hfCancelDownload(),
          ...patch,
        });
      }
    }).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch(() => {
      // Browser preview does not expose native download progress events.
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

/** The live download row, for panels that show their own detailed view of it. */
export function useModelDownload(): AppTask | undefined {
  return useTasks().find((task) => task.id === MODEL_DOWNLOAD_TASK_ID);
}
