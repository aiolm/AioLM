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

import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  deviceProfile: vi.fn(), onPerformanceBenchmarkProgress: vi.fn(), runPerformanceBench: vi.fn(), benchCancel: vi.fn(),
  performanceBenchAdmission: vi.fn(),
  sessionList: vi.fn(async () => []), normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []), sessionStop: vi.fn(async () => undefined),
  sessionSummaryList: vi.fn(async () => []),
  isNativeRuntimeAvailable: () => false,
  providerRuntimes: vi.fn(async () => []), providerOptionSchema: vi.fn(async () => effectiveSchema([])),
  runtimeHelpTarget: vi.fn(), runtimeHelpDiscoverSelected: vi.fn(), runtimeHelpAccept: vi.fn(),
  runtimeHelpCancelSelected: vi.fn(async () => true),
}));

const cfg = { active_model: "C:/models/test.gguf", active_backend: "cpu", active_build: "b1", iters: 3, runtime_defaults: [] } as unknown as api.AppConfig;
let store: AppStore;
let emit: (event: api.PerformanceBenchmarkProgress) => void;
const unlisten = vi.fn();
const mocked = vi.mocked(api);

function row(overrides: Partial<api.PerformanceBenchmarkRow> = {}): api.PerformanceBenchmarkRow {
  const output = overrides.max_output_tokens ?? 1024;
  const concurrency = overrides.concurrency ?? 1;
  return { id: "single-4096-1", input_bytes: 4096, max_output_tokens: output, concurrency, repetition: 1,
    first_output_ms: 50, first_content_ms: 100, first_reasoning_ms: 50, e2e_ms: 200,
    content_bytes: 6, reasoning_bytes: 6, output_bytes: 12, reported_prompt_tokens: null, reported_completion_tokens: output * concurrency,
    reported_completion_tokens_by_request: Array(concurrency).fill(output), reported_cached_tokens: null,
    usage_status: 'partial', finish_reasons: Array(concurrency).fill('length'), peak_memory_bytes: null, timing_source: 'client', failed: false, ...overrides };
}
function result(runId: string, rows: api.PerformanceBenchmarkRow[] = [], status: api.PerformanceBenchmarkResult["status"] = "complete"): api.PerformanceBenchmarkResult {
  const request = mocked.runPerformanceBench.mock.calls.find(([, request]) => request.run_id === runId)?.[1]
    ?? { run_id: runId, method: { id: 'openai-chat-serving', version: 2 }, context_profile: 'code_python', prompt_bytes: [4096], max_output_tokens: 1024, concurrencies: [1], repetitions: 1, warmup: true, request_usage: true } satisfies api.PerformanceBenchmarkRequest;
  const measurements = status === 'complete' ? request.prompt_bytes.flatMap(bytes => request.concurrencies.flatMap(concurrency =>
    Array.from({ length: request.repetitions }, (_, i) => rows.find(row => row.input_bytes === bytes && row.concurrency === concurrency && row.repetition === i + 1)
      ?? row({ id: `${bytes}/${concurrency}/${i + 1}`, input_bytes: bytes, concurrency, repetition: i + 1, max_output_tokens: request.max_output_tokens, finish_reasons: Array.from({ length: concurrency }, () => 'not_reported') })))) : rows;
  return { run_id: runId, rows: measurements, status, args: ["-m", cfg.active_model], provenance: {
    schema_version: 2, app_version: '0.3.5', method: request.method, recorded_model_label: 'test.gguf',
    workload: { corpus: request.context_profile, corpus_version: 1, inputs: request.prompt_bytes.map(bytes => ({ bytes, sha256: 'a'.repeat(64) })),
      max_output_tokens: request.max_output_tokens, concurrencies: request.concurrencies, repetitions: request.repetitions, warmup: request.warmup, request_usage: request.request_usage, cache_policy: 'as_configured' },
    runtime: { name: null, version: null, backend: null, build: null, variant: null, plugin_version: null },
    model: { format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null },
    environment: { scope: 'aiolm_host', os: 'test', arch: 'arm64', cpu: { name: 'Synthetic CPU', logical_cores: 8 }, installed_gpus: [],
      execution: { mode: 'unknown', selected_gpus: [], devices: [], selection_complete: false }, detection: 'fixture' },
    execution: { topology: 'attached', memory_scope: 'unavailable', settings: [
      { target: 'request', scope: [], name: 'ignore_eos', value: true, unit: null, role: null },
      { target: 'request', scope: [], name: 'max_tokens', value: request.max_output_tokens, unit: 'tokens', role: null },
      { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
      ...(request.request_usage ? [{ target: 'request' as const, scope: [], name: 'stream_options.include_usage', value: true, unit: null, role: null }] : []),
      { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
    ] },
  } };
}
function legacyRow(overrides: Partial<api.LegacyPerformanceBenchmarkRow> = {}): api.LegacyPerformanceBenchmarkRow {
  return { id: 'legacy', prompt_tokens: 4096, generation_length: 128, concurrency: 1, repetition: 1, completion_tokens: 128, cached_tokens: 0,
    ttft_ms: 100, tpot_ms: 10, pp_tps: 40960, tg_tps: 100, e2e_ms: 1380, total_tps: 92.8, peak_memory_bytes: null, timing_source: 'client', ...overrides };
}
function legacyResult(runId: string, rows = [legacyRow()]): api.LegacyPerformanceBenchmarkResult {
  return { run_id: runId, rows, status: 'complete', args: [], runtime_version: 'llama-test', context_size: 32768, parallel: 4 };
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
  mocked.sessionSummaryList.mockImplementation(async () => mocked.normalizeSessionList(await mocked.sessionList()));
  localStorage.clear();
  for (const task of getTaskSnapshot()) removeTask(task.id);
  store = { cfg, status: { state: "stopped" }, busy: false, updateConfig: vi.fn(), refreshStatus: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined) } as unknown as AppStore;
  mocked.deviceProfile.mockResolvedValue(null as unknown as api.DeviceReport);
  mocked.onPerformanceBenchmarkProgress.mockImplementation(async (callback) => { emit = callback; return unlisten; });
  mocked.benchCancel.mockResolvedValue(undefined);
  mocked.performanceBenchAdmission.mockResolvedValue({ status: 'supported', reason: 'ready' });
  mocked.providerOptionSchema.mockResolvedValue(effectiveSchema([]));
  mocked.runtimeHelpTarget.mockReset();
  mocked.runtimeHelpDiscoverSelected.mockReset();
  mocked.runtimeHelpAccept.mockReset();
  mocked.runPerformanceBench.mockImplementation(async (_cfg, request) => result(request.run_id, [row()]));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Performance benchmark workflow", () => {

  it('lets a narrow serving result table reveal observed metrics with the keyboard', async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    const table = (await screen.findByRole('table', { name: 'API serving results' })).parentElement!;
    Object.defineProperties(table, { clientWidth: { configurable: true, value: 320 }, scrollWidth: { configurable: true, value: 960 } });
    fireEvent(window, new Event('resize'));
    table.focus();
    fireEvent.keyDown(table, { key: 'ArrowRight' });
    expect(table.scrollLeft).toBeGreaterThan(0);
    expect(within(table).getByRole('columnheader', { name: /First observed reasoning/ })).toBeVisible();
    expect(within(table).getByRole('columnheader', { name: /Observed output/ })).toBeVisible();
    fireEvent.keyDown(table, { key: 'End' });
    expect(table.scrollLeft).toBe(640);
    fireEvent.keyDown(table, { key: 'Home' });
    expect(table.scrollLeft).toBe(0);
  });

  const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, value) => value, getRequestProfile: () => null };

  it('can retry unknown support without starting or modifying the target', async () => {
    mocked.performanceBenchAdmission.mockRejectedValueOnce(new Error('Metadata temporarily unavailable'));
    renderPanel();
    expect(await screen.findByText(/Benchmark support is not verified/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('unblocks the unchanged benchmark target after reviewing its refreshed runtime options', async () => {
    const selected = assignedConfig({
      active_provider: 'custom.benchmark', active_runtime: 'synthetic-build',
      provider_options: { 'custom.benchmark': { limit: 7 } },
    });
    store = { ...store, cfg: selected.config };
    const saved = structuredClone(selected.config);
    let accepted = false;
    const option = schemaOption({ key: 'limit', flag: '--limit', target: 'launch', group: 'runtime', kind: { type: 'integer' } });
    const current = effectiveSchema([], [option]);
    mocked.providerOptionSchema.mockImplementation(async () => accepted ? current : { ...current, help_state: 'stale' });
    mocked.performanceBenchAdmission.mockImplementation(async () => accepted
      ? { status: 'supported', reason: 'ready' }
      : { status: 'unknown', reason: 'configuration', detail: 'Saved runtime help needs review' });
    const fingerprint = 'a'.repeat(64);
    const request = { args: ['--help'], scope: [] };
    mocked.runtimeHelpTarget.mockResolvedValue({
      engine: 'custom.benchmark', runtime: 'synthetic-build', program: 'synthetic-engine', fixed: true, prefix: [], request,
    });
    mocked.runtimeHelpDiscoverSelected.mockResolvedValue([{
      identity: { fingerprint, executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 },
      scope: [], stdout: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
      stderr: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false },
      success: true, cancelled: false, timed_out: false, elapsed_ms: 1,
    }, {
      engine: 'custom.benchmark', runtime: 'synthetic-build', fingerprint, help_complete: true, schema: current.schema,
      retained: [], diff: { added: [], removed: [], changed: ['limit'], retained_unknown: [] },
    }]);
    mocked.runtimeHelpAccept.mockImplementation(async () => {
      accepted = true;
      return { version: 1, fingerprint, request };
    });
    renderPanel();
    await screen.findByText(/Benchmark support is not verified/);
    const run = screen.getByRole('button', { name: 'Run benchmark' });
    expect(run).toBeDisabled();
    const environment = screen.getByRole('region', { name: 'Execution environment' });
    fireEvent.click(within(environment).getByText('Key settings', { selector: 'summary' }));
    const recheck = await within(environment).findByRole('button', { name: 'Recheck options' });
    await waitFor(() => expect(recheck).not.toHaveAttribute('aria-disabled', 'true'));
    fireEvent.click(recheck);
    const accept = await within(environment).findByRole('button', { name: 'Use these options' });
    expect(run).toBeDisabled();
    fireEvent.click(accept);
    await waitFor(() => expect(run).toBeEnabled());
    expect(await within(environment).findByText('--limit')).toBeVisible();
    expect(store.cfg).toEqual(saved);
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
  });

  it.each([
    ['en', 'Run benchmark', /cannot force an exact output token count/],
    ['ko', '벤치마크 실행', /정확한 출력 토큰 수를 강제할 수 없습니다/],
    ['ja', 'ベンチマークを実行', /正確な出力トークン数を強制できません/],
    ['zh', '运行基准测试', /无法强制生成精确的输出令牌数/],
  ] as const)('blocks unsupported fixed output with an explanation in %s', async (locale, runLabel, reason) => {
    mocked.performanceBenchAdmission.mockResolvedValue({ status: 'unsupported', reason: 'fixed_output' });
    render(<I18nProvider initialLocale={locale}><BenchPanel store={store} /></I18nProvider>);
    expect(await screen.findByText(reason)).toBeVisible();
    const run = screen.getByRole('button', { name: runLabel });
    expect(run).toBeDisabled();
    fireEvent.click(run);
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBeNull();
  });

  it('keeps the current target blocked while pending and ignores an older supported reply', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const replies: Array<(value: api.PerformanceBenchmarkAdmission) => void> = [];
    // This project targets ES2020, before Promise.withResolvers.
    mocked.performanceBenchAdmission.mockImplementation(() => new Promise(resolve => replies.push(resolve)));
    renderPanel();
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
    await waitFor(() => expect(replies).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'Model settings' }));
    const edit = vi.mocked(settings.open).mock.calls[0][0];
    const next = assignedConfig({ active_model: 'models/new-target.gguf' });
    store.cfg = { ...store.cfg!, settings_profiles: next.config.settings_profiles };
    await act(async () => { await edit.onApply?.(next.config, next.application); });
    await waitFor(() => expect(replies).toHaveLength(2));
    await act(async () => { replies[0]({ status: 'supported', reason: 'ready' }); });
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
    await act(async () => { replies[1]({ status: 'supported', reason: 'ready' }); });
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled();
  });

  it('offers safe configuration when target support cannot be verified', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    mocked.performanceBenchAdmission.mockRejectedValueOnce(new Error('Probe metadata unavailable'));
    renderPanel();
    expect(await screen.findByText(/Benchmark support is not verified/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Configure benchmark target' }));
    expect(vi.mocked(settings.open).mock.calls[0][0].target.kind).toBe('benchmark');
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
  });

  it('does not add rejected unstarted attempts to saved measurement history', async () => {
    mocked.runPerformanceBench.mockRejectedValue(new Error('Fixed output admission rejected'));
    renderPanel();
    for (let attempt = 0; attempt < 2; attempt++) {
      await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('Fixed output admission rejected');
      await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    }
    expect(mocked.runPerformanceBench).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export result' })).not.toBeInTheDocument();
  });

  it('confirms deletion, selects a remaining result and clears the last result from storage and the screen', async () => {
    const request: api.LegacyPerformanceBenchmarkRequest = { run_id: 'older', context_profile: 'novel_en', prompt_lengths: [4096], generation_length: 128, batch_sizes: [], repetitions: 1, warmup: true };
    const older: PerformanceBenchmarkRecord = { schemaVersion: 1, id: 'older', createdAt: 1, model: 'models/older.gguf', backend: 'cpu', build: 'b1', request, result: legacyResult('older') };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([older]));
    const { unmount } = renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    const remove = await screen.findByRole('button', { name: 'Delete result' });
    fireEvent.click(screen.getByText('Export and manage'));
    expect(remove).toBeVisible();
    await waitFor(() => expect(remove).toBeEnabled());
    expect(performanceRecords.readPerformanceHistory()).toHaveLength(2);
    fireEvent.click(remove);
    let dialog = screen.getByRole('dialog', { name: 'Delete this result?' });
    expect(dialog).toHaveTextContent('test.gguf');
    expect(dialog).not.toHaveTextContent('C:/models');
    expect(dialog).toHaveTextContent('Results shared on the website and their management access are kept.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(performanceRecords.readPerformanceHistory()).toHaveLength(2);
    fireEvent.click(remove);
    dialog = screen.getByRole('dialog', { name: 'Delete this result?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete result' }));
    await screen.findByText('Result deleted.');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(performanceRecords.readPerformanceHistory()).toEqual([older]);
    expect(screen.getByRole('combobox', { name: 'Result history' })).toHaveTextContent('older.gguf');
    fireEvent.click(screen.getByRole('button', { name: 'Delete result' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete result' }));
    await screen.findByText('No results yet');
    expect(performanceRecords.readPerformanceHistory()).toEqual([]);
    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByText('Run configuration')).not.toBeInTheDocument();
    unmount();
    renderPanel();
    expect(screen.queryByRole('combobox', { name: 'Result history' })).not.toBeInTheDocument();
  });

  it("applies a benchmark model independently and freezes its configuration for a run", async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
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
    expect(screen.getByRole("button", { name: "Model settings" })).toBeDisabled();
    expect(screen.getByRole('region', { name: 'Execution environment' })).toHaveTextContent(application.profile_name!);
    expect(within(screen.getByRole('region', { name: 'Execution environment' })).getByText('GPU layers').nextSibling).toHaveTextContent(String(runConfig.ngl));
    expect(runConfig.server_args).toEqual(["--no-mmap"]);
    await act(async () => finish(result(runRequest.run_id, [row()])));
    const record = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]")[0];
    expect(record.model).toBe("models/benchmark.gguf");
    expect(screen.getByTitle("models/benchmark.gguf")).toBeVisible();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('offers one model settings entry point instead of a dropdown-style model button beside it', () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    renderPanel();
    const entry = screen.getByRole('button', { name: 'Model settings' });
    expect(screen.queryByRole('button', { name: /^Choose model/ })).not.toBeInTheDocument();
    expect(screen.queryByText('▾')).not.toBeInTheDocument();
    // The model is plain identity text; only the explicit settings button is interactive.
    expect(screen.getByText('test.gguf').closest('button')).toBeNull();
    fireEvent.click(entry);
    expect(settings.open).toHaveBeenCalledTimes(1);
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: expect.objectContaining({ kind: 'benchmark' }), section: 'model' }));
  });

  it('places CPU specifications with the selected profile instead of the page heading', async () => {
    const selected = assignedConfig({ ngl: 12, threads: 6 });
    store.cfg = selected.config;
    mocked.deviceProfile.mockResolvedValue({ profile: { cpu: { name: 'Example Processor', logical_cores: 12, physical_cores: 6 }, gpus: [] }, system_memory_bytes: 32 * 1024 ** 3, backends: [] } as unknown as api.DeviceReport);
    renderPanel();
    const summary = screen.getByRole('region', { name: 'Execution environment' });
    await waitFor(() => expect(summary).toHaveTextContent('Example Processor'));
    expect(summary).toHaveTextContent(selected.profile.name);
    expect(summary).toHaveTextContent('32.00 GiB RAM');
    expect(screen.getByRole('heading', { name: 'Benchmark' }).closest('header')).not.toHaveTextContent('Example Processor');
    expect(within(summary).getByText('GPU layers').nextSibling).toHaveTextContent('12');
    expect(within(summary).getByText('CPU threads').nextSibling).toHaveTextContent('6');
  });

  it('reopens and runs the selected profile at its latest saved revision without changing workload controls', async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const original = assignedConfig({ ngl: 4, ctx_size: 8192, temperature: 0.2 });
    store.cfg = original.config;
    let current = original.config;
    store.getConfig = () => current;
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: "Model settings" }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.application).toMatchObject({ profile_id: original.profile.id, profile_revision: 1 });
    await act(async () => { await request.onApply?.(original.config, original.application); });
    const revised = { ...original.profile, revision: 2, settings: { ...original.profile.settings, ngl: 12, ctx_size: 32768, temperature: 1.2 }, system_prompt: 'Updated saved prompt' };
    current = { ...original.config, settings_profiles: { ...original.config.settings_profiles!, revision: 2, entries: [revised] } };
    fireEvent.click(screen.getByRole('button', { name: "Model settings" }));
    const reopened = vi.mocked(settings.open).mock.calls[1][0];
    expect(reopened.application).toMatchObject({ profile_id: original.profile.id, profile_revision: 2, system_prompt: 'Updated saved prompt' });
    expect(reopened.config).toMatchObject({ ngl: 12, ctx_size: 32768, temperature: 1.2 });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const runConfig = mocked.runPerformanceBench.mock.calls[0][0];
    expect(runConfig).toMatchObject({ ngl: 12, ctx_size: 32768, temperature: 1.2 });
    expect(runConfig.settings_profiles?.applied[profileTargetKey(runConfig.active_model)]).toMatchObject({ profile_id: revised.id, profile_revision: 2 });
    expect(runConfig.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')[0]).toEqual({ ...revised, provider: 'llama.cpp' });
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
    expect(runConfig).toMatchObject({ active_model: original.config.active_model, ngl: 16, ctx_size: 16384, temperature: 0.7 });
    expect(runConfig.settings_profiles?.applied[profileTargetKey(runConfig.active_model)]).toMatchObject({ profile_id: 'profile-fallback' });
    expect(runConfig.settings_profiles?.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp').map(profile => profile.id)).toEqual(['profile-fallback']);
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
    fireEvent.click(screen.getByRole('button', { name: "Model settings" }));
    const target = { ...alternate.config, settings_profiles: original.config.settings_profiles };
    await act(async () => { await vi.mocked(settings.open).mock.calls[0][0].onApply?.(target, alternate.application); });
    fireEvent.click(screen.getByRole('button', { name: 'Use default execution settings' }));
    fireEvent.click(screen.getByRole('button', { name: "Model settings" }));
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
    fireEvent.click(screen.getByRole('button', { name: "Model settings" }));
    expect(vi.mocked(settings.open).mock.calls[0][0].config).toMatchObject({ ngl: 12 });
  });

  it("disables the run button without a redundant setup-gap banner when no runtime is selected", async () => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, config) => config, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    renderPanel({ ...store, cfg: { ...cfg, active_backend: "", active_build: "" } } as AppStore);
    expect(await screen.findByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(screen.queryByText("No runtime is selected.")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ section: "model" }));
  });

  it("blocks measuring while a named session is running", async () => {
    vi.mocked(useModelSettings).mockReturnValue(settings);
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work", state: "running", model: "models/work.gguf" }]);
    renderPanel();
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    expect(mocked.sessionStop).not.toHaveBeenCalled();
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Model settings" }));
    expect(settings.open).toHaveBeenCalled();
    expect(mocked.sessionStop).not.toHaveBeenCalled();
  });


  it('measures and saves the selected workload while locking its controls during a run', async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    const corpus = screen.getByRole('combobox', { name: 'Prompt content' });
    const outputTokens = screen.getByRole('combobox', { name: 'Output tokens' });
    const repetitions = screen.getByRole('combobox', { name: 'Repetitions' });
    fireEvent.click(corpus);
    fireEvent.click(screen.getByRole('option', { name: 'Prose · Korean' }));
    fireEvent.click(outputTokens);
    fireEvent.click(screen.getByRole('option', { name: '200k' }));
    fireEvent.click(repetitions);
    fireEvent.click(screen.getByRole('option', { name: '3' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    expect(corpus).toBeDisabled();
    expect(outputTokens).toBeDisabled();
    expect(repetitions).toBeDisabled();
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    await act(async () => finish(result(request.run_id, [row({ max_output_tokens: 204800 })])));
    const [saved] = performanceRecords.readPerformanceHistory();
    expect(saved.request).toMatchObject({ method: { version: 2 }, context_profile: 'novel_ko', max_output_tokens: 204800, repetitions: 3, request_usage: true });
    expect(saved.result.rows).toHaveLength(18);
    expect(outputTokens).toBeEnabled();
    expect(repetitions).toBeEnabled();
  });

  it("requires an input size and the loaded model to unload before measuring", async () => {
    const { rerender } = renderPanel();
    fireEvent.click(screen.getByRole("checkbox", { name: "4,096" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "16,384" }));
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    fireEvent.click(screen.getByRole("checkbox", { name: "4,096" }));
    rerender(<I18nProvider initialLocale="en"><BenchPanel store={{ ...store, status: { state: "running" } }} /></I18nProvider>);
    expect(screen.getByRole("button", { name: "Run benchmark" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Unload model" }));
    await waitFor(() => expect(store.stop).toHaveBeenCalledOnce());
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
  });

  it("subscribes before starting and ignores events from another run", async () => {
    let ready!: (value: () => void) => void;
    mocked.onPerformanceBenchmarkProgress.mockImplementation((callback) => { emit = callback; return new Promise((resolve) => { ready = resolve; }); });
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    expect(mocked.runPerformanceBench).not.toHaveBeenCalled();
    await act(async () => { ready(unlisten); });
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    act(() => emit({ run_id: "another-run", phase: "single", completed: 1, total: 6, row: row({ first_output_ms: 999 }) }));
    expect(screen.queryByText("999.0")).not.toBeInTheDocument();
    act(() => {
      emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() });
      emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() });
    });
    const table = screen.getByRole("table", { name: "API serving results" });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(Number(screen.getByRole("progressbar").getAttribute("value"))).toBeCloseTo(100 / 6);
    await act(async () => finish(result(request.run_id, [row()])));
  });

  it("shows one benchmark and preserves progress and cancelled partial results while the page is hidden", async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const page = (hidden: boolean) => <I18nProvider initialLocale="en"><div hidden={hidden}><BenchPanel store={store} /></div></I18nProvider>;
    const { rerender } = render(page(false));
    expect(screen.getByRole("heading", { name: "Benchmark" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    rerender(page(true));
    act(() => emit({ run_id: request.run_id, phase: "single", completed: 1, total: 6, row: row() }));
    rerender(page(false));
    expect(mocked.runPerformanceBench).toHaveBeenCalledOnce();
    expect(screen.getByRole("table", { name: "API serving results" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel benchmark" }));
    await waitFor(() => expect(mocked.benchCancel).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Cancelling…" })).toBeDisabled();
    const interrupted = row({ id: 'cancelled-batch', concurrency: 2, output_bytes: 4, error: 'connection closed' });
    act(() => emit({ run_id: request.run_id, phase: 'batch', completed: 2, total: 6, row: interrupted }));
    expect(screen.queryByRole('table', { name: 'Concurrent requests' })).not.toBeInTheDocument();
    await act(async () => finish(result(request.run_id, [row(), interrupted], "cancelled")));
    const saved = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]")[0];
    expect(saved.result.status).toBe("cancelled");
    expect(saved.result.rows).toHaveLength(1);
    expect(screen.queryByRole('table', { name: 'Concurrent requests' })).not.toBeInTheDocument();
    expect(getTaskSnapshot().find((task) => task.id === "performance-benchmark-active")?.state).toBe("cancelled");
  });

  it('leaves no result or export controls when cancelled before a measurement completes', async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await waitFor(() => expect(mocked.runPerformanceBench).toHaveBeenCalledOnce());
    const request = mocked.runPerformanceBench.mock.calls[0][1];
    fireEvent.click(screen.getByRole('button', { name: 'Cancel benchmark' }));
    await act(async () => finish(result(request.run_id, [], 'cancelled')));
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Export result' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy Markdown' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Result history' })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? '[]')).toEqual([]);
    expect(screen.getByText('No results yet')).toBeVisible();
    expect(getTaskSnapshot().find(task => task.id === 'performance-benchmark-active')?.state).toBe('cancelled');
  });

  it('keeps recorded model, source and runtime identity after the selected model changes', async () => {
    mocked.runPerformanceBench.mockImplementationOnce(async (_config, request) => {
      const measured = result(request.run_id, [row()]);
      measured.provenance!.recorded_model_label = 'Frozen model label';
      measured.provenance!.runtime = { name: 'sglang', version: 'recorded-version', backend: null, build: 'recorded-build', variant: null, plugin_version: null };
      measured.provenance!.model = { format: 'hf-safetensors', status: 'unidentified', sha256: null, size_bytes: null, repository: 'example/recorded-model', revision: 'a'.repeat(40) };
      return measured;
    });
    const { rerender } = renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await screen.findByRole('button', { name: 'Export result' });
    rerender(<I18nProvider initialLocale="en"><BenchPanel store={{ ...store, cfg: { ...cfg, active_model: 'models/replaced.gguf', active_build: 'replacement-build' } }} /></I18nProvider>);
    expect(screen.getByText('Frozen model label')).toBeVisible();
    const configuration = screen.getByText('Run configuration').closest('details')!;
    expect(configuration).toHaveTextContent('recorded-version');
    expect(configuration).toHaveTextContent('recorded-build');
    expect(configuration).toHaveTextContent('example/recorded-model');
    expect(configuration).toHaveTextContent('a'.repeat(40));
    expect(configuration).not.toHaveTextContent('replacement-build');
    expect(configuration).not.toHaveTextContent('models/replaced.gguf');
    expect(configuration).toHaveTextContent('unavailable');
    expect(screen.getByRole('button', { name: 'Export result' })).toBeEnabled();
  });

  it("keeps successful measurements exportable when history storage is unavailable", async () => {
    renderPanel();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByText("The result could not be saved to history. It remains on this screen and can be exported to a file.");
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
    expect(screen.getAllByRole("table", { name: "API serving results" }).length).toBeGreaterThan(0);
    expect(getTaskSnapshot().find((task) => task.id === "performance-benchmark-active")?.state).toBe("completed");
  });

  it('retains unreadable browser history and offers the current successful measurement for export', async () => {
    const original = '{unreadable-history-kept-for-recovery';
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, original);
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Run benchmark' }));
    await screen.findByText('The result could not be saved to history. It remains on this screen and can be exported to a file.');
    expect(localStorage.getItem(PERFORMANCE_HISTORY_KEY)).toBe(original);
    expect(screen.getByRole('button', { name: 'Export result' })).toBeEnabled();
    expect(within(screen.getByRole('table', { name: 'API serving results' })).getAllByText('60.0').length).toBeGreaterThan(0);
  });

  it("offers one file export and no redundant history selector for the only current result", async () => {
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    const exportButton = await screen.findByRole("button", { name: "Export result" });
    fireEvent.click(screen.getByText("Export and manage"));
    expect(exportButton).toBeVisible();
    expect(screen.queryByRole("button", { name: "Export all history" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Result history" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("combobox", { name: "Export format" }));
    fireEvent.click(screen.getByRole("option", { name: "CSV (.csv)" }));
    fireEvent.click(exportButton);
    const saved = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]");
    expect(saved).toHaveLength(1);
    expect(csv).toHaveBeenCalledWith(saved, "en");
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    expect(await screen.findByText("Download started.")).toBeVisible();
  });

  it("shows one effective llama-server argument per line and keeps each option with its value", async () => {
    mocked.runPerformanceBench.mockImplementation(async (_cfg, request) => ({
      ...result(request.run_id, [row()]),
      args: ["--model", "C:/models/test.gguf", "--ctx-size", "4096", "--sleep-idle-seconds", "-1", "--cont-batching", "--no-webui"],
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    const summary = await screen.findByText("Effective runtime arguments");
    fireEvent.click(summary);
    // A negative value belongs to its option; a switch stays on a line of its own.
    expect(summary.parentElement?.querySelector("code")?.textContent).toBe([
      '"--model" "C:/models/test.gguf"',
      '"--ctx-size" "4096"',
      '"--sleep-idle-seconds" "-1"',
      '"--cont-batching"',
      '"--no-webui"',
    ].join("\n"));
  });

  it("keeps current and history exports separate when the new result could not be saved", async () => {
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByRole("button", { name: "Export result" });
    const prior = JSON.parse(localStorage.getItem(PERFORMANCE_HISTORY_KEY) ?? "[]");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("QuotaExceededError"); });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    await screen.findByText("The result could not be saved to history. It remains on this screen and can be exported to a file.");
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("combobox", { name: "Export format" }));
    fireEvent.click(screen.getByRole("option", { name: "CSV (.csv)" }));
    fireEvent.click(screen.getByRole("button", { name: "Export result" }));
    expect(csv.mock.calls[0][0]).toHaveLength(1);
    expect(csv.mock.calls[0][0][0].id).not.toBe(prior[0].id);
    await waitFor(() => expect(screen.getByRole("button", { name: "Export all history" })).toBeEnabled());
    fireEvent.click(screen.getByRole("combobox", { name: "Export format" }));
    fireEvent.click(screen.getByRole("option", { name: "CSV (.csv)" }));
    fireEvent.click(screen.getByRole("button", { name: "Export all history" }));
    await waitFor(() => expect(csv.mock.calls[1][0]).toEqual(prior));
    await waitFor(() => expect(screen.getByRole("combobox", { name: "Result history" })).toBeEnabled());
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
  });

  it("loads saved results, shows matching speedups, and copies Markdown tables", async () => {
    const request: api.LegacyPerformanceBenchmarkRequest = { run_id: "saved", prompt_lengths: [4096], generation_length: 128, batch_sizes: [2], repetitions: 1, context_profile: "novel_ko", warmup: true };
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 1, id: "saved", createdAt: 1, model: cfg.active_model, backend: "cpu", build: "b1", request, result: legacyResult("saved", [legacyRow(), legacyRow({ id: "batch", concurrency: 2, completion_tokens: 256, tg_tps: 180 })]) };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([saved]));
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    renderPanel();
    expect(screen.getByRole("button", { name: "Export all history" })).toBeEnabled();
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
    fireEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[1]);
    expect(screen.getByRole("button", { name: "Export result" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Export all history" })).not.toBeInTheDocument();
    expect(screen.getByText("1.80×")).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Single requests" })).getByText("N/A")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    expect(writeText.mock.calls[0][0]).toContain('|');
    expect(writeText.mock.calls[0][0]).not.toContain('run_id,created_at,model');
    expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
  });

  it.each(['success', 'failure'] as const)('ignores a delayed clipboard %s after selecting another history result', async ending => {
    const saved = (id: string): PerformanceBenchmarkRecord => ({
      schemaVersion: 1, id, createdAt: 1, model: `models/${id}.gguf`, backend: 'cpu', build: 'b1',
      request: { run_id: id, prompt_lengths: [4096], generation_length: 128, batch_sizes: [], repetitions: 1, context_profile: 'novel_ko', warmup: true },
      result: legacyResult(id),
    });
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([saved('first'), saved('second')]));
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const pending = new Promise<void>((done, fail) => { resolve = done; reject = fail; });
    const writeText = vi.fn().mockReturnValueOnce(pending).mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    renderPanel();
    const choose = (model: string) => {
      fireEvent.click(screen.getByRole('combobox', { name: 'Result history' }));
      fireEvent.click(screen.getByRole('option', { name: new RegExp(model) }));
    };
    choose('first.gguf');
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    expect(writeText.mock.calls[0][0]).toContain('first.gguf');
    const copying = screen.getByRole('button', { name: 'Copy Markdown' });
    expect(copying).toBeDisabled();
    fireEvent.click(copying);
    expect(writeText).toHaveBeenCalledOnce();
    choose('second.gguf');
    await act(async () => { if (ending === 'success') resolve(); else reject(new Error('Clipboard unavailable for first')); });
    expect(screen.queryByRole('button', { name: 'Copied' })).not.toBeInTheDocument();
    expect(screen.queryByText('Clipboard unavailable for first')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Copy Markdown' }));
    await screen.findByRole('button', { name: 'Copied' });
    expect(writeText.mock.calls[1][0]).toContain('second.gguf');
  });

  it("localizes loading and cleanup progress instead of showing backend English messages", async () => {
    let finish!: (value: api.PerformanceBenchmarkResult) => void;
    mocked.runPerformanceBench.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    render(<I18nProvider initialLocale="ko"><BenchPanel store={store} /></I18nProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: '벤치마크 실행' })).toBeEnabled());
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
    const request: api.LegacyPerformanceBenchmarkRequest = { run_id: "previous", prompt_lengths: [4096], generation_length: 128, batch_sizes: [2], repetitions: 2, context_profile: "code_python", warmup: true };
    const previous: PerformanceBenchmarkRecord = { schemaVersion: 1, id: "previous", createdAt: 1, model: cfg.active_model, backend: "cpu", build: "b1", request, result: legacyResult("previous") };
    localStorage.setItem(PERFORMANCE_HISTORY_KEY, JSON.stringify([previous]));
    mocked.runPerformanceBench.mockImplementationOnce(async (_cfg, request) => ({
      ...result(request.run_id, [], 'failed'), message: 'Current benchmark failed to start',
    }));
    renderPanel();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Run benchmark' })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Run benchmark" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Current benchmark failed to start");
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
    expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Result history" }));
    fireEvent.click(within(screen.getByRole("listbox")).getAllByRole("option")[1]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText("Current benchmark failed to start")).not.toBeInTheDocument();
    const disclosure = screen.getByText("Run configuration").closest("details")!;
    fireEvent.click(screen.getByText("Run configuration"));
    expect(within(disclosure).getByText("llama-test(1)")).toBeVisible();
    expect(within(disclosure).getByText("32,768")).toBeVisible();
    expect(within(disclosure).getByText("Enabled")).toBeVisible();
    const csv = vi.spyOn(performanceRecords, "performanceCsv");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = vi.fn(() => "blob:benchmark");
      static revokeObjectURL = vi.fn();
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("combobox", { name: "Export format" }));
    fireEvent.click(screen.getByRole("option", { name: "CSV (.csv)" }));
    fireEvent.click(screen.getByRole("button", { name: "Export all history" }));
    await waitFor(() => expect(csv).toHaveBeenCalledOnce());
    expect(csv.mock.calls[0][0]).toHaveLength(2);
    expect(csv.mock.calls[0][0].map((item) => item.result.status)).toEqual(["failed", "complete"]);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  });
});
