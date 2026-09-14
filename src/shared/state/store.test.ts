import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as api from "../api/index";
import { useAppStore } from "./store";
import { useExecutionStore } from "../../features/models/useExecutionStore";
import { testConfig } from "../../testing/appStore";
import { emptyProfileLibrary, profileTargetKey } from "../config/settingsProfiles";

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
  localStorage.clear();
  let saved = structuredClone(testConfig);
  vi.mocked(api.getConfig).mockImplementation(async () => structuredClone(saved));
  vi.mocked(api.saveConfig).mockImplementation(async cfg => { saved = structuredClone(cfg); return cfg; });
  vi.mocked(api.serverStatus).mockResolvedValue({ state: "stopped" });
  vi.mocked(api.stopServer).mockResolvedValue(undefined);
});

afterEach(() => { vi.useRealTimers(); });

it("publishes migrated profiles only after their native save succeeds", async () => {
  const original = JSON.stringify({ version: 1, models: { 'archived.gguf': { temperature: 0.3 } } });
  localStorage.setItem('aiolm-model-execution', original);
  const saving = deferred<api.AppConfig>();
  vi.mocked(api.saveConfig).mockReturnValue(saving.promise);
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(api.saveConfig).toHaveBeenCalledOnce());
  expect(result.current.cfg).toBeNull();
  expect(result.current.bootState).toBe('loading');
  const candidate = vi.mocked(api.saveConfig).mock.calls[0][0];
  expect(candidate.settings_profiles).toMatchObject({ revision: 1, legacy_imported: true });
  expect(candidate.settings_profiles?.applied[profileTargetKey('archived.gguf')].settings.temperature).toBe(0.3);
  await act(async () => { saving.resolve(candidate); await saving.promise; });
  expect(result.current.bootState).toBe('ready');
  expect(result.current.cfg?.settings_profiles).toEqual(candidate.settings_profiles);
  expect(localStorage.getItem('aiolm-model-execution')).toBe(original);
});

it("keeps originals and leaves migration retryable after a failed save", async () => {
  const original = JSON.stringify({ version: 1, models: { 'archived.gguf': { temperature: 0.3 } } });
  localStorage.setItem('aiolm-model-execution', original);
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error('disk full'));
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe('error'));
  expect(result.current.bootError).toContain('disk full');
  expect(result.current.cfg).toBeNull();
  expect(localStorage.getItem('aiolm-model-execution')).toBe(original);
  const first = vi.mocked(api.saveConfig).mock.calls[0][0].settings_profiles;
  await act(async () => { await result.current.loadConfig(); });
  expect(result.current.bootState).toBe('ready');
  expect(result.current.cfg?.settings_profiles).toEqual(first);
});

it("does not overwrite malformed legacy storage or mark its migration complete", async () => {
  localStorage.setItem('aiolm-model-profiles', '{invalid');
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe('error'));
  expect(api.saveConfig).not.toHaveBeenCalled();
  expect(localStorage.getItem('aiolm-model-profiles')).toBe('{invalid');
});

it("skips imported libraries and increments an existing library only once", async () => {
  vi.mocked(api.getConfig).mockResolvedValue({ ...testConfig, settings_profiles: { ...emptyProfileLibrary(), revision: 7 } });
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe('ready'));
  expect(result.current.cfg?.settings_profiles).toMatchObject({ revision: 8, legacy_imported: true });
  vi.mocked(api.getConfig).mockResolvedValue(result.current.cfg!);
  await act(async () => { await result.current.loadConfig(); });
  expect(api.saveConfig).toHaveBeenCalledOnce();
  expect(result.current.cfg?.settings_profiles?.revision).toBe(8);
});

it("serializes concurrent initialization so migration is saved only once", async () => {
  const first = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  const second = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => {
    expect(first.result.current.bootState).toBe('ready');
    expect(second.result.current.bootState).toBe('ready');
  });
  expect(api.saveConfig).toHaveBeenCalledOnce();
  expect(first.result.current.cfg?.settings_profiles).toEqual(second.result.current.cfg?.settings_profiles);
});

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

it("reloads and rebases a save once when disk profiles moved ahead", async () => {
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  const loadsBefore = vi.mocked(api.getConfig).mock.calls.length;
  const savesBefore = vi.mocked(api.saveConfig).mock.calls.length;
  // Disk moved ahead after our snapshot (lost save response, external writer).
  vi.mocked(api.getConfig).mockResolvedValue(structuredClone({ ...result.current.cfg!, port: 9999 }));
  vi.mocked(api.saveConfig).mockRejectedValueOnce(new Error("settings profiles changed since this configuration was opened; reload before saving"));
  let saved!: api.AppConfig;
  await act(async () => { saved = await result.current.updateConfig({ port: 8081 }); });
  expect(saved.port).toBe(8081);
  expect(result.current.cfg?.port).toBe(8081);
  expect(result.current.actionError).toBeNull();
  expect(vi.mocked(api.getConfig).mock.calls.length).toBe(loadsBefore + 1);
  expect(vi.mocked(api.saveConfig).mock.calls.length).toBe(savesBefore + 2);
  expect(vi.mocked(api.saveConfig).mock.calls[savesBefore + 1][0].port).toBe(8081);
});

it("surfaces a repeated profile conflict instead of retrying forever", async () => {
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  vi.mocked(api.saveConfig).mockRejectedValue(new Error("settings profiles changed since this configuration was opened; reload before saving"));
  const savesBefore = vi.mocked(api.saveConfig).mock.calls.length;
  await act(async () => { await expect(result.current.updateConfig({ port: 8081 })).rejects.toThrow("reload before saving"); });
  expect(vi.mocked(api.saveConfig).mock.calls.length).toBe(savesBefore + 2);
  expect(result.current.actionError).toContain("Configuration was not saved");
});

it("does not reload on ordinary save failures", async () => {
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  const loadsBefore = vi.mocked(api.getConfig).mock.calls.length;
  vi.mocked(api.saveConfig).mockRejectedValue(new Error("disk full"));
  await act(async () => { await expect(result.current.updateConfig({ port: 8081 })).rejects.toThrow("disk full"); });
  expect(vi.mocked(api.getConfig).mock.calls.length).toBe(loadsBefore);
});

it("heals a stale execution-store save through reload and re-expansion", async () => {
  const { result } = renderHook(() => useAppStore({ pollIntervalMs: 60_000 }));
  await waitFor(() => expect(result.current.bootState).toBe("ready"));
  // Emulate the backend revision guard from here on.
  let disk = structuredClone(result.current.cfg!);
  vi.mocked(api.saveConfig).mockImplementation(async (cfg) => {
    const same = JSON.stringify(disk.settings_profiles) === JSON.stringify(cfg.settings_profiles);
    if (!same && cfg.settings_profiles?.revision !== (disk.settings_profiles?.revision ?? 0) + 1) {
      throw new Error("settings profiles changed since this configuration was opened; reload before saving");
    }
    disk = structuredClone(cfg);
    return structuredClone(cfg);
  });
  // An external writer moves disk ahead without telling this window.
  disk = { ...structuredClone(disk), settings_profiles: { ...disk.settings_profiles!, revision: disk.settings_profiles!.revision + 1 } };
  const diskRev = disk.settings_profiles!.revision;
  vi.mocked(api.getConfig).mockResolvedValue(structuredClone(disk));
  const wrapped = renderHook(() => useExecutionStore(result.current));
  const savesBefore = vi.mocked(api.saveConfig).mock.calls.length;
  let saved!: api.AppConfig;
  await act(async () => { saved = await wrapped.result.current.store.updateConfig({ models_dir: "D:\\new-models" }); });
  // First attempt hits the stale revision, reload+re-expansion retries once.
  expect(vi.mocked(api.saveConfig).mock.calls.length).toBe(savesBefore + 2);
  expect(saved.models_dir).toBe("D:\\new-models");
  expect(result.current.cfg?.models_dir).toBe("D:\\new-models");
  expect(result.current.actionError).toBeNull();
  const finalRev = result.current.cfg?.settings_profiles?.revision ?? 0;
  expect(finalRev).toBeGreaterThanOrEqual(diskRev);
  expect(finalRev).toBeLessThanOrEqual(diskRev + 1);
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
