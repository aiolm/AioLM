import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let native = true;
let resized: (() => void) | undefined;
const win = {
  isDecorated: vi.fn<() => Promise<boolean>>(),
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
  const { default: TitleBar } = await import("./TitleBar");
  return render(<TitleBar />);
}

describe("TitleBar", () => {
  beforeEach(() => {
    native = true;
    win.isDecorated.mockResolvedValue(false);
    win.isMaximized.mockResolvedValue(false);
    document.documentElement.lang = "en";
  });
  afterEach(() => { vi.clearAllMocks(); document.documentElement.lang = "en"; });

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

  it("keeps the native frame on decorated windows such as macOS", async () => {
    win.isDecorated.mockResolvedValue(true);
    const { container } = await renderTitleBar();
    await waitFor(() => expect(win.isDecorated).toHaveBeenCalled());
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows nothing in the browser preview", async () => {
    native = false;
    const { container } = await renderTitleBar();
    await act(async () => undefined);
    expect(container).toBeEmptyDOMElement();
    expect(win.isDecorated).not.toHaveBeenCalled();
  });

  it("falls back to no custom bar when the window cannot be queried", async () => {
    win.isDecorated.mockRejectedValue(new Error("not allowed"));
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
});
