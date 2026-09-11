import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api/index";
import { useAppStore } from "./store";

vi.mock("../api/index", () => ({
  isNativeRuntimeAvailable: vi.fn(() => true), getConfig: vi.fn(),
  serverStatus: vi.fn(), startServer: vi.fn(), stopServer: vi.fn(), saveConfig: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getConfig).mockResolvedValue({ models_dir: "", active_model: "model.gguf", mmproj: "", lora_adapters: [] } as unknown as api.AppConfig);
  vi.mocked(api.serverStatus).mockResolvedValue({ state: "stopped" });
  vi.mocked(api.stopServer).mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

it("preserves the rendered snapshot when polling returns unchanged nested status", async () => {
  const snapshot: api.ServerStatus = {
    state: "running", url: "http://localhost:8080/v1", log_tail: "ready",
    memory: { model_mb: 10, context_mb: 1, kv_mb: 1, projector_mb: 0, adapters_mb: 0, total_mb: 12, source: "metadata" },
    lifecycle: { sleep_idle_seconds: 0, request_timeout_seconds: 60, parallel: 1 },
  };
  vi.mocked(api.serverStatus).mockImplementation(async () => structuredClone(snapshot));
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.status.state).toBe("running"));
  const rendered = result.current;
  await act(async () => {
    for (let poll = 0; poll < 5; poll += 1) await result.current.refreshStatus();
  });
  expect(result.current).toBe(rendered);
});

it("still publishes changed diagnostics and removes stale optional status fields", async () => {
  const initial: api.ServerStatus = {
    state: "running", log_tail: "ready",
    memory: { model_mb: 10, context_mb: 1, kv_mb: 1, projector_mb: 0, adapters_mb: 0, total_mb: 12, source: "metadata" },
    lifecycle: { sleep_idle_seconds: 0, request_timeout_seconds: 60, parallel: 1 },
  };
  vi.mocked(api.serverStatus).mockResolvedValue(initial);
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.status.state).toBe("running"));
  const updates: Partial<api.ServerStatus>[] = [
    { memory: { ...initial.memory!, total_mb: 20 } },
    { lifecycle: { ...initial.lifecycle!, active_requests: 1 } },
    { log_tail: "request completed" },
  ];
  for (const patch of updates) {
    const next = { ...result.current.status, ...patch };
    vi.mocked(api.serverStatus).mockResolvedValue(next);
    await act(async () => { await result.current.refreshStatus(); });
    expect(result.current.status).toEqual(next);
  }
  vi.mocked(api.serverStatus).mockResolvedValue({ state: "stopped" });
  await act(async () => { await result.current.refreshStatus(); });
  expect(result.current.status).toEqual({ state: "stopped" });
});

it("changes the poll interval without reloading configuration or duplicating timers", async () => {
  vi.mocked(api.saveConfig).mockImplementation(async (cfg) => cfg);
  const { result, rerender, unmount } = renderHook(
    ({ pollIntervalMs }) => useAppStore({ pollIntervalMs }),
    { initialProps: { pollIntervalMs: 60_000 } },
  );
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  await act(async () => { await result.current.updateConfig({ port: 8081 }); });
  const saved = result.current.cfg;
  const revision = result.current.getConfigRevision();
  vi.useFakeTimers();
  rerender({ pollIntervalMs: 2_000 });
  await act(async () => { await Promise.resolve(); });
  expect(api.getConfig).toHaveBeenCalledTimes(1);
  expect(result.current.cfg).toBe(saved);
  expect(result.current.getConfigRevision()).toBe(revision);
  vi.mocked(api.serverStatus).mockClear();
  await act(async () => { await vi.advanceTimersByTimeAsync(1_999); });
  expect(api.serverStatus).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api.serverStatus).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(1);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves defaults through queued saves and clears only explicit overrides", async () => {
  const initial = { models_dir: "", active_model: "model.gguf", mmproj: "", lora_adapters: [], runtime_defaults: ["ngl", "temperature"], ngl: 99, temperature: 1.2 } as unknown as api.AppConfig;
  vi.mocked(api.getConfig).mockResolvedValue(initial);
  vi.mocked(api.saveConfig).mockImplementation(async (cfg) => cfg);
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  await act(async () => {
    await Promise.all([result.current.updateConfig({ temperature: 0.4 }), result.current.updateConfig({ port: 8081 })]);
  });
  expect(result.current.cfg?.runtime_defaults).toEqual(["ngl"]);
  expect(result.current.cfg?.temperature).toBe(0.4);
  expect(result.current.cfg?.port).toBe(8081);
});

it("ignores a cancelled start settling after a new start begins", async () => {
  const first = deferred<string>();
  const second = deferred<string>();
  vi.mocked(api.startServer).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  let firstRun!: Promise<unknown>;
  act(() => { firstRun = result.current.start().catch(() => undefined); });
  await act(async () => { await result.current.stop(); });
  let secondRun!: Promise<string>;
  act(() => { secondRun = result.current.start(); });
  await act(async () => { first.reject(new Error("server start cancelled")); await firstRun; });
  expect(result.current.status.state).toBe("starting");
  expect(result.current.busy).toBe(true);
  vi.mocked(api.serverStatus).mockResolvedValue({ state: "running", url: "http://localhost:8080/v1" });
  await act(async () => { second.resolve("http://localhost:8080/v1"); await secondRun; });
  expect(result.current.status.state).toBe("running");
  expect(result.current.busy).toBe(false);
});
