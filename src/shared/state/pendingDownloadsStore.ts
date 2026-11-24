import { useSyncExternalStore } from "react";
import * as api from "../api/index";
import { isIpcErrorKind } from "../api/ipcError";
import {
  createDownloadId,
  isDownloadTaskActive,
  modelDownloadTaskId,
} from "./modelDownloadTask";
import {
  finishTask,
  getTaskSnapshot,
  registerTask,
  subscribeTasks,
  updateTask,
  type AppTask,
} from "./taskRegistry";

export interface CompletedDownloadRecord {
  id: string;
  repoId: string;
  label: string;
  filePath?: string;
  selectedFile?: string | null;
  path: string;
  projector?: boolean;
  kind: "gguf" | "snapshot";
  completedAt: number;
}

interface PendingDownloadsSnapshot {
  entries: api.PendingDownload[];
  resumingIds: ReadonlySet<string>;
  discardingIds: ReadonlySet<string>;
  completed: CompletedDownloadRecord[];
  error: string | null;
  refreshing: boolean;
}

let entries: api.PendingDownload[] = [];
let resumingIds = new Set<string>();
let discardingIds = new Set<string>();
let completed: CompletedDownloadRecord[] = [];
let pendingError: string | null = null;
let refreshGeneration = 0;
let inFlightRefresh: Promise<void> | null = null;
let pendingRefreshAgain = false;
let snapshot: PendingDownloadsSnapshot = {
  entries,
  resumingIds,
  discardingIds,
  completed,
  error: pendingError,
  refreshing: false,
};
const listeners = new Set<() => void>();

function publish() {
  snapshot = {
    entries,
    resumingIds: new Set(resumingIds),
    discardingIds: new Set(discardingIds),
    completed,
    error: pendingError,
    refreshing: inFlightRefresh !== null,
  };
  for (const listener of listeners) listener();
}

export function recordCompletedDownload(record: Omit<CompletedDownloadRecord, "completedAt">): void {
  completed = [
    { ...record, completedAt: Date.now() },
    ...completed.filter((item) => item.path !== record.path),
  ].slice(0, 6);
  publish();
}

export function dismissCompletedDownload(id: string): void {
  const next = completed.filter((item) => item.id !== id);
  if (next.length === completed.length) return;
  completed = next;
  publish();
}

export function clearPendingDownloadsError(): void {
  if (pendingError === null) return;
  pendingError = null;
  publish();
}

export async function refreshPendingDownloads(options?: { force?: boolean }): Promise<void> {
  if (inFlightRefresh) {
    if (options?.force) pendingRefreshAgain = true;
    return inFlightRefresh;
  }
  const ownGeneration = ++refreshGeneration;
  const promise = (async () => {
    try {
      do {
        pendingRefreshAgain = false;
        const next = await api.hfPendingDownloads();
        if (ownGeneration !== refreshGeneration) return;
        entries = next;
        publish();
      } while (pendingRefreshAgain && ownGeneration === refreshGeneration);
    } catch {
      // Browser preview and transient reads keep the current list.
    } finally {
      if (ownGeneration === refreshGeneration) {
        inFlightRefresh = null;
        pendingRefreshAgain = false;
        publish();
      }
    }
  })();
  inFlightRefresh = promise;
  publish();
  return promise;
}

export function findActiveDownloadForPending(
  entry: api.PendingDownload,
  tasks: readonly AppTask[] = getTaskSnapshot(),
): AppTask | undefined {
  return tasks.find((task) => {
    if (task.kind !== "model-download" || !isDownloadTaskActive(task)) return false;
    if (task.repoId !== entry.repo_id) return false;
    if (entry.snapshot) {
      return (
        task.downloadKind === "snapshot" &&
        (task.filePath ?? "") === (entry.file_path ?? "") &&
        (!task.modelsDir || task.modelsDir === entry.models_dir)
      );
    }
    return (
      task.downloadKind !== "snapshot" &&
      task.filePath === entry.file_path &&
      (!task.modelsDir || task.modelsDir === entry.models_dir)
    );
  });
}

export interface ResumePendingOptions {
  fallbackLabel?: string;
  onSuccess?: (result: {
    repoId: string;
    path: string;
    selectedFile?: string | null;
    kind: "gguf" | "snapshot";
  }) => void | Promise<void>;
}

export interface ResumePendingResult {
  outcome: "completed" | "cancelled" | "failed";
  error?: string;
}

function isMmprojName(filePath?: string | null): boolean {
  const name = (filePath ?? "").split("/").pop() ?? "";
  return name.toLowerCase().startsWith("mmproj");
}

export async function resumePendingDownload(
  entry: api.PendingDownload,
  options?: ResumePendingOptions,
): Promise<ResumePendingResult> {
  if (resumingIds.has(entry.id) || discardingIds.has(entry.id)) {
    return { outcome: "cancelled" };
  }
  if (findActiveDownloadForPending(entry)) {
    return { outcome: "cancelled" };
  }
  if (!entry.snapshot && !entry.file_path) {
    return { outcome: "cancelled" };
  }
  resumingIds.add(entry.id);
  pendingError = null;
  publish();

  const downloadId = createDownloadId();
  const taskId = modelDownloadTaskId(downloadId);
  const cancelDownload = () => api.hfCancelDownload(downloadId);
  let superseded = false;
  const cancelToken = { cancelled: false };
  const unsubscribe = subscribeTasks(() => {
    const next = getTaskSnapshot().find((task) => task.id === taskId);
    if (next && next.cancel !== cancelDownload) superseded = true;
  });

  registerTask({
    id: taskId,
    kind: "model-download",
    label: entry.label || options?.fallbackLabel || entry.repo_id,
    repoId: entry.repo_id,
    filePath: entry.file_path ?? undefined,
    downloadKind: entry.snapshot ? "snapshot" : "gguf",
    includeCompanions: entry.include_companions,
    modelsDir: entry.models_dir,
    phase: "starting",
    received: entry.received,
    total: entry.total,
    interruptible: true,
    pausable: true,
    cancel: cancelDownload,
  });

  let outcome: ResumePendingResult = { outcome: "completed" };
  try {
    let completedPath = "";
    const projector = !entry.snapshot && isMmprojName(entry.file_path);
    if (entry.snapshot) {
      const artifact = await api.hfDownloadSnapshot(
        entry.repo_id,
        entry.models_dir,
        entry.file_path ?? undefined,
        entry.revision ?? "",
        downloadId,
      );
      completedPath = artifact.path;
    } else {
      const downloaded = await api.hfDownloadModel(
        entry.repo_id,
        entry.file_path ?? "",
        entry.models_dir,
        entry.include_companions ? true : undefined,
        entry.revision ?? "",
        downloadId,
      );
      completedPath = downloaded.path;
    }
    const owns = () =>
      !cancelToken.cancelled &&
      !superseded &&
      getTaskSnapshot().find((task) => task.id === taskId)?.cancel === cancelDownload;
    if (owns()) finishTask(taskId, "completed");
    entries = entries.filter((item) => item.id !== entry.id);
    publish();
    recordCompletedDownload({
      id: downloadId,
      repoId: entry.repo_id,
      label: entry.label || entry.repo_id,
      filePath: entry.file_path ?? undefined,
      selectedFile: entry.file_path,
      path: completedPath,
      projector,
      kind: entry.snapshot ? "snapshot" : "gguf",
    });
    await options?.onSuccess?.({
      repoId: entry.repo_id,
      path: completedPath,
      selectedFile: entry.file_path,
      kind: entry.snapshot ? "snapshot" : "gguf",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const paused = isIpcErrorKind(error, "cancelled");
    const owns = () =>
      !cancelToken.cancelled &&
      !superseded &&
      getTaskSnapshot().find((task) => task.id === taskId)?.cancel === cancelDownload;
    if (owns()) finishTask(taskId, paused ? "cancelled" : "failed", message);
    outcome = paused ? { outcome: "cancelled" } : { outcome: "failed", error: message };
  } finally {
    cancelToken.cancelled = true;
    unsubscribe();
    resumingIds.delete(entry.id);
    publish();
    await refreshPendingDownloads({ force: true });
  }
  return outcome;
}

export async function pauseDownloadTask(task: AppTask): Promise<void> {
  if (!task.cancel) return;
  if (task.state === "running") updateTask(task.id, { state: "cancelling" });
  try {
    await task.cancel();
  } catch (error) {
    const current = getTaskSnapshot().find((item) => item.id === task.id);
    if (current?.state === "cancelling" && current.cancel === task.cancel) {
      updateTask(task.id, { state: "running" });
    }
    pendingError = error instanceof Error ? error.message : String(error);
    publish();
  }
}

export async function discardPendingDownload(id: string): Promise<void> {
  if (discardingIds.has(id) || resumingIds.has(id)) return;
  const target = entries.find((entry) => entry.id === id);
  if (target && findActiveDownloadForPending(target)) return;
  discardingIds.add(id);
  pendingError = null;
  publish();
  try {
    await api.hfDiscardDownload(id);
    entries = entries.filter((entry) => entry.id !== id);
    await refreshPendingDownloads({ force: true });
  } catch (error) {
    pendingError = error instanceof Error ? error.message : String(error);
    publish();
  } finally {
    discardingIds.delete(id);
    publish();
  }
}

export function getPendingDownloadsSnapshot(): PendingDownloadsSnapshot {
  return snapshot;
}

export function subscribePendingDownloads(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePendingDownloadsStore(): PendingDownloadsSnapshot {
  return useSyncExternalStore(
    subscribePendingDownloads,
    getPendingDownloadsSnapshot,
    getPendingDownloadsSnapshot,
  );
}

export function resetPendingDownloadsStoreForTests(): void {
  entries = [];
  resumingIds = new Set();
  discardingIds = new Set();
  completed = [];
  pendingError = null;
  refreshGeneration += 1;
  inFlightRefresh = null;
  pendingRefreshAgain = false;
  publish();
}
