import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyCompletion } from "../lib/notifications";
import { finishTask, getTaskSnapshot, registerTask, removeTask, updateTask, type TaskKind } from "./taskRegistry";

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
