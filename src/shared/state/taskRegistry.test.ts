import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyCompletion } from "../lib/notifications";
import { finishTask, getTaskSnapshot, registerTask, removeTask, TASK_CLEAR_DELAY_MS, updateTask, type TaskKind } from "./taskRegistry";

vi.mock("../lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const notifyMock = vi.mocked(notifyCompletion);

function start(id: string, kind: TaskKind, extra: Partial<Parameters<typeof registerTask>[0]> = {}) {
  registerTask({ id, kind, label: "work", interruptible: true, ...extra });
}

beforeEach(() => {
  vi.useFakeTimers();
  notifyMock.mockClear();
});

afterEach(() => {
  for (const task of getTaskSnapshot()) removeTask(task.id);
  vi.useRealTimers();
});

describe("completion notifications from finishTask", () => {
  it("announces a successful model download and benchmark by kind", () => {
    start("model-download", "model-download");
    finishTask("model-download", "completed");
    start("bench", "benchmark");
    finishTask("bench", "completed");
    expect(notifyMock.mock.calls).toEqual([["download"], ["benchmark"]]);
  });

  it("stays silent for cancelled, failed and crashed runs", () => {
    for (const state of ["cancelled", "failed", "crashed"] as const) {
      start("model-download", "model-download");
      finishTask("model-download", state);
      start("bench", "benchmark");
      finishTask("bench", state);
    }
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("announces a run exactly once however often it is finished", () => {
    start("model-download", "model-download");
    finishTask("model-download", "completed");
    finishTask("model-download", "completed");
    finishTask("model-download", "failed");
    finishTask("model-download", "completed");
    expect(notifyMock).toHaveBeenCalledTimes(1);
  });

  it("announces each new run that reuses an id", () => {
    start("model-download", "model-download");
    finishTask("model-download", "completed");
    // Re-registered while the finished row is still clearing.
    start("model-download", "model-download");
    finishTask("model-download", "completed");
    // Restarted in place, the way the download progress stream does it.
    updateTask("model-download", { state: "running" });
    finishTask("model-download", "completed");
    expect(notifyMock).toHaveBeenCalledTimes(3);
  });

  it("does not announce a record registered as already completed", () => {
    start("model-download", "model-download", { state: "completed" });
    finishTask("model-download", "completed");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("announces a run that completes after a cancel was requested", () => {
    start("bench", "benchmark");
    updateTask("bench", { state: "cancelling" });
    finishTask("bench", "completed");
    expect(notifyMock).toHaveBeenCalledWith("benchmark");
  });

  it("leaves other work silent unless it opts in", () => {
    start("runtime-operation", "runtime");
    finishTask("runtime-operation", "completed");
    start("session", "other");
    finishTask("session", "completed");
    expect(notifyMock).not.toHaveBeenCalled();
    start("runtime-operation", "runtime", { notifyOnComplete: "download" });
    finishTask("runtime-operation", "completed");
    expect(notifyMock.mock.calls).toEqual([["download"]]);
  });

  it("ignores ids that are not registered", () => {
    finishTask("missing", "completed");
    expect(notifyMock).not.toHaveBeenCalled();
  });
});

describe("task clearing after reuse", () => {
  const task = () => getTaskSnapshot().find(value => value.id === "transfer");

  it.each([
    ["completed", "running"],
    ["cancelled", "running"],
    ["completed", "cancelling"],
    ["cancelled", "cancelling"],
  ] as const)("keeps an accepted %s row update to %s beyond the old clear deadline", (terminal, active) => {
    const cancel = vi.fn();
    start("transfer", "model-download", { phase: "downloading", cancel });
    finishTask("transfer", terminal);
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS / 2);

    updateTask("transfer", { state: active, received: 16, total: 64 });
    const restarted = { ...task()! };
    expect(restarted).toMatchObject({ state: active, received: 16, total: 64, label: "work", phase: "downloading", cancel });
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1);
    expect(task()).toEqual(restarted);

    finishTask("transfer", "completed");
    expect(notifyMock.mock.calls).toEqual(terminal === "completed" ? [["download"], ["download"]] : [["download"]]);
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS - 1);
    expect(task()?.state).toBe("completed");
    vi.advanceTimersByTime(1);
    expect(task()).toBeUndefined();
  });

  it("preserves registerTask reuse, ordinary terminal clearing and failed-row retention", () => {
    start("transfer", "model-download");
    finishTask("transfer", "completed");
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS / 2);
    start("transfer", "model-download");
    const next = { ...task()! };
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1);
    expect(task()).toEqual(next);

    finishTask("transfer", "cancelled");
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS);
    expect(task()).toBeUndefined();

    start("transfer", "model-download");
    finishTask("transfer", "failed", "Synthetic persistent failure");
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS * 2);
    expect(task()).toMatchObject({ state: "failed", detail: "Synthetic persistent failure" });
  });

  it.each(["completed", "cancelled"] as const)("keeps the original %s clear deadline after a non-state update", terminal => {
    start("transfer", "model-download");
    finishTask("transfer", terminal);
    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS / 2);
    updateTask("transfer", { received: 64, detail: "Final transfer size" });
    const updated = { ...task()! };

    vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS / 2 - 1);
    expect(task()).toEqual(updated);
    vi.advanceTimersByTime(1);
    expect(task()).toBeUndefined();
    expect(notifyMock.mock.calls).toEqual(terminal === "completed" ? [["download"]] : []);
  });
});
