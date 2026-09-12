import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import BenchPanel from "./Bench";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";

vi.mock("../../shared/api/index", () => ({
  deviceProfile: vi.fn(),
  onBenchmarkProgress: vi.fn(),
  runBench: vi.fn(),
  benchCancel: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const cfg = {
  config_version: 1,
  models_dir: "",
  port: 8080,
  ngl: 0,
  ctx_size: 4096,
  batch_size: 2048,
  ubatch_size: 512,
  keep: 0,
  cache_type_k: "f16",
  cache_type_v: "f16",
  flash_attn: "auto",
  n_cpu_moe: 0,
  threads: 8,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  spec_type: "none",
  spec_draft_n_max: 3,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0.1,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "auto",
  reasoning_format: "auto",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "auto",
  server_args: [],
  chat_options: {},
  mmproj: "",
  active_model: "C:/models/test.gguf",
  active_backend: "cpu",
  active_build: "b1",
  iters: 3,
  parallel: 0,
  request_timeout_seconds: 3600,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies api.AppConfig;

const store = {
  cfg,
  status: { state: "stopped" },
  busy: false,
  refreshStatus: async () => undefined,
} as unknown as AppStore;

function renderPanel() {
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(BenchPanel, { store }) }));
}

describe("BenchPanel streaming rows", () => {
  it("hides prefixes in saved failure history without rewriting it", async () => {
    const raw = String.raw`\\?\C:\models\missing.gguf`;
    const history = JSON.stringify([{ schemaVersion: 1, id: 'failed', createdAt: 0, model: raw,
      status: 'failed', rows: [], error: `Cannot load ${raw}` }]);
    localStorage.setItem('aiolm-benchmark-history.v1', history);
    try {
      const { container } = renderPanel();
      await screen.findByText(String.raw`Cannot load C:\models\missing.gguf`);
      expect(container.textContent).not.toContain('\\\\?\\');
      expect(localStorage.getItem('aiolm-benchmark-history.v1')).toBe(history);
    } finally {
      localStorage.removeItem('aiolm-benchmark-history.v1');
    }
  });

  let emitProgress: ((progress: api.BenchmarkProgress) => void) | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    emitProgress = undefined;
    mocked.deviceProfile.mockResolvedValue(null);
    mocked.onBenchmarkProgress.mockImplementation(async (callback: (progress: api.BenchmarkProgress) => void) => {
      emitProgress = callback;
      return () => undefined;
    });
    // Never resolves on its own: the test drives progress via emitProgress
    // and inspects state while the run is still active.
    mocked.runBench.mockImplementation(() => new Promise(() => undefined));
  });

  it("renders each honest row event as it streams in, without duplicating repeats", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Run benchmark" }));
    await waitFor(() => expect(emitProgress).toBeTypeOf("function"));

    act(() => {
      emitProgress?.({ row: { test: "pp512", size: "512", batch: "512", tps: 100 } });
    });
    expect(await screen.findByText("pp512")).toBeInTheDocument();

    // A repeated identical row (e.g. a re-emitted final line) must not add a
    // second row to the table.
    act(() => {
      emitProgress?.({ row: { test: "pp512", size: "512", batch: "512", tps: 100 } });
    });
    expect(screen.getAllByText("pp512")).toHaveLength(1);

    act(() => {
      emitProgress?.({ row: { test: "tg128", size: "128", batch: "128", tps: 42.5 } });
    });
    expect(await screen.findByText("tg128")).toBeInTheDocument();
    expect(screen.getByText("42.5")).toBeInTheDocument();
  });

  it('hides paths in partial-run status messages while preserving saved diagnostics', async () => {
    const raw = String.raw`\\?\C:\models\test.gguf`;
    const message = `Partial result for ${raw}`;
    mocked.runBench.mockResolvedValue({ rows: [], status: 'partial', message, args: ['-m', raw] });
    const { container } = renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Run benchmark' }));
    const display = String.raw`Partial result for C:\models\test.gguf`;
    await waitFor(() => expect(screen.getAllByText(display).length).toBeGreaterThan(0));
    expect(container.textContent).not.toContain('\\\\?\\');
    const history = JSON.parse(localStorage.getItem('aiolm-benchmark-history.v1') ?? '[]');
    expect(history[0].error).toBe(message);
    expect(history[0].model).toBe(cfg.active_model);
  });
});
