import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import * as api from "./api";
import { useAppStore } from "./store";

vi.mock("./api", () => ({
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
