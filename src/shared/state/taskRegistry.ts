import { useSyncExternalStore } from "react";
import { notifyCompletion, type CompletionNotificationKind } from "../lib/notifications";

export type TaskKind = "runtime" | "benchmark" | "model-download" | "other";
export type TaskState = "running" | "cancelling" | "completed" | "cancelled" | "failed" | "crashed";

export interface AppTask {
  id: string;
  kind: TaskKind;
  label: string;
  phase?: string;
  state: TaskState;
  received?: number;
  total?: number;
  detail?: string;
  /** Bytes per second, when the work reports a transfer rate. */
  speedBps?: number;
  startedAt: number;
  finishedAt?: number;
  /** Set false only for work that really cannot survive navigation. */
  interruptible: boolean;
  cancel?: () => Promise<void> | void;
  /**
   * Which completion alert a successful finish may raise. Model downloads and
   * benchmarks have one by kind; other work opts in here, and the rest - session
   * loads, exports, imports, verification - stays silent.
   */
  notifyOnComplete?: CompletionNotificationKind;
}

const NOTIFY_BY_KIND: Partial<Record<TaskKind, CompletionNotificationKind>> = {
  "model-download": "download",
  benchmark: "benchmark",
};

/** How long a task that ended as expected stays on screen before clearing. */
export const TASK_CLEAR_DELAY_MS = 6000;

const tasks = new Map<string, AppTask>();
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
let snapshot: AppTask[] = [];

function cancelClear(id: string) {
  const timer = clearTimers.get(id);
  if (timer === undefined) return;
  clearTimeout(timer);
  clearTimers.delete(id);
}

function publish() {
  snapshot = [...tasks.values()].sort((left, right) => right.startedAt - left.startedAt);
  for (const listener of listeners) listener();
}

export function registerTask(task: Omit<AppTask, "state" | "startedAt"> & Partial<Pick<AppTask, "state" | "startedAt">>): string {
  const next: AppTask = {
    state: "running",
    startedAt: Date.now(),
    ...task,
  };
  // Reusing an id while its predecessor is still clearing must not let that
  // pending timer delete the new run a few seconds in.
  cancelClear(next.id);
  tasks.set(next.id, next);
  publish();
  return next.id;
}

export function updateTask(id: string, patch: Partial<Omit<AppTask, "id">>) {
  const current = tasks.get(id);
  if (!current) return;
  tasks.set(id, { ...current, ...patch });
  publish();
}

/**
 * End a task and decide how long its row survives.
 *
 * Work that ended the way it was asked to has nothing left to tell anyone, so
 * it clears itself shortly after: an installed runtime that keeps a finished
 * row in the strip forever reads as if it were still doing something. A failure
 * is the opposite — it is the only record of what went wrong — so it stays
 * until the user dismisses it.
 */
export function finishTask(id: string, state: Exclude<TaskState, "running" | "cancelling">, detail?: string) {
  const previous = tasks.get(id);
  if (!previous) return;
  updateTask(id, { state, detail, finishedAt: Date.now(), speedBps: undefined });
  // Only the run's own transition out of active work announces it, so a
  // repeated finish, or a record registered as already completed, stays quiet
  // while a reused id that went back to running announces its new run.
  const notice = previous.notifyOnComplete ?? NOTIFY_BY_KIND[previous.kind];
  if (notice && state === "completed" && (previous.state === "running" || previous.state === "cancelling")) {
    void notifyCompletion(notice);
  }
  cancelClear(id);
  if (state !== "completed" && state !== "cancelled") return;
  clearTimers.set(id, setTimeout(() => {
    clearTimers.delete(id);
    removeTask(id);
  }, TASK_CLEAR_DELAY_MS));
}

export function removeTask(id: string) {
  cancelClear(id);
  if (tasks.delete(id)) publish();
}

/** Drop a finished task the user has read. Running work is left alone. */
export function dismissTask(id: string) {
  const task = tasks.get(id);
  if (!task || task.state === "running" || task.state === "cancelling") return;
  removeTask(id);
}

export function getTaskSnapshot(): AppTask[] { return snapshot; }

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTasks(): AppTask[] {
  return useSyncExternalStore(subscribeTasks, getTaskSnapshot, getTaskSnapshot);
}
