import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppConfig } from "../../shared/api/types";
import type { AppStore } from "../../shared/state/store";
import TuningPanel from "./Tuning";
import { withManualOverrides } from "../../shared/config/tuningDefaults";

const cfg: AppConfig = {
  config_version: 7,
  models_dir: "models",
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
  threads: 0,
  temperature: 0.8,
  top_p: 0.95,
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
  active_model: "model.gguf",
  active_backend: "cpu",
  active_build: "latest",
  iters: 5,
  parallel: 0,
  request_timeout_seconds: 3600,
  sleep_idle_seconds: -1,
  lora_adapters: [],
};

function store(): AppStore {
  return {
    cfg,
    status: { state: "stopped" },
    busy: false,
    bootError: null,
    bootState: "ready",
    actionError: null,
    statusPollError: null,
    getConfig: () => cfg,
    getConfigRevision: () => 1,
    loadConfig: vi.fn(async () => undefined),
    refreshStatus: vi.fn(async () => undefined),
    updateConfig: vi.fn(async () => cfg),
    start: vi.fn(async () => "http://127.0.0.1:8080/v1"),
    stop: vi.fn(async () => undefined),
    clearActionError: vi.fn(),
    clearErrors: vi.fn(),
  };
}

describe("TuningPanel phase-1 shell", () => {
  it.each([
    ['--mmproj', 'tuning-mmproj', 'mmproj'],
    ['--spec-draft-model', 'tuning-spec-draft-model', 'spec_draft_model'],
  ] as const)('keeps the original %s path on focus changes and saves deliberate edits', async (query, inputId, key) => {
    const raw = String.raw`\\?\UNC\server\models\vision.gguf`;
    const configured = { ...cfg, [key]: raw };
    const base = store();
    const save = vi.fn(async () => configured);
    render(<I18nProvider initialLocale="en"><TuningPanel store={{ ...base, cfg: configured, getConfig: () => configured, updateConfig: save }} /></I18nProvider>);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: query } });
    const input = document.getElementById(inputId)!;
    expect(input).toHaveValue(String.raw`\\server\models\vision.gguf`);
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(save).not.toHaveBeenCalled();
    expect(configured[key]).toBe(raw);
    fireEvent.change(input, { target: { value: 'C:/models/new.gguf' } });
    fireEvent.blur(input);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ [key]: 'C:/models/new.gguf' }));
  });

  it("opens the canonical parameter form without duplicate profile editors", () => {
    render(<I18nProvider initialLocale="en"><TuningPanel store={store()} /></I18nProvider>);
    expect(screen.queryByTestId("execution-profiles-section")).not.toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /GPU layers/i })).toBeInTheDocument();
  });
  it("starts in Quick mode and navigates to advanced speculative controls", () => {
    render(
      <I18nProvider initialLocale="en">
        <TuningPanel store={store()} />
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Runtime" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Execution profiles" })).not.toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Quick" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("button", { name: "Speculative" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Speculative" }));
    expect(screen.getByRole("heading", { name: "Speculative" })).toBeInTheDocument();
    expect(screen.getByLabelText("Speculative type(s)")).toBeInTheDocument();
    expect(screen.getAllByRole("tooltip").length).toBeGreaterThan(0);
  });
  it("searches Korean labels and finds advanced settings from Quick mode", () => {
    render(<I18nProvider initialLocale="ko"><TuningPanel store={store()} /></I18nProvider>);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "추론" } });
    expect(document.querySelector('[data-tuning-category="reasoning"]')).toBeInTheDocument();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "--spec-draft-model" } });
    expect(document.querySelector('[data-tuning-category="speculative"]')).toBeInTheDocument();
    expect(document.querySelector('#tuning-spec-draft-model')).toBeInTheDocument();
  });
  it("provides one restart action across parameter categories", () => {
    render(<I18nProvider initialLocale="en"><TuningPanel store={{ ...store(), status: { state: "running" } }} /></I18nProvider>);
    expect(screen.getAllByRole("button", { name: "Apply & restart server" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Reasoning" }));
    expect(screen.getAllByRole("button", { name: "Apply & restart server" })).toHaveLength(1);
  });
});

describe("Tuning defaults controls", () => {
  function renderLive(save?: (next: AppConfig) => Promise<AppConfig>) {
    const base = store();
    let latest = { ...cfg, ngl: 99, server_args: ["--min-p", "0.2"], chat_options: { min_p: 0.3 } } as AppConfig;
    const saveSpy = vi.fn(save ?? (async (next: AppConfig) => next));
    function Live() {
      const [current, setCurrent] = useState(latest);
      return <I18nProvider initialLocale="en"><TuningPanel store={{ ...base, cfg: current, updateConfig: async (patch) => {
        const next = { ...latest, ...withManualOverrides(latest, typeof patch === "function" ? patch(latest) : patch) };
        latest = await saveSpy(next);
        setCurrent(latest);
        return latest;
      } }} /></I18nProvider>;
    }
    render(<Live />);
    return { base, saveSpy, config: () => latest };
  }

  it("requires confirmation, supports cancelling, and resets all tuning only", async () => {
    const test = renderLive();
    fireEvent.click(screen.getByRole("button", { name: "Reset all tuning" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Cancel" }));
    expect(test.saveSpy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Reset all tuning" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Reset all tuning" }));
    await waitFor(() => expect(test.config().runtime_defaults).toContain("ngl"));
    expect(test.config().server_args).toEqual([]);
    expect(test.config().chat_options).toEqual({});
    expect(test.config().active_model).toBe(cfg.active_model);
    expect(test.config().active_backend).toBe(cfg.active_backend);
    expect(screen.getAllByText("Using llama.cpp default").length).toBeGreaterThan(0);
    expect(test.base.stop).not.toHaveBeenCalled();
    expect(test.base.start).not.toHaveBeenCalled();
  });

  it("resets one control and allows an explicit value to be entered again", async () => {
    const test = renderLive();
    const reset = screen.getByRole("button", { name: /Reset GPU layers.*to default/i });
    fireEvent.click(reset);
    await waitFor(() => expect(test.config().runtime_defaults).toEqual(["ngl"]));
    expect(test.config().server_args).toEqual(["--min-p", "0.2"]);
    expect(test.config().ctx_size).toBe(4096);
    const input = screen.getByRole("spinbutton", { name: /GPU layers/i });
    fireEvent.change(input, { target: { value: "25" } });
    fireEvent.blur(input);
    await waitFor(() => expect(test.config().ngl).toBe(25));
    expect(test.config().runtime_defaults).not.toContain("ngl");
  });

  it("shows failure without displaying a successful reset", async () => {
    const test = renderLive(async () => { throw new Error("disk full"); });
    fireEvent.click(screen.getByRole("button", { name: /Reset GPU layers.*to default/i }));
    await screen.findByText(/Could not reset tuning: disk full/);
    expect(test.config().runtime_defaults).toBeUndefined();
    expect(screen.queryByText("Using llama.cpp default")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset all tuning" })).toBeEnabled();
  });

  it("disables other mutations until reset persistence finishes", async () => {
    let finish!: (cfg: AppConfig) => void;
    const test = renderLive((next) => new Promise((resolve) => { finish = () => resolve(next); }));
    fireEvent.click(screen.getByRole("button", { name: /Reset GPU layers.*to default/i }));
    expect(screen.getByRole("button", { name: "Reset all tuning" })).toBeDisabled();
    fireEvent.click(screen.getByText("Presets"));
    expect(screen.getByRole("button", { name: "CPU" })).toBeDisabled();
    await act(async () => finish(cfg));
    await waitFor(() => expect(test.config().runtime_defaults).toContain("ngl"));
    expect(screen.getByRole("button", { name: "Reset all tuning" })).toBeEnabled();
  });
});
