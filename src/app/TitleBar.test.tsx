import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let native = true;
let resized: (() => void) | undefined;
const frameMode = vi.fn<() => Promise<"frameless" | "overlay" | "native">>();
const nativeTheme = vi.fn<(theme: "light" | "dark" | null) => Promise<void>>(async () => undefined);
const win = {
  isMaximized: vi.fn<() => Promise<boolean>>(),
  onResized: vi.fn(async (handler: () => void) => { resized = handler; return () => { resized = undefined; }; }),
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};

// Each test needs a fresh module because the frame answer is cached per window.
async function renderTitleBar() {
  vi.resetModules();
  vi.doMock("../shared/api/transport", () => ({ isNativeRuntimeAvailable: () => native }));
  vi.doMock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: (command: string, args?: { theme: "light" | "dark" | null }) => command === "window_theme" ? nativeTheme(args!.theme) : frameMode() }));
  const { default: TitleBar } = await import("./TitleBar");
  return render(<TitleBar />);
}

describe("TitleBar", () => {
  beforeEach(() => {
    native = true;
    frameMode.mockResolvedValue("frameless");
    nativeTheme.mockResolvedValue(undefined);
    document.documentElement.dataset.theme = "light";
    delete document.documentElement.dataset.themeMode;
    win.isMaximized.mockResolvedValue(false);
    document.documentElement.lang = "en";
  });
  afterEach(() => { vi.clearAllMocks(); document.documentElement.lang = "en"; delete document.documentElement.dataset.theme; delete document.documentElement.dataset.themeMode; });

  it("draws window controls only for a frameless native window", async () => {
    const { container } = await renderTitleBar();
    const controls = await screen.findByRole("group", { name: "Window controls" });
    expect(container.querySelector(".app-titlebar")).toHaveAttribute("data-tauri-drag-region");
    // Controls must stay clickable rather than start a window drag.
    for (const button of controls.querySelectorAll("button")) expect(button).not.toHaveAttribute("data-tauri-drag-region");

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(win.minimize).toHaveBeenCalledTimes(1);
    expect(win.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate controls when a decorated native frame remains", async () => {
    frameMode.mockResolvedValue("native");
    const { container } = await renderTitleBar();
    await waitFor(() => expect(frameMode).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("reserves the macOS title strip without drawing replacement traffic lights", async () => {
    frameMode.mockResolvedValue("overlay");
    await renderTitleBar();
    expect(await screen.findByText("AioLM")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Window controls" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it.each(["overlay", "frameless"] as const)("keeps one usable %s chrome owner inside the newest modal and restores it after nested close", async chrome => {
    frameMode.mockResolvedValue(chrome);
    const { container } = await renderTitleBar();
    await screen.findByText("AioLM");
    const outer = document.createElement("dialog");
    const nested = document.createElement("dialog");
    const field = document.createElement("input");
    outer.append(field);
    document.body.append(outer, nested);
    try {
      await act(async () => { outer.showModal(); });
      expect(outer.querySelector("[data-tauri-drag-region]")).not.toBeNull();
      expect(field).not.toHaveAttribute("data-tauri-drag-region");
      if (chrome === "frameless") {
        fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
        expect(win.minimize).toHaveBeenCalledOnce();
      } else {
        expect(screen.queryByRole("group", { name: "Window controls" })).not.toBeInTheDocument();
      }
      await act(async () => { nested.showModal(); });
      expect(nested.querySelector("[data-tauri-drag-region]")).not.toBeNull();
      expect(outer.querySelector("[data-tauri-drag-region]")).toBeNull();
      expect(document.querySelectorAll(".app-titlebar")).toHaveLength(1);
      await act(async () => { nested.close(); });
      expect(outer.querySelector("[data-tauri-drag-region]")).not.toBeNull();
      await act(async () => { outer.close(); });
      expect(container.querySelector("[data-tauri-drag-region]")).not.toBeNull();
    } finally {
      outer.remove();
      nested.remove();
    }
  });

  it("shows nothing in the browser preview", async () => {
    native = false;
    const { container } = await renderTitleBar();
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
    expect(frameMode).not.toHaveBeenCalled();
  });

  it("falls back to no custom bar when the window cannot be queried", async () => {
    frameMode.mockRejectedValue(new Error("not allowed"));
    const { container } = await renderTitleBar();
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("switches between maximize and restore as the window resizes", async () => {
    await renderTitleBar();
    expect(await screen.findByRole("button", { name: "Maximize" })).toBeInTheDocument();
    win.isMaximized.mockResolvedValue(true);
    await act(async () => { resized?.(); });
    expect(await screen.findByRole("button", { name: "Restore" })).toBeInTheDocument();
  });

  it("follows the document language", async () => {
    await renderTitleBar();
    await screen.findByRole("group", { name: "Window controls" });
    await act(async () => { document.documentElement.lang = "ko"; });
    expect(await screen.findByRole("button", { name: "닫기" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "창 제어" })).toBeInTheDocument();
  });

  it("passes selected modes to the native policy rather than pinning System to its resolved color", async () => {
    document.documentElement.dataset.themeMode = "system";
    await renderTitleBar();
    await waitFor(() => expect(nativeTheme).toHaveBeenLastCalledWith(null));
    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    expect(nativeTheme).toHaveBeenCalledTimes(1);
    for (const [mode, resolved, expected] of [
      ["dark", "dark", "dark"], ["system", "dark", null],
      ["light", "light", "light"], ["system", "light", null],
    ] as const) {
      await act(async () => {
        document.documentElement.dataset.themeMode = mode;
        document.documentElement.dataset.theme = resolved;
      });
      await waitFor(() => expect(nativeTheme).toHaveBeenLastCalledWith(expected));
    }
  });

  it("reports a failed native theme update and still applies a later selection", async () => {
    const failure = new Error("Portal read failed");
    const reported = vi.spyOn(console, "error").mockImplementation(() => undefined);
    nativeTheme.mockRejectedValueOnce(failure);
    try {
      await renderTitleBar();
      await waitFor(() => expect(reported).toHaveBeenCalledWith("Native window appearance could not be synchronized", failure));
      await act(async () => { document.documentElement.dataset.theme = "dark"; });
      await waitFor(() => expect(nativeTheme).toHaveBeenLastCalledWith("dark"));
    } finally {
      reported.mockRestore();
    }
  });

  it("does not send a queued theme update after the chrome owner unmounts", async () => {
    let finish!: () => void;
    const promise = new Promise<void>(resolve => { finish = resolve; });
    nativeTheme.mockReturnValueOnce(promise);
    const { unmount } = await renderTitleBar();
    await waitFor(() => expect(nativeTheme).toHaveBeenCalledWith("light"));
    await act(async () => { document.documentElement.dataset.theme = "dark"; });
    unmount();
    await act(async () => { finish(); });
    expect(nativeTheme).toHaveBeenCalledTimes(1);
    expect(document.documentElement).not.toHaveAttribute("data-window-chrome");
  });

  it.each(["light", "system"] as const)("keeps the newest native %s mode when an earlier theme update is pending", async nextMode => {
    let finishDark!: () => void;
    const pending = new Promise<void>(resolve => { finishDark = resolve; });
    let applied: "light" | "dark" | null = "dark";
    nativeTheme.mockImplementation(async theme => {
      if (theme === "dark") await pending;
      applied = theme;
    });
    document.documentElement.dataset.theme = "dark";
    await renderTitleBar();
    await waitFor(() => expect(nativeTheme).toHaveBeenCalledWith("dark"));
    await act(async () => {
      document.documentElement.dataset.themeMode = nextMode;
      document.documentElement.dataset.theme = "light";
    });
    await act(async () => { finishDark(); });
    await waitFor(() => expect(applied).toBe(nextMode === "system" ? null : "light"));
  });
});
