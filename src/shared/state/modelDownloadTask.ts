import { useEffect, useSyncExternalStore } from "react";
import * as api from "../api/index";
import { formatModelLabel } from "../lib/displayPaths";
import { appendDownloadSample, estimateDownloadSpeed, type DownloadSample } from "../lib/transfer";
import {
  finishTask,
  getModelDownloadSnapshot,
  getTaskSnapshot,
  registerTask,
  subscribeTasks,
  updateTask,
  type AppTask,
} from "./taskRegistry";

export const MODEL_DOWNLOAD_TASK_ID = "model-download";
const MODEL_DOWNLOAD_PREFIX = `${MODEL_DOWNLOAD_TASK_ID}:`;

let downloadCounter = 0;

export function createDownloadId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  downloadCounter += 1;
  return `dl-${Date.now()}-${downloadCounter}`;
}

export function modelDownloadTaskId(downloadId: string): string {
  const trimmed = downloadId.trim();
  return trimmed ? `${MODEL_DOWNLOAD_PREFIX}${trimmed}` : MODEL_DOWNLOAD_TASK_ID;
}

export function downloadIdFromTaskId(taskId: string): string | undefined {
  return taskId.startsWith(MODEL_DOWNLOAD_PREFIX)
    ? taskId.slice(MODEL_DOWNLOAD_PREFIX.length) || undefined
    : undefined;
}

export function isDownloadTaskActive(task: Pick<AppTask, "state">): boolean {
  return task.state === "running" || task.state === "cancelling";
}

export function resolveDownloadTaskId(downloadId?: string): string {
  const trimmed = downloadId?.trim();
  return trimmed ? modelDownloadTaskId(trimmed) : MODEL_DOWNLOAD_TASK_ID;
}

/** Turn one progress event into the fields the task row shows. */
function downloadTaskPatch(
  next: api.ModelDownloadProgress,
  samples: DownloadSample[],
  existing?: AppTask,
): Partial<Omit<AppTask, "id">> {
  const estimated = next.phase === "downloading" ? estimateDownloadSpeed(samples) : null;
  return {
    label: formatModelLabel(existing?.label || next.file_path || next.repo_id),
    ...(existing ? {} : { repoId: next.repo_id, filePath: next.file_path }),
    phase: next.phase,
    received: next.received,
    total: next.total,
    speedBps:
      next.phase === "downloading"
        ? (estimated ?? (existing?.phase === "downloading" ? existing.speedBps : undefined))
        : undefined,
  };
}

/**
 * Own the model-download progress stream for the whole app, routing each
 * `download_id` to its own task so concurrent transfers keep independent progress,
 * speed, and pause/cancel controls across every view.
 */
export function useModelDownloadTask(): void {
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const samplesByTask = new Map<string, DownloadSample[]>();
    void api
      .onModelDownloadProgress((next) => {
        if (disposed) return;
        const rawId = next.download_id?.trim() || undefined;
        const taskId = resolveDownloadTaskId(rawId);
        if (next.phase === "complete" || next.phase === "cancelled") {
          samplesByTask.delete(taskId);
          finishTask(taskId, next.phase === "complete" ? "completed" : "cancelled");
          return;
        }
        const prevSamples = samplesByTask.get(taskId) ?? [];
        const samples =
          next.phase === "downloading"
            ? appendDownloadSample(prevSamples, next.received, Date.now())
            : [];
        if (samples.length > 0) {
          samplesByTask.set(taskId, samples);
        } else {
          samplesByTask.delete(taskId);
        }
        const current = getTaskSnapshot().find((task) => task.id === taskId);
        const patch = downloadTaskPatch(next, samples, current);
        if (current) {
          updateTask(taskId, {
            ...patch,
            detail: undefined,
            state: current.state === "cancelling" ? "cancelling" : "running",
          });
        } else {
          registerTask({
            id: taskId,
            kind: "model-download",
            label: formatModelLabel(next.file_path || next.repo_id),
            interruptible: true,
            pausable: true,
            cancel: () => api.hfCancelDownload(rawId),
            ...patch,
          });
        }
      })
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch(() => {
        // Browser preview does not expose native download progress events.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);
}

export function getModelDownloadTasks(): AppTask[] {
  return getModelDownloadSnapshot();
}

export function hasActiveModelDownload(): boolean {
  return getModelDownloadSnapshot().some(isDownloadTaskActive);
}

export function useModelDownloads(): AppTask[] {
  return useSyncExternalStore(subscribeTasks, getModelDownloadSnapshot, getModelDownloadSnapshot);
}

/** First active download (or most recent download task) for single-slot callers. */
export function useModelDownload(): AppTask | undefined {
  const downloads = useModelDownloads();
  return downloads.find(isDownloadTaskActive) ?? downloads[0];
}
