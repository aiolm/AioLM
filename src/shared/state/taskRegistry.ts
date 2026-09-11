import { useSyncExternalStore } from "react";

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
  startedAt: number;
  finishedAt?: number;
  /** Set false only for work that really cannot survive navigation. */
  interruptible: boolean;
  cancel?: () => Promise<void> | void;
}

const tasks = new Map<string, AppTask>();
const listeners = new Set<() => void>();
let snapshot: AppTask[] = [];

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

export function finishTask(id: string, state: Exclude<TaskState, "running" | "cancelling">, detail?: string) {
  updateTask(id, { state, detail, finishedAt: Date.now() });
}

export function removeTask(id: string) {
  if (tasks.delete(id)) publish();
}

export function getTaskSnapshot(): AppTask[] { return snapshot; }

export function subscribeTasks(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useTasks(): AppTask[] {
  return useSyncExternalStore(subscribeTasks, getTaskSnapshot, getTaskSnapshot);
}
