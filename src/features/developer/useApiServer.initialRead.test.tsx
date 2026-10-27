import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ApiServerStatus } from "../../shared/api/types";

type NativeArgs = Record<string, unknown> | undefined;
type Layout = typeof import("../../shared/ui/initialLayout");

const native = vi.fn<(command: string, args?: NativeArgs) => Promise<unknown>>();
const stoppedApi: ApiServerStatus = { running: false, url: null, api_key: null, port: 8080 };
const runningApi: ApiServerStatus = { running: true, url: "http://127.0.0.1:8080/v1", api_key: "synthetic-api-key", port: 8080 };
let handlers: Record<string, (args?: NativeArgs) => Promise<unknown>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function nativeFrames() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    frame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancel: (key: number) => { frames.delete(key); },
    paint: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); },
  };
}

function observe(layout: Layout) {
  const clock = nativeFrames();
  const ready = vi.fn();
  layout.afterInitialLayout(ready, clock.frame, clock.cancel, layout.currentLayoutRead());
  return { clock, ready };
}
type View = ReturnType<typeof observe>;

function holdNext<T>(command: string) {
  const held = deferred<T>();
  const reply = handlers[command];
  handlers[command] = () => { handlers[command] = reply; return held.promise; };
  return held;
}

const calls = (command: string) => native.mock.calls.filter(([name]) => name === command);
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const paint = (view: View, times: number) => { for (let index = 0; index < times; index += 1) view.clock.paint(); };

async function revealTick(view: View, ticks: number, periodMs: number) {
  let revealed = 0;
  for (let index = 1; index <= ticks; index += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(periodMs); });
    view.clock.paint();
    if (!revealed && view.ready.mock.calls.length) revealed = index;
  }
  return revealed;
}

async function load() {
  const layout = await import("../../shared/ui/initialLayout");
  const { useApiServer } = await import("./useApiServer");
  return { layout, useApiServer };
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  native.mockReset();
  handlers = {
    api_server_status: async () => ({ ...stoppedApi }),
    start_api_server: async () => ({ ...runningApi }),
    stop_api_server: async () => undefined,
  };
  native.mockImplementation((command, args) => handlers[command]?.(args)
    ?? Promise.reject(new Error(`Unexpected native command ${command}`)));
  vi.stubGlobal("__TAURI_INTERNALS__", {});
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: native }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("reveals after two 3s native frames while the 3s API listener poll keeps reading", async () => {
  const { layout, useApiServer } = await load();
  const first = holdNext<ApiServerStatus>("api_server_status");
  const view = observe(layout);
  const { result, unmount } = renderHook(() => useApiServer(8080, true));
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  await act(async () => { first.resolve({ ...stoppedApi }); await vi.advanceTimersByTimeAsync(0); });
  expect(result.current.checked).toBe(true);

  expect(await revealTick(view, 6, 3000)).toBe(2);
  expect(view.ready).toHaveBeenCalledOnce();
  expect(calls("api_server_status")).toEqual(Array.from({ length: 7 }, () => ["api_server_status", undefined]));
  expect(result.current.status).toEqual(stoppedApi);
  expect(result.current.error).toBeNull();
  unmount();
});

it("already reveals at the measured 1Hz cadence while API listener polling continues", async () => {
  const { layout, useApiServer } = await load();
  const first = holdNext<ApiServerStatus>("api_server_status");
  const view = observe(layout);
  const { unmount } = renderHook(() => useApiServer(8080, true));
  await act(async () => { first.resolve({ ...stoppedApi }); await vi.advanceTimersByTimeAsync(0); });
  expect(await revealTick(view, 6, 1000)).toBe(2);
  expect(calls("api_server_status")).toEqual(Array.from({ length: 3 }, () => ["api_server_status", undefined]));
  unmount();
});

it("reveals an explicit first listener failure, keeps background failures quiet and recovers without re-gating", async () => {
  const { layout, useApiServer } = await load();
  let attempts = 0;
  handlers.api_server_status = async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("synthetic API listener status unavailable");
    return { ...runningApi };
  };
  const first = observe(layout);
  const { result, unmount } = renderHook(() => useApiServer(8080, true));
  await flush();
  expect(result.current.error).toBe("synthetic API listener status unavailable");
  expect(result.current.checked).toBe(true);
  paint(first, 2);
  expect(first.ready).toHaveBeenCalledOnce();

  const later = observe(layout);
  expect(await revealTick(later, 4, 3000)).toBe(2);
  expect(attempts).toBe(5);
  expect(result.current.status).toEqual(runningApi);
  // A successful background read does not clear an explicit failure; only the user or an action does.
  expect(result.current.error).toBe("synthetic API listener status unavailable");
  expect(calls("api_server_status")).toEqual(Array.from({ length: 5 }, () => ["api_server_status", undefined]));
  unmount();
});

it("keeps manual refresh, a failed action's status re-read and a returning activation read gating a new surface", async () => {
  const { layout, useApiServer } = await load();
  const { result, rerender, unmount } = renderHook(({ active }) => useApiServer(8080, active), { initialProps: { active: true } });
  await flush();

  const manual = holdNext<ApiServerStatus>("api_server_status");
  const manualView = observe(layout);
  let manualRead!: Promise<void>;
  act(() => { manualRead = result.current.refresh(); });
  paint(manualView, 3);
  expect(manualView.ready).not.toHaveBeenCalled();
  await act(async () => { manual.resolve({ ...runningApi }); await manualRead; });
  paint(manualView, 2);
  expect(manualView.ready).toHaveBeenCalledOnce();
  expect(result.current.status).toEqual(runningApi);

  handlers.start_api_server = async () => { throw new Error("synthetic start IPC failure"); };
  const reread = holdNext<ApiServerStatus>("api_server_status");
  const actionView = observe(layout);
  let action!: Promise<void>;
  act(() => { action = result.current.start(); });
  await flush();
  paint(actionView, 3);
  expect(actionView.ready).not.toHaveBeenCalled();
  await act(async () => { reread.resolve({ ...stoppedApi }); await action; });
  paint(actionView, 2);
  expect(actionView.ready).toHaveBeenCalledOnce();
  expect(result.current.error).toBe("synthetic start IPC failure");
  expect(result.current.status).toEqual(stoppedApi);
  expect(calls("start_api_server")).toEqual([["start_api_server", undefined]]);

  rerender({ active: false });
  const returning = holdNext<ApiServerStatus>("api_server_status");
  const returnView = observe(layout);
  rerender({ active: true });
  paint(returnView, 3);
  expect(returnView.ready).not.toHaveBeenCalled();
  await act(async () => { returning.resolve({ ...stoppedApi }); await vi.advanceTimersByTimeAsync(0); });
  paint(returnView, 2);
  expect(returnView.ready).toHaveBeenCalledOnce();
  expect(calls("api_server_status").every(call => call.length === 2 && call[1] === undefined)).toBe(true);
  unmount();
});

it("resumes a quiet fresh listener read on return to the foreground without re-gating", async () => {
  const { layout, useApiServer } = await load();
  const { unmount } = renderHook(() => useApiServer(8080, true));
  await flush();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  const before = calls("api_server_status").length;
  await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
  expect(calls("api_server_status")).toHaveLength(before);

  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
  expect(calls("api_server_status")).toHaveLength(before + 1);
  const view = observe(layout);
  expect(await revealTick(view, 4, 3000)).toBe(2);
  expect(calls("api_server_status")).toEqual(Array.from({ length: before + 5 }, () => ["api_server_status", undefined]));
  unmount();
});
