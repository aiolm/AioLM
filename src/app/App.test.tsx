import { describe, expect, it } from "vitest";
import { findTaskBlockingTabLeave } from "./App";
import type { AppTask } from "../shared/state/taskRegistry";

function task(overrides: Partial<AppTask> = {}): AppTask {
  return {
    id: "t1",
    kind: "other",
    label: "Task",
    state: "running",
    startedAt: 0,
    interruptible: true,
    ...overrides,
  };
}

describe("findTaskBlockingTabLeave", () => {
  it("warns for an active task registered as unable to survive navigation", () => {
    const blocking = task({ interruptible: false });
    expect(findTaskBlockingTabLeave([blocking])).toBe(blocking);
  });

  it("matches a cancelling task that cannot survive navigation", () => {
    const cancelling = task({ interruptible: false, state: "cancelling" });
    expect(findTaskBlockingTabLeave([cancelling])).toBe(cancelling);
  });

  it("does not warn for a task that can survive navigation", () => {
    const interruptible = task({ interruptible: true });
    expect(findTaskBlockingTabLeave([interruptible])).toBeUndefined();
  });

  it("ignores a non-interruptible task that is no longer active", () => {
    const finished = task({ interruptible: false, state: "completed" });
    expect(findTaskBlockingTabLeave([finished])).toBeUndefined();
  });
});
