import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import BenchPanel from "./Bench";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import { PERFORMANCE_HISTORY_KEY, type PerformanceBenchmarkRecord } from "./performanceRecords";
import * as performanceRecords from "./performanceRecords";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { testConfig } from '../../testing/appStore';
import { materializeProfileApplication, MODEL_PROFILE_KEYS, profileSettingsSnapshot, profileTargetKey, type SettingsProfile } from '../../shared/config/settingsProfiles';

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  deviceProfile: vi.fn(), onPerformanceBenchmarkProgress: vi.fn(), runPerformanceBench: vi.fn(), benchCancel: vi.fn(),
  sessionList: vi.fn(async () => []), normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []), sessionStop: vi.fn(async () => undefined),
}));

const cfg = { active_model: "C:/models/test.gguf", active_backend: "cpu", active_build: "b1", iters: 3, runtime_defaults: [] } as unknown as api.AppConfig;
let store: AppStore;
let emit: (event: api.PerformanceBenchmarkProgress) => void;
const unlisten = vi.fn();
const mocked = vi.mocked(api);

function row(overrides: Partial<api.PerformanceBenchmarkRow> = {}): api.PerformanceBenchmarkRow {
  return { id: "single-4096-1", prompt_tokens: 4096, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0, ttft_ms: 100, tpot_ms: 10, pp_tps: 40960, tg_tps: 100, e2e_ms: 1380, total_tps: 92.8, peak_memory_bytes: null, timing_source: "client", ...overrides };
}
function result(runId: string, rows: api.PerformanceBenchmarkRow[] = [], status: api.PerformanceBenchmarkResult["status"] = "complete"): api.PerformanceBenchmarkResult {
  return { run_id: runId, rows, status, args: ["-m", cfg.active_model], runtime_version: "llama-test", context_size: 32768, parallel: 4 };
}
function renderPanel(selectedStore = store) {
  return render(<I18nProvider initialLocale="en"><BenchPanel store={selectedStore} /></I18nProvider>);
}

function assignedConfig(overrides: Partial<api.AppConfig> = {}, id = 'profile-benchmark') {
  const value = { ...structuredClone(testConfig), runtime_defaults: [], ...overrides };
  const profile: SettingsProfile = { id, name: id, scope: 'global', legacy: true, coverage: [...MODEL_PROFILE_KEYS], revision: 1,
    settings: profileSettingsSnapshot(value), system_prompt: 'Saved profile prompt' };
  const application = materializeProfileApplication(value, profile.system_prompt!, profile);
  value.settings_profiles = { version: 1, revision: 1, entries: [profile], default_profile_id: id, legacy_imported: true,
    applied: { [profileTargetKey(value.active_model)]: application } };
  return { config: value, application, profile };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useModelSettings).mockReturnValue(null);
  mocked.sessionList.mockResolvedValue([]);
  localStorage.clear();
  for (const task of getTaskSnapshot()) removeTask(task.id);
  store = { cfg, status: { state: "stopped" }, busy: false, updateConfig: vi.fn(), refreshStatus: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) } as unknown as AppStore;
  mocked.deviceProfile.mockResolvedValue(null as unknown as api.DeviceReport);
  mocked.onPerformanceBenchmarkProgress.mockImplementation(async (callback) => { emit = callback; return unlisten; });
  mocked.benchCancel.mockResolvedValue(undefined);
  mocked.runPerformanceBench.mockImplementation(async (_cfg, request) => result(request.run_id, [row()]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Performance benchmark workflow", () => {
  const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, value) => value, getRequestProfile: () => null };

  it("applies a benchmark model independently and freezes its configuration for a run", async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: /^Choose model:/ }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.target.kind).toBe("benchmark");
    const { config: target, application } = assignedConfig({ active_model: "models/benchmark.gguf", ctx_size: 8192, temperature: 0.2, server_args: ["--no-mmap"] });
    store.cfg = { ...store.cfg!, settings_profiles: target.settings_profiles };
    await act(async () => { await request.onApply?.(target, application); });
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    expect(store.cfg?.active_model).toBe(cfg.active_model);
    await waitFor(() => expect(screen.getByRole("button", { name: "Run benchmark" })).toBeEnabled());
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const [runConfig, runRequest] = mocked.runPerformanceBench.mock.calls[0];
    expect(runConfig).toMatchObject({ active_model: target.active_model, ctx_size: 8192, server_args: ["--no-mmap"] });
    expect(runConfig.settings_profiles?.applied[profileTargetKey(target.active_model)]).toMatchObject({ profile_id: application.profile_id });
    target.server_args.push("--no-mlock");
    rerender(<I18nProvider initialLocale="en"><BenchPanel store={{ ...store, cfg: { ...store.cfg!, active_model: "models/another.gguf" } }} /></I18nProvider>);
    expect(screen.getByTitle("models/benchmark.gguf")).toBeVisible();
    expect(screen.getByRole("button", { name: /^Choose model:/ })).toBeDisabled();
    expect(runConfig.server_args).toEqual(["--no-mmap"]);
    await act(async () => finish(result(runRequest.run_id, [row()])));
    const record = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]")[0];
    expect(record.model).toBe("models/benchmark.gguf");
    expect(screen.getByTitle("models/benchmark.gguf")).toBeVisible();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('reopens and runs the selected profile at its latest saved revision without changing workload controls', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const original = assignedConfig({ ngl: 4, ctx_size: 8192, temperature: 0.2 });
    store.cfg = original.config;
    let current = original.config;
    store.getConfig = () => current;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Choose model:/ }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.application).toMatchObject({ profile_id: original.profile.id, profile_revision: 1 });
    await act(async () => { await request.onApply?.(original.config, original.application); });
    const revised = { ...original.profile, revision: 2, settings: { ...original.profile.settings, ngl: 12, ctx_size: 32768, temperature: 1.2 }, system_prompt: 'Updated saved prompt' };
    current = { ...original.config, settings_profiles: { ...original.config.settings_profiles!, revision: 2, entries: [revised] } };
    fireEvent.click(screen.getByRole('button', { name: /^Choose model:/ }));
    const reopened = vi.mocked(settings.open).mock.calls[1][0];
    expect(reopened.application).toMatchObject({ profile_id: original.profile.id, profile_revision: 2, system_prompt: 'Updated saved prompt' });
    expect(reopened.config).toMatchObject({ ngl: 12, ctx_size: 8192, temperature: 0.2 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const runConfig = mocked.runPerformanceBench.mock.calls[0][0];
    expect(runConfig).toMatchObject({ ngl: 12, ctx_size: 8192, temperature: 0.2 });
    expect(runConfig.settings_profiles?.applied[profileTargetKey(runConfig.active_model)]).toMatchObject({ profile_id: revised.id, profile_revision: 2 });
    expect(runConfig.settings_profiles?.entries[0]).toEqual(revised);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('uses the designated default when the benchmark profile was deleted before a run', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const original = assignedConfig({ ngl: 4, ctx_size: 8192, temperature: 0.2 });
    store.cfg = original.config;
    let current = original.config;
    store.getConfig = () => current;
    renderPanel();
    const fallback = assignedConfig({ active_model: original.config.active_model, ngl: 16, ctx_size: 16384, temperature: 0.7 }, 'profile-fallback');
    current = fallback.config;
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const runConfig = mocked.runPerformanceBench.mock.calls[0][0];
    expect(runConfig).toMatchObject({ active_model: original.config.active_model, ngl: 16, ctx_size: 8192, temperature: 0.2 });
    expect(runConfig.settings_profiles?.applied[profileTargetKey(runConfig.active_model)]).toMatchObject({ profile_id: 'profile-fallback' });
    expect(runConfig.settings_profiles?.entries.map(profile => profile.id)).toEqual(['profile-fallback']);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('imports the default execution profile identity along with its model settings', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const original = assignedConfig({ active_model: 'models/default.gguf', ngl: 3 }, 'profile-default-execution');
    const alternate = assignedConfig({ active_model: 'models/benchmark.gguf', ngl: 9 }, 'profile-alternate');
    original.config.settings_profiles!.entries.push(alternate.profile);
    store.cfg = original.config;
    store.getConfig = () => original.config;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Choose model:/ }));
    const target = { ...alternate.config, settings_profiles: original.config.settings_profiles };
    await act(async () => { await vi.mocked(settings.open).mock.calls[0][0].onApply?.(target, alternate.application); });
    fireEvent.click(screen.getByRole('button', { name: 'Use default execution settings' }));
    fireEvent.click(screen.getByRole('button', { name: /^Choose model:/ }));
    const reopened = vi.mocked(settings.open).mock.calls[1][0];
    expect(reopened.application).toMatchObject({ model: 'models/default.gguf', profile_id: original.profile.id, profile_revision: 1 });
    expect(reopened.config).toMatchObject({ active_model: 'models/default.gguf', ngl: 3 });
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('does not offer a default import that resolves to the same selected profile and values', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const original = assignedConfig({ ngl: 4 });
    const revised = { ...original.profile, revision: 2, settings: { ...original.profile.settings, ngl: 12 } };
    store.cfg = { ...original.config, settings_profiles: { ...original.config.settings_profiles!, entries: [revised] } };
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Use default execution settings' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Choose model:/ }));
    expect(vi.mocked(settings.open).mock.calls[0][0].config).toMatchObject({ ngl: 12 });
  });

  it("blocks measuring while a named session is running", async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work", state: "running", model: "models/work.gguf" }]);
    renderPanel();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(mocked.sessionStop).not.toHaveBeenCalled();
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /^Choose model:/ }));
    expect(settings.open).toHaveBeenCalled();
    expect(mocked.sessionStop).not.toHaveBeenCalled();
  });

  it("starts with default workloads and allows single-request-only measurements", async () => {
    renderPanel();
    expect(screen.getByRole("checkbox", { name: "4K" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "16K" })).toBeChecked();
    expect(screen.getByRole("spinbutton", { name: "Output tokens" })).toHaveValue(128);
    expect(screen.getByRole("spinbutton", { name: "Repetitions" })).toHaveValue(1);
    fireEvent.click(screen.getByRole("checkbox", { name: "2×" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "4×" }));
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    expect(mocked.runPerformanceBench.mock.calls[0][0]).toMatchObject(cfg);
    expect(mocked.runPerformanceBench.mock.calls[0][1]).toMatchObject({ prompt_lengths: [4096, 16384], generation_length: 128, batch_sizes: [], repetitions: 1, context_profile: "code_python", warmup: true });
    await waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]")[0].result.status).toBe("complete");
  });

  it("prevents invalid workloads and requires the running server to stop", async () => {
    const { rerender } = renderPanel();
    const generation = screen.getByRole("spinbutton", { name: "Output tokens" });
    fireEvent.change(generation, { target: { value: "4097" } });
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(generation).toHaveAttribute("aria-invalid", "true");
    fireEvent.change(generation, { target: { value: "128" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: "Repetitions" }), { target: { value: "0" } });
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Repetitions" }), { target: { value: "1" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "4K" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "16K" }));
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "4K" }));
    rerender(<I18nProvider initialLocale="en"><BenchPanel store={{ ...store, status: { state: "running" } }} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Stop server" }));
    await waitFor(() => expect(store.stop).toHaveBeenCalledOnce());
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
  });

  it("subscribes before starting and ignores events from another run", async () => {
    let ready!: (value: () => void) => void;
    mocked.onPerformanceBenchmarkProgress.mockImplementation((callback) => { emit = callback; return new Promise((resolve) => { ready = resolve; }); });
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    await act(async () => { ready(unlisten); });
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    act(() => emit({ run_id: "another-run", phase: "single", completed: 1, total: 6, row: row({ tg_tps: 999 }) }));
    expect(screen.queryByText("999.0")).not.toBeInTheDocument();
    act(() => {
      emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() });
      emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() });
    });
    const table = screen.getByRole("table", { name: "Single requests" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "1");
    await act(async () => finish(result(request.run_id, [row()])));
  });

  it("shows one benchmark and preserves progress and cancelled partial results while the page is hidden", async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const page = (hidden: boolean) => <I18nProvider initialLocale="en"><div hidden={hidden}><BenchPanel store={store} /></div></I18nProvider>;
    const { rerender } = render(page(false));
    expect(screen.getByRole("heading", { name: "Benchmark" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    rerender(page(true));
    act(() => emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() }));
    rerender(page(false));
    expect(mocked.runPerformanceBench).toHaveBeenCalledOnce();
    expect(screen.getByRole("table", { name: "Single requests" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel benchmark" }));
    await waitFor(() => expect(mocked.benchCancel).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    await act(async () => finish(result(request.run_id, [row()], "cancelled")));
    const saved = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]")[0];
    expect(saved.result.status).toBe("cancelled");
    expect(saved.result.rows).toHaveLength(1);
    expect(getTaskSnapshot().find((task) => task.id === "performance-benchmark-active")?.state).toBe("cancelled");
  });

  it("keeps successful measurements exportable when history storage is unavailable", async () => {
    renderPanel();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByText("The result could not be saved to history. It remains on this screen and can be exported as CSV.");
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
    expect(screen.getByRole("table", { name: "Single requests" })).toBeInTheDocument();
    expect(getTaskSnapshot().find((task) => task.id === "performance-benchmark-active")?.state).toBe("completed");
  });

  it("offers one file export and no redundant history selector for the only current result", async () => {
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    const exportButton = await screen.findByRole("button", { name: "Export CSV" });
    expect(screen.queryByRole("button", { name: "Export all history" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Result history" })).not.toBeInTheDocument();
    fireEvent.click(exportButton);
    const saved = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]");
    expect(saved).toHaveLength(1);
    expect(csv).toHaveBeenCalledWith(saved);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:benchmark");
  });

  it("keeps current and history exports separate when the new result could not be saved", async () => {
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByRole("button", { name: "Export CSV" });
    const prior = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByText("The result could not be saved to history. It remains on this screen and can be exported as CSV.");
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Export CSV" }));
    expect(csv.mock.calls[0][0]).toHaveLength(1);
    expect(csv.mock.calls[0][0][0].id).not.toBe(prior[0].id);
    fireEvent.click(screen.getByRole("button", { name: "Export all history" }));
    expect(csv.mock.calls[1][0]).toEqual(prior);
    expect(within(screen.getByRole("combobox", { name: "Result history" })).getAllByRole("option")).toHaveLength(2);
  });

  it("loads saved results, shows matching speedups, and copies raw trials", async () => {
    const request: api.PerformanceBenchmarkRequest = { run_id: "saved", prompt_lengths: [4096], generation_length: 128, batch_sizes: [2], repetitions: 1, context_profile: "novel_ko", warmup: true };
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 1, id: "saved", createdAt: 1, model: cfg.active_model, backend: "cpu", build: "b1", request, result: result("saved", [row(), row({ id: "batch", concurrency: 2, completion_tokens: 256, tg_tps: 180 })]) };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([saved]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPanel();
    expect(screen.getByRole("button", { name: "Export all history" })).toBeEnabled();
    fireEvent.change(screen.getByRole("combobox", { name: "Result history" }), { target: { value: "saved" } });
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Export all history" })).not.toBeInTheDocument();
    expect(screen.getByText("1.80×")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Single requests" })).getByText("N/A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy results" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('"novel_ko"');
    expect(writeText.mock.calls[0][0]).toContain('"batch"');
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it("localizes loading and cleanup progress instead of showing backend English messages", async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<I18nProvider initialLocale="ko"><BenchPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "벤치마크 실행" }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    act(() => emit({ run_id: request.run_id, phase: "loading", completed: 0, total: 6, message: "Loading benchmark server" }));
    expect(screen.getAllByText("모델 준비 중…").length).toBeGreaterThan(0);
    expect(screen.queryByText("Loading benchmark server")).not.toBeInTheDocument();
    act(() => emit({ run_id: request.run_id, phase: "cleanup", completed: 6, total: 6, message: "Stopping benchmark server" }));
    expect(screen.getAllByText("벤치마크 마무리 중…").length).toBeGreaterThan(0);
    expect(getTaskSnapshot().find((task) => task.id === "performance-benchmark-active")?.phase).toBe("벤치마크 마무리 중…");
    await act(async () => finish(result(request.run_id)));
  });

  it("separates a failed current run from saved success and exports every history record", async () => {
    const request: api.PerformanceBenchmarkRequest = { run_id: "previous", prompt_lengths: [4096], generation_length: 128, batch_sizes: [2], repetitions: 2, context_profile: "code_python", warmup: true };
    const previous: PerformanceBenchmarkRecord = { schemaVersion: 1, id: "previous", createdAt: 1, model: cfg.active_model, backend: "cpu", build: "b1", request, result: result("previous", [row()]) };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([previous]));
    mocked.runPerformanceBench.mockRejectedValue(new Error("Current benchmark failed to start"));
    renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current benchmark failed to start");
    expect(within(screen.getByRole("combobox", { name: "Result history" })).getAllByRole("option")).toHaveLength(2);
    fireEvent.change(screen.getByRole("combobox", { name: "Result history" }), { target: { value: "previous" } });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Current benchmark failed to start")).not.toBeInTheDocument();
    const disclosure = screen.getByText("Run configuration").closest("details")!;
    fireEvent.click(screen.getByText("Run configuration"));
    expect(within(disclosure).getByText("llama-test")).toBeVisible();
    expect(within(disclosure).getByText("32,768")).toBeVisible();
    expect(within(disclosure).getByText("Enabled")).toBeVisible();
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Export all history" }));
    expect(csv).toHaveBeenCalledOnce();
    expect(csv.mock.calls[0][0]).toHaveLength(2);
    expect(csv.mock.calls[0][0].map((item) => item.result.status)).toEqual(["failed", "complete"]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:benchmark");
  });
});
