import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n/i18n";
import { finishTask, getTaskSnapshot, registerTask, removeTask } from "../state/taskRegistry";
import ActivityCenter from "./ActivityCenter";
import PanelFeedback, { PanelFeedbackOutlet, PanelFeedbackProvider } from "./PanelFeedback";
import TaskStrip from "./TaskStrip";

afterEach(() => {
  cleanup();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

describe("ActivityCenter", () => {
  it("stays mounted in the header when empty and toggles an empty-state popover", async () => {
    render(
      <I18nProvider initialLocale="en">
        <PanelFeedbackProvider>
          <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention needed" globalError={false}>
            <PanelFeedbackOutlet />
            <TaskStrip excludeKinds={["model-launch", "model-download"]} />
          </ActivityCenter>
        </PanelFeedbackProvider>
      </I18nProvider>,
    );

    const trigger = screen.getByTestId("activity-center-trigger");
    const popover = screen.getByTestId("activity-center-popover");
    expect(trigger).toBeVisible();
    expect(trigger).toHaveAccessibleName("Tasks");
    expect(screen.queryByTestId("activity-center-badge")).not.toBeInTheDocument();
    expect(popover).toHaveAttribute("hidden");

    fireEvent.click(trigger);
    expect(popover).not.toHaveAttribute("hidden");
    expect(within(popover).getByText("No active tasks or notices.")).toBeVisible();

    fireEvent.click(within(popover).getByRole("button", { name: "Close" }));
    expect(popover).toHaveAttribute("hidden");
  });

  it("positions the popover immediately using preferredWidth without waiting for ResizeObserver", () => {
    const innerWidthDesc = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const innerHeightDesc = Object.getOwnPropertyDescriptor(window, "innerHeight");
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 1280 });
    Object.defineProperty(window, "innerHeight", { configurable: true, value: 800 });

    try {
      render(
        <I18nProvider initialLocale="en">
          <PanelFeedbackProvider>
            <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention needed" globalError={false}>
              <PanelFeedbackOutlet />
              <TaskStrip excludeKinds={["model-launch", "model-download"]} />
            </ActivityCenter>
          </PanelFeedbackProvider>
        </I18nProvider>,
      );

      const trigger = screen.getByTestId("activity-center-trigger");
      const popover = screen.getByTestId("activity-center-popover");
      vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
        x: 1212,
        y: 42,
        left: 1212,
        right: 1248,
        top: 42,
        bottom: 78,
        width: 36,
        height: 36,
        toJSON: () => ({}),
      });
      vi.spyOn(popover, "getBoundingClientRect").mockReturnValue({
        x: 0,
        y: 0,
        left: 0,
        right: 420,
        top: 0,
        bottom: 120,
        width: 420,
        height: 120,
        toJSON: () => ({}),
      });

      fireEvent.click(trigger);

      expect(popover).not.toHaveAttribute("hidden");
      expect(popover.style.width).toBe("440px");
      expect(popover.style.left).toBe("808px");
      expect(popover.style.right).toBe("auto");
      expect(popover.style.top).toBe("84px");
      expect(popover.style.visibility).toBe("");
    } finally {
      if (innerWidthDesc) Object.defineProperty(window, "innerWidth", innerWidthDesc);
      if (innerHeightDesc) Object.defineProperty(window, "innerHeight", innerHeightDesc);
    }
  });

  it("auto-opens on portaled notices or task failures and closes after dismissal", () => {
    function Fixture() {
      const [notice, setNotice] = useState(false);
      return (
        <I18nProvider initialLocale="en">
          <PanelFeedbackProvider>
            <button type="button" onClick={() => setNotice(true)}>
              Notify
            </button>
            <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention needed" globalError={false}>
              <PanelFeedbackOutlet />
              <TaskStrip excludeKinds={["model-launch", "model-download"]} />
            </ActivityCenter>
            <PanelFeedback>
              {notice && (
                <div role="alert">
                  Save failed
                  <button type="button" onClick={() => setNotice(false)}>
                    Dismiss notice
                  </button>
                </div>
              )}
            </PanelFeedback>
          </PanelFeedbackProvider>
        </I18nProvider>
      );
    }

    render(<Fixture />);
    const trigger = screen.getByTestId("activity-center-trigger");
    const popover = screen.getByTestId("activity-center-popover");
    expect(popover).toHaveAttribute("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Notify" }));
    expect(popover).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("activity-center-badge")).toHaveTextContent("1");
    expect(trigger).toHaveClass("is-error");
    expect(within(popover).getByRole("alert")).toHaveTextContent("Save failed");

    fireEvent.click(trigger);
    expect(popover).toHaveAttribute("hidden");

    act(() => {
      registerTask({ id: "bg-runtime", kind: "runtime", label: "Runtime check", interruptible: true });
      finishTask("bg-runtime", "failed", "Runtime check failed");
    });
    expect(popover).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("activity-center-badge")).toHaveTextContent("2");

    fireEvent.click(within(popover).getByRole("button", { name: "Dismiss notice" }));
    expect(popover).not.toHaveAttribute("hidden");

    fireEvent.click(within(popover).getByRole("button", { name: "Dismiss: Runtime check" }));
    expect(popover).toHaveAttribute("hidden");
    expect(screen.queryByTestId("activity-center-badge")).not.toBeInTheDocument();
  });

  it("omits button spinners for active non-download tasks and excludes runtime downloads", () => {
    registerTask({
      id: "runtime-operation",
      kind: "runtime",
      downloadKind: "runtime",
      label: "llama.cpp · ROCm (AMD) · b11029",
      phase: "downloading",
      received: 50,
      total: 100,
      interruptible: true,
    });

    const view = render(
      <I18nProvider initialLocale="en">
        <PanelFeedbackProvider>
          <ActivityCenter hasActivity={false} title="Tasks" attentionMessage="Attention needed" globalError={false}>
            <PanelFeedbackOutlet />
            <TaskStrip excludeKinds={["model-launch", "model-download"]} />
          </ActivityCenter>
        </PanelFeedbackProvider>
      </I18nProvider>,
    );

    const trigger = screen.getByTestId("activity-center-trigger");
    const popover = screen.getByTestId("activity-center-popover");
    expect(trigger).not.toHaveClass("is-active");
    expect(screen.queryByTestId("activity-center-badge")).not.toBeInTheDocument();
    expect(within(popover).queryByText(/ROCm/)).not.toBeInTheDocument();

    act(() => {
      registerTask({
        id: "runtime-bundle-export",
        kind: "runtime",
        label: "Export runtime ZIP",
        phase: "packaging",
        interruptible: true,
      });
    });

    expect(trigger).toHaveClass("is-active");
    expect(screen.getByTestId("activity-center-badge")).toHaveTextContent("1");
    expect(trigger.querySelector("progress")).toBeNull();
    expect(trigger.querySelector(".header-download-ring")).toBeNull();
    view.unmount();
  });
});
