import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { finishTask, getTaskSnapshot, registerTask, removeTask, TASK_CLEAR_DELAY_MS, updateTask } from "../state/taskRegistry";
import { ActivePanelContext } from "./PanelFeedback";
import { LocalTaskCancelButton, TaskCancellationProvider } from "./TaskCancellation";
import TaskStrip, { transferLabel } from "./TaskStrip";

function clearTasks() {
  for (const task of getTaskSnapshot()) removeTask(task.id);
}

function task(id: string, cancel = vi.fn()) {
  const kind = id === "runtime-operation" ? "runtime" : id === "performance-benchmark-active" ? "benchmark" : "other";
  registerTask({ id, kind, label: "Preparing model", phase: "Loading weights", received: 25, total: 100, interruptible: true, cancel });
  return cancel;
}

function View({ taskId, active = true, mounted = true, disabled = false, pending = false, locale = "en", onCancel = vi.fn() }: { taskId: string; active?: boolean; mounted?: boolean; disabled?: boolean; pending?: boolean; locale?: "en" | "ko"; onCancel?: () => void }) {
  return <I18nProvider initialLocale={locale}><TaskCancellationProvider>
    <TaskStrip />
    <ActivePanelContext.Provider value={active}>
      <section aria-label="Task workspace" hidden={!active}>
        {mounted ? <LocalTaskCancelButton taskId={taskId} disabled={disabled} pending={pending} onClick={onCancel}>Cancel</LocalTaskCancelButton> : <p>Loading workspace</p>}
      </section>
    </ActivePanelContext.Provider>
  </TaskCancellationProvider></I18nProvider>;
}

describe("task cancellation ownership", () => {
  beforeEach(clearTasks);
  afterEach(() => act(clearTasks));

  it("keeps global cancellation available when its workspace has no mounted local control", () => {
    const cancel = task("runtime-operation");
    render(<View taskId="runtime-operation" mounted={false} />);
    const button = within(screen.getByRole("complementary", { name: "Background tasks" })).getByRole("button", { name: "Cancel" });
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledOnce();
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(["runtime-operation", "performance-benchmark-active", "session-load-work"])("keeps progress visible with only the mounted workspace cancellation for %s", (id) => {
    const globalCancel = task(id);
    const localCancel = vi.fn();
    render(<View taskId={id} onCancel={localCancel} />);
    const strip = within(screen.getByRole("complementary", { name: "Background tasks" }));
    expect(strip.getByText("Preparing model")).toBeVisible();
    expect(strip.getByText("Loading weights")).toBeVisible();
    expect(strip.getByRole("progressbar", { name: "Preparing model" })).toHaveAttribute("aria-valuenow", "25");
    expect(strip.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(localCancel).toHaveBeenCalledOnce();
    expect(globalCancel).not.toHaveBeenCalled();
  });

  it("restores working global cancellation when its mounted workspace becomes inactive", () => {
    const cancel = task("performance-benchmark-active");
    const localCancel = vi.fn();
    const view = render(<View taskId="performance-benchmark-active" onCancel={localCancel} />);
    view.rerender(<View taskId="performance-benchmark-active" active={false} onCancel={localCancel} />);
    const button = screen.getByRole("button", { name: "Cancel" });
    expect(screen.getByRole("complementary", { name: "Background tasks" })).toContainElement(button);
    fireEvent.click(button);
    expect(cancel).toHaveBeenCalledOnce();
    expect(localCancel).not.toHaveBeenCalled();
    expect(button).toBeDisabled();
  });

  it("restores global cancellation while the active workspace's local control is unmounted", () => {
    const cancel = task("session-load-work");
    const view = render(<View taskId="session-load-work" />);
    expect(within(screen.getByRole("complementary", { name: "Background tasks" })).queryByRole("button")).not.toBeInTheDocument();
    view.rerender(<View taskId="session-load-work" mounted={false} />);
    expect(screen.getByText("Loading workspace")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { locale: "en" as const, cancelLabel: "Cancel", pendingLabel: "Cancelling", stripLabel: "Background tasks" },
    { locale: "ko" as const, cancelLabel: "취소", pendingLabel: "취소 중", stripLabel: "백그라운드 작업" },
  ])("keeps cancellation pending after returning to the workspace in $locale", ({ locale, cancelLabel, pendingLabel, stripLabel }) => {
    const cancel = task("runtime-operation");
    const localCancel = vi.fn();
    const view = render(<View taskId="runtime-operation" active={false} locale={locale} onCancel={localCancel} />);
    fireEvent.click(screen.getByRole("button", { name: cancelLabel }));
    expect(cancel).toHaveBeenCalledOnce();

    view.rerender(<View taskId="runtime-operation" locale={locale} onCancel={localCancel} />);
    const pendingButton = screen.getByRole("button", { name: pendingLabel });
    expect(screen.getByRole("region", { name: "Task workspace" })).toContainElement(pendingButton);
    expect(pendingButton).toBeDisabled();
    expect(within(screen.getByRole("complementary", { name: stripLabel })).queryByRole("button")).not.toBeInTheDocument();
    fireEvent.click(pendingButton);
    expect(localCancel).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retains global cancellation for a generic task even when a local control shares its ID", () => {
    const cancel = task("document-index");
    const localCancel = vi.fn();
    render(<View taskId="document-index" onCancel={localCancel} />);
    const strip = within(screen.getByRole("complementary", { name: "Background tasks" }));
    fireEvent.click(strip.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
    expect(localCancel).not.toHaveBeenCalled();
    expect(strip.getByRole("button", { name: "Cancelling" })).toBeDisabled();
    expect(within(screen.getByRole("region", { name: "Task workspace" })).getByRole("button", { name: "Cancelling" })).toBeDisabled();
  });

  it("keeps a usable global action while the local control is disabled until cancellation is pending", () => {
    task("runtime-operation");
    const view = render(<View taskId="runtime-operation" disabled />);
    const strip = within(screen.getByRole("complementary", { name: "Background tasks" }));
    expect(strip.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(within(screen.getByRole("region", { name: "Task workspace" })).getByRole("button", { name: "Cancel" })).toBeDisabled();

    act(() => updateTask("runtime-operation", { state: "cancelling" }));
    view.rerender(<View taskId="runtime-operation" disabled pending />);
    expect(strip.getByText("Cancelling")).toBeVisible();
    expect(strip.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
  });

  it("keeps the local cancellation usable without an ownership provider", () => {
    const cancel = vi.fn();
    render(<I18nProvider initialLocale="en"><LocalTaskCancelButton taskId="runtime-operation" onClick={cancel}>Cancel</LocalTaskCancelButton></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("clears a finished install by itself but keeps a failure until it is dismissed", () => {
    vi.useFakeTimers();
    try {
      task("runtime-operation");
      render(<View taskId="runtime-operation" />);
      const strip = within(screen.getByRole("complementary", { name: "Background tasks" }));

      // An install that succeeded has nothing left to say, so its row goes.
      act(() => finishTask("runtime-operation", "completed"));
      expect(strip.getByText("Completed")).toBeVisible();
      act(() => void vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot()).toHaveLength(0);

      // A failure is the only record of what went wrong, so it waits.
      task("runtime-operation");
      act(() => finishTask("runtime-operation", "failed", "disk full"));
      act(() => void vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS * 4));
      expect(getTaskSnapshot()).toHaveLength(1);
      fireEvent.click(screen.getByRole("button", { name: /Dismiss/ }));
      expect(getTaskSnapshot()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a previous run's clear timer delete the next one", () => {
    vi.useFakeTimers();
    try {
      task("runtime-operation");
      act(() => finishTask("runtime-operation", "completed"));
      act(() => void vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS / 2));
      // Starting again reuses the id while the old row is still counting down.
      task("runtime-operation");
      act(() => void vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS));
      expect(getTaskSnapshot().map((item) => item.state)).toEqual(["running"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows transferred bytes and speed while a download is running", () => {
    registerTask({
      id: "model-download",
      kind: "model-download",
      label: "model-Q4_K_M.gguf",
      phase: "downloading",
      received: 500_000_000,
      total: 2_000_000_000,
      speedBps: 88_000_000,
      interruptible: true,
    });
    render(<View taskId="model-download" />);
    const transfer = screen.getByTestId("task-transfer-model-download").textContent ?? "";
    expect(transfer).toContain("/");
    expect(transfer).toMatch(/\/s$/);
    // A task with no byte counts shows no transfer line at all.
    expect(transferLabel({ ...getTaskSnapshot()[0], received: undefined })).toBeNull();
  });
});
