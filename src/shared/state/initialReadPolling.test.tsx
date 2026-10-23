import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AppConfig, ServerStatus, SessionStatus } from "../api/types";
import { testConfig } from "../../testing/appStore";

type NativeArgs = Record<string, unknown> | undefined;
type Layout = typeof import("../ui/initialLayout");

const native = vi.fn<(command: string, args?: NativeArgs) => Promise<unknown>>();
const listed: SessionStatus[] = [{ id: "synthetic", name: "Synthetic session", state: "stopped" }];
const stale: SessionStatus[] = [{ id: "stale", name: "Old lifetime session", state: "running" }];
let handlers: Record<string, (args?: NativeArgs) => Promise<unknown>>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

/** Native frame delivery is driven explicitly, one callback batch per paint. */
function nativeFrames() {
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    frame: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancel: (key: number) => { frames.delete(key); },
    paint: () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback(0)); },
  };
}

/** The same unchanged readiness observer InitialSurface installs before child effects run. */
function observe(layout: Layout, afterRead = layout.currentLayoutRead()) {
  const clock = nativeFrames();
  const ready = vi.fn();
  layout.afterInitialLayout(ready, clock.frame, clock.cancel, afterRead);
  return { clock, ready };
}
type View = ReturnType<typeof observe>;

/** The next native call of this command waits for the test; later calls use the normal reply. */
function holdNext<T>(command: string) {
  const held = deferred<T>();
  const reply = handlers[command];
  handlers[command] = () => { handlers[command] = reply; return held.promise; };
  return held;
}

const calls = (command: string) => native.mock.calls.filter(([name]) => name === command);
const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const paint = (view: View, times: number) => { for (let index = 0; index < times; index += 1) view.clock.paint(); };

/** One native frame per period; timers due in that period run before the frame. */
async function revealTick(view: View, ticks: number, periodMs = 1000) {
  let revealed = 0;
  for (let index = 1; index <= ticks; index += 1) {
    await act(async () => { await vi.advanceTimersByTimeAsync(periodMs); });
    view.clock.paint();
    if (!revealed && view.ready.mock.calls.length) revealed = index;
  }
  return revealed;
}

async function load() {
  const layout = await import("../ui/initialLayout");
  const { useAppStore } = await import("./store");
  const { useSessionPolling } = await import("../hooks/useSessionPolling");
  const api = await import("../api/index");
  return { layout, useAppStore, useSessionPolling, api };
}

beforeEach(() => {
  // Fresh layout reads, shared session poller and configuration queue per case.
  vi.resetModules();
  vi.useFakeTimers();
  localStorage.clear();
  native.mockReset();
  handlers = {
    get_config: async () => structuredClone(testConfig),
    save_config: async args => (args as { cfg: AppConfig }).cfg,
    server_status: async () => ({ state: "stopped" }),
    session_list: async () => structuredClone(listed),
    session_summary_list: async () => structuredClone(listed),
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

it("reveals after two 1Hz native frames while new 1s status and 3s session polls keep reading", async () => {
  const { layout, useAppStore, useSessionPolling } = await load();
  const firstStatus = holdNext<ServerStatus>("server_status");
  const firstSessions = holdNext<SessionStatus[]>("session_list");
  const view = observe(layout);
  const delivered: SessionStatus[][] = [];
  const hook = renderHook(() => ({
    store: useAppStore({ pollIntervalMs: 1000 }),
    refresh: useSessionPolling({ active: true, details: true, onData: items => { delivered.push(items); } }),
  }));

  expect(await revealTick(view, 2)).toBe(0);
  expect(hook.result.current.store.bootState).toBe("ready");
  await act(async () => {
    firstStatus.resolve({ state: "stopped" });
    firstSessions.resolve(structuredClone(listed));
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(await revealTick(view, 8)).toBe(2);
  expect(view.ready).toHaveBeenCalledOnce();
  expect(calls("server_status")).toEqual(Array.from({ length: 9 }, () => ["server_status", undefined]));
  expect(calls("session_list")).toEqual(Array.from({ length: 3 }, () => ["session_list", undefined]));
  expect(calls("get_config")).toEqual([["get_config", undefined]]);
  expect(calls("session_summary_list")).toEqual([]);
  expect(native.mock.calls.map(([name]) => name).filter(name => !["get_config", "save_config", "server_status", "session_list"].includes(name))).toEqual([]);
  expect(delivered).toEqual([listed, listed, listed]);
  expect(hook.result.current.store.status).toEqual({ state: "stopped" });
  expect(hook.result.current.store.statusPollError).toBeNull();
  hook.unmount();
});

it("keeps direct status and session reads, and a dependent read between frames, gating a new surface", async () => {
  const { layout, useAppStore, useSessionPolling, api } = await load();
  const hook = renderHook(() => {
    useAppStore({ pollIntervalMs: 1000 });
    useSessionPolling({ active: true, details: true, onData: () => undefined });
  });
  await flush();
  const view = observe(layout);

  const direct = holdNext<ServerStatus>("server_status");
  const statusRead = api.serverStatus();
  paint(view, 3);
  expect(view.ready).not.toHaveBeenCalled();
  direct.resolve({ state: "running", url: "http://127.0.0.1:8080" });
  await expect(statusRead).resolves.toEqual({ state: "running", url: "http://127.0.0.1:8080" });
  paint(view, 1);

  const dependent = holdNext<SessionStatus[]>("session_list");
  const listRead = api.sessionList();
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  dependent.resolve(structuredClone(listed));
  await expect(listRead).resolves.toEqual(listed);
  paint(view, 1);
  expect(view.ready).not.toHaveBeenCalled();
  paint(view, 1);
  expect(view.ready).toHaveBeenCalledOnce();
  expect(calls("server_status").at(-1)).toEqual(["server_status", undefined]);
  expect(calls("session_list").at(-1)).toEqual(["session_list", undefined]);
  hook.unmount();
});

it("reveals the first status failure, keeps backoff retries fresh, and recovers without re-gating", async () => {
  const { layout, useAppStore } = await load();
  let attempts = 0;
  handlers.server_status = async () => {
    attempts += 1;
    if (attempts <= 2) throw new Error("synthetic status IPC unavailable");
    return { state: "stopped" };
  };
  const first = observe(layout);
  const hook = renderHook(() => useAppStore({ pollIntervalMs: 1000 }));
  await flush();
  expect(hook.result.current.statusPollError).toBe("Model status unavailable: synthetic status IPC unavailable");

  expect(await revealTick(first, 2)).toBe(2);
  // Second failure at 1000ms backs off to 4000ms; the third attempt at 5000ms succeeds.
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(attempts).toBe(3);
  expect(hook.result.current.statusPollError).toBeNull();
  expect(hook.result.current.status).toEqual({ state: "stopped" });

  const later = observe(layout);
  expect(await revealTick(later, 6)).toBe(2);
  expect(calls("server_status")).toEqual(Array.from({ length: 9 }, () => ["server_status", undefined]));
  hook.unmount();
});

it("serves a cached detail snapshot to a joining consumer without a new read or gate", async () => {
  const { layout, useSessionPolling } = await load();
  const firstData = vi.fn(), joinedData = vi.fn();
  const first = renderHook(() => useSessionPolling({ active: true, details: true, onData: firstData }));
  await flush();
  expect(firstData).toHaveBeenCalledWith(listed);
  const view = observe(layout);
  const joined = renderHook(() => useSessionPolling({ active: true, details: true, onData: joinedData }));
  expect(joinedData).toHaveBeenCalledWith(listed);
  await flush();
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();
  expect(calls("session_list")).toEqual([["session_list", undefined]]);
  joined.unmount(); first.unmount();
});

it("makes a detail consumer joining an in-flight first read wait for that shared result", async () => {
  const { layout, useSessionPolling } = await load();
  const held = holdNext<SessionStatus[]>("session_list");
  const firstData = vi.fn(), joinedData = vi.fn();
  const first = renderHook(() => useSessionPolling({ active: true, details: true, onData: firstData }));
  await flush();
  const view = observe(layout);
  const joined = renderHook(() => useSessionPolling({ active: true, details: true, onData: joinedData }));
  await flush();
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  expect(calls("session_list")).toHaveLength(1);
  await act(async () => { held.resolve(structuredClone(listed)); await vi.advanceTimersByTimeAsync(0); });
  expect(firstData).toHaveBeenCalledOnce();
  expect(joinedData).toHaveBeenCalledOnce();
  expect(joinedData).toHaveBeenCalledWith(listed);
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();
  joined.unmount(); first.unmount();
});

it("keeps a detail consumer waiting for its full read when the earlier summary read fails", async () => {
  const { layout, useSessionPolling } = await load();
  const summary = holdNext<SessionStatus[]>("session_summary_list");
  const full = holdNext<SessionStatus[]>("session_list");
  const summaryData = vi.fn(), summaryError = vi.fn(), detailData = vi.fn(), detailError = vi.fn();
  const summaryConsumer = renderHook(() => useSessionPolling({ active: true, onData: summaryData, onError: summaryError }));
  await flush();
  const view = observe(layout);
  const detailConsumer = renderHook(() => useSessionPolling({ active: true, details: true, onData: detailData, onError: detailError }));
  await flush();
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  expect(calls("session_list")).toEqual([]);

  const failure = new Error("synthetic summary IPC unavailable");
  await act(async () => { summary.reject(failure); await vi.advanceTimersByTimeAsync(0); });
  expect(summaryError).toHaveBeenCalledWith(failure);
  expect(detailError).not.toHaveBeenCalled();
  expect(calls("session_list")).toEqual([["session_list", undefined]]);
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();

  await act(async () => { full.resolve(structuredClone(listed)); await vi.advanceTimersByTimeAsync(0); });
  expect(detailData).toHaveBeenCalledWith(listed);
  expect(summaryData).toHaveBeenCalledWith(listed);
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();
  expect(calls("session_summary_list")).toEqual([["session_summary_list", undefined]]);
  detailConsumer.unmount(); summaryConsumer.unmount();
});

it("releases a consumer that leaves before delivery and keeps old results out of the next lifetime", async () => {
  const { layout, useSessionPolling } = await load();
  const held = holdNext<SessionStatus[]>("session_list");
  const view = observe(layout);
  const oldData = vi.fn();
  const old = renderHook(() => useSessionPolling({ active: true, details: true, onData: oldData }));
  await flush();
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  old.unmount();
  await flush();
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();

  const next = observe(layout);
  const nextData = vi.fn();
  const current = renderHook(() => useSessionPolling({ active: true, details: true, onData: nextData }));
  await flush();
  expect(calls("session_list")).toHaveLength(1);
  await act(async () => { held.resolve(structuredClone(stale)); await vi.advanceTimersByTimeAsync(0); });
  expect(oldData).not.toHaveBeenCalled();
  expect(nextData).not.toHaveBeenCalledWith(stale);
  expect(nextData).toHaveBeenCalledWith(listed);
  expect(calls("session_list")).toEqual([["session_list", undefined], ["session_list", undefined]]);
  paint(next, 2);
  expect(next.ready).toHaveBeenCalledOnce();
  current.unmount();
});

it("replays a StrictMode subscription without duplicate delivery or a leaked initial read", async () => {
  const { layout, useSessionPolling } = await load();
  const held = holdNext<SessionStatus[]>("session_list");
  const view = observe(layout);
  const onData = vi.fn();
  const hook = renderHook(() => useSessionPolling({ active: true, details: true, onData }), { wrapper: StrictMode });
  await flush();
  expect(calls("session_list")).toHaveLength(1);
  paint(view, 2);
  expect(view.ready).not.toHaveBeenCalled();
  await act(async () => { held.resolve(structuredClone(stale)); await vi.advanceTimersByTimeAsync(0); });
  expect(onData).toHaveBeenCalledOnce();
  expect(onData).toHaveBeenCalledWith(listed);
  expect(calls("session_list")).toHaveLength(2);
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();
  hook.unmount();
  const idle = observe(layout, 0);
  paint(idle, 2);
  expect(idle.ready).toHaveBeenCalledOnce();
});

it("resumes fresh status and session reads on return to the foreground without re-gating", async () => {
  const { layout, useAppStore, useSessionPolling } = await load();
  const hook = renderHook(() => {
    useAppStore({ pollIntervalMs: 1000 });
    useSessionPolling({ active: true, details: true, onData: () => undefined });
  });
  await flush();
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  const statusBefore = calls("server_status").length, sessionsBefore = calls("session_list").length;
  await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
  expect(calls("server_status")).toHaveLength(statusBefore);
  expect(calls("session_list")).toHaveLength(sessionsBefore);

  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await vi.advanceTimersByTimeAsync(0); });
  expect(calls("server_status")).toHaveLength(statusBefore + 1);
  expect(calls("session_list")).toHaveLength(sessionsBefore + 1);
  expect(calls("server_status").at(-1)).toEqual(["server_status", undefined]);
  expect(calls("session_list").at(-1)).toEqual(["session_list", undefined]);

  const view = observe(layout);
  expect(await revealTick(view, 4)).toBe(2);
  hook.unmount();
});

it("does not gate a surface on a summary-only consumer's pending read", async () => {
  const { layout, useSessionPolling } = await load();
  const summary = holdNext<SessionStatus[]>("session_summary_list");
  const before = layout.currentLayoutRead();
  const view = observe(layout);
  const onData = vi.fn();
  const hook = renderHook(() => useSessionPolling({ active: true, onData }));
  await flush();
  expect(calls("session_summary_list")).toEqual([["session_summary_list", undefined]]);
  expect(layout.currentLayoutRead()).toBe(before);
  paint(view, 2);
  expect(view.ready).toHaveBeenCalledOnce();
  await act(async () => { summary.resolve(structuredClone(listed)); await vi.advanceTimersByTimeAsync(0); });
  expect(onData).toHaveBeenCalledWith(listed);
  hook.unmount();
});
