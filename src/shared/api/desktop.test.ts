import { beforeEach, describe, expect, it, vi } from "vitest";
import { frameWindow, migrationPaths } from "./desktop";

const invoke = vi.fn<(...args: [string, Record<string, unknown>?]) => Promise<unknown>>();
const windowStub = {
  isMaximized: vi.fn(async () => false),
  onResized: vi.fn(async () => () => undefined),
  minimize: vi.fn(async () => undefined),
  toggleMaximize: vi.fn(async () => undefined),
  close: vi.fn(async () => undefined),
};

vi.mock("./transport.ts", () => ({
  invoke: (...args: [string, Record<string, unknown>?]) => invoke(...args),
  withNativeRuntime: <T,>(op: () => Promise<T>) => op(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => windowStub,
}));

describe("desktop api", () => {
  beforeEach(() => {
    invoke.mockReset();
    Object.values(windowStub).forEach(fn => fn.mockClear());
  });

  it("loads window chrome and identity concurrently", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "window_chrome") return "frameless";
      if (command === "window_identity") return { productName: "AioLM Dev", isolatedDev: true };
      return undefined;
    });

    const frame = await frameWindow();
    expect(frame.chrome).toBe("frameless");
    expect(frame.identity).toEqual({ productName: "AioLM Dev", isolatedDev: true });
    await frame.setTheme("dark");
    expect(invoke).toHaveBeenCalledWith("window_theme", { theme: "dark" });
    await frame.window.isMaximized();
    await frame.window.onResized(() => undefined);
    await frame.window.minimize();
    await frame.window.toggleMaximize();
    await frame.window.close();
    expect(windowStub.close).toHaveBeenCalledTimes(1);
  });

  it("keeps frameWindow usable when window_identity is unavailable", async () => {
    invoke.mockImplementation(async (command: string) => {
      if (command === "window_chrome") return "overlay";
      if (command === "window_identity") throw new Error("missing command");
      return [];
    });

    const frame = await frameWindow();
    expect(frame.chrome).toBe("overlay");
    expect(frame.identity).toBeUndefined();

    await expect(migrationPaths()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith("migration_paths");
  });
});
