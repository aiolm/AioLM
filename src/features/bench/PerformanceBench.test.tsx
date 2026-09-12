import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import BenchPanel from "./Bench";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import { PERFORMANCE_HISTORY_KEY, type PerformanceBenchmarkRecord } from "./performanceRecords";
import * as performanceRecords from "./performanceRecords";

vi.mock("../../shared/api/index", () => ({
  deviceProfile: vi.fn(), onPerformanceBenchmarkProgress: vi.fn(), runPerformanceBench: vi.fn(), benchCancel: vi.fn(),
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

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  for (const task of getTaskSnapshot()) removeTask(task.id);
  store = { cfg, status: { state: "stopped" }, busy: false, refreshStatus: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) } as unknown as AppStore;
  mocked.deviceProfile.mockResolvedValue(null as unknown as api.DeviceReport);
  mocked.onPerformanceBenchmarkProgress.mockImplementation(async (callback) => { emit = callback; return unlisten; });
  mocked.benchCancel.mockResolvedValue(undefined);
  mocked.runPerformanceBench.mockImplementation(async (_cfg, request) => result(request.run_id, [row()]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Performance benchmark workflow", () => {
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
    expect(mocked.runPerformanceBench.mock.calls[0][0]).toEqual(cfg);
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

  it("loads saved results, shows matching speedups, and copies raw trials", async () => {
    const request: api.PerformanceBenchmarkRequest = { run_id: "saved", prompt_lengths: [4096], generation_length: 128, batch_sizes: [2], repetitions: 1, context_profile: "novel_ko", warmup: true };
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 1, id: "saved", createdAt: 1, model: cfg.active_model, backend: "cpu", build: "b1", request, result: result("saved", [row(), row({ id: "batch", concurrency: 2, completion_tokens: 256, tg_tps: 180 })]) };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([saved]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPanel();
    fireEvent.change(screen.getByRole("combobox", { name: "Result history" }), { target: { value: "saved" } });
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
