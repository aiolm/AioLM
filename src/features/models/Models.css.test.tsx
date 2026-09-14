import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import type { AppConfig } from "../../shared/api/types";
import type { AppStore } from "../../shared/state/store";
import { I18nProvider } from "../../shared/i18n/i18n";
import "../../styles/app.css";
import ModelsPanel from "./Models";
import * as api from "../../shared/api/index";

// Guard two Models.tsx cascade regressions where a Tailwind utility loses to
// a hand-written `app-*` class, or never generates a competing rule.

vi.mock("../../shared/api/index", () => ({
  isNativeRuntimeAvailable: () => false,
  listModels: vi.fn(),
  deleteModel: vi.fn(),
  pickModelsDir: vi.fn(),
  pickLoraAdapter: vi.fn(),
  listServerLoraAdapters: vi.fn(),
  setServerLoraAdapters: vi.fn(),
  unloadModel: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const baseCfg = {
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
  spec_draft_n_max: 16,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "on",
  reasoning_format: "deepseek",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "",
  server_args: [],
  chat_options: { max_tokens: 512 },
  mmproj: "",
  active_model: "",
  active_backend: "PATH",
  active_build: "",
  iters: 1,
  parallel: 1,
  request_timeout_seconds: 60,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies AppConfig;

function storeFor(cfg: AppConfig): AppStore {
  return {
    cfg,
    status: { state: "stopped" },
    busy: false,
    updateConfig: async () => cfg,
    start: async () => "",
    stop: async () => undefined,
  } as unknown as AppStore;
}

describe("ModelsPanel CSS cascade", () => {
  it("preserves current execution settings when a legacy profile has an incomplete runtime", async () => {
    localStorage.clear();
    localStorage.setItem("aiolm-model-profiles", JSON.stringify({
      version: 4, server: [{ id: "server-default", name: "Default", backend: "vulkan", build: "", ctx_size: 8192 }],
      model: [], activeServerIds: {},
    }));
    const model = { name: "legacy.gguf", path: "C:/models/legacy.gguf", size_mb: 100, is_vision: false };
    mocked.listModels.mockReset().mockResolvedValue({ models: [model], truncated: false });
    const cfg = { ...baseCfg, models_dir: "C:/models", active_backend: "rocm", active_build: "local_b10840_nop2p" };
    const store = storeFor(cfg);
    const save = vi.fn(async (patch: Partial<AppConfig>) => {
      const next = { ...cfg, ...patch };
      if (!next.active_backend !== !next.active_build) throw new Error("active runtime backend and build must be selected together");
      return next;
    });
    store.updateConfig = save as AppStore["updateConfig"];
    const view = render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Select legacy.gguf" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await expect(save.mock.results[0].value).resolves.toMatchObject({ active_model: model.path, active_backend: "rocm", active_build: "local_b10840_nop2p", ctx_size: cfg.ctx_size });
    const saved = await save.mock.results[0].value;
    view.rerender(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store: { ...store, cfg: saved } }) }));
    expect(screen.getByRole("button", { name: "Select legacy.gguf" })).not.toHaveAttribute("aria-current");
    localStorage.clear();
  });

  it.each([false, true])("saves a valid runtime pair when selecting a library model (saved PATH profile: %s)", async (savedProfile) => {
    localStorage.clear();
    if (savedProfile) {
      localStorage.setItem("aiolm-model-profiles", JSON.stringify({
        version: 4,
        server: [{ id: "system", name: "System", backend: "PATH", build: "" }],
        model: [], activeServerIds: {},
      }));
    }
    const model = { name: "selectable.gguf", path: "C:/models/selectable.gguf", size_mb: 100, is_vision: false };
    mocked.listModels.mockReset().mockResolvedValue({ models: [model], truncated: false });
    const cfg = { ...baseCfg, models_dir: "C:/models", active_backend: savedProfile ? "vulkan" : "", active_build: savedProfile ? "b100" : "" };
    const store = storeFor(cfg);
    const save = vi.fn(async (patch: Partial<AppConfig>) => {
      const next = { ...cfg, ...patch };
      // Match the native validator that rejected model selection.
      if (!next.active_backend !== !next.active_build) {
        throw new Error("active runtime backend and build must be selected together");
      }
      return next;
    });
    store.updateConfig = save as AppStore["updateConfig"];
    const view = render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store }) }));
    fireEvent.click(await screen.findByRole("button", { name: "Select selectable.gguf" }));
    await waitFor(() => expect(save).toHaveBeenCalledOnce());
    await expect(save.mock.results[0].value).resolves.toMatchObject({ active_model: model.path, active_backend: cfg.active_backend, active_build: cfg.active_build });
    const saved = await save.mock.results[0].value;
    view.rerender(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store: { ...store, cfg: saved } }) }));
    expect(screen.getByRole("button", { name: "Select selectable.gguf" })).not.toHaveAttribute("aria-current");
    expect(screen.queryByText(/active runtime backend and build must be selected together/)).not.toBeInTheDocument();
    localStorage.clear();
  });

  it("selects the first shard and confirms deletion of the complete file set", async () => {
    const files = ["C:/models/large-00001-of-00002.gguf", "C:/models/large-00002-of-00002.gguf"];
    const model = { name: "large.gguf", path: files[0], size_mb: 300, is_vision: false, shards: { files, total: 2, missing: [] } };
    mocked.listModels.mockReset().mockResolvedValue({ models: [model], truncated: false });
    mocked.deleteModel.mockReset().mockResolvedValue(undefined);
    const cfg = { ...baseCfg, models_dir: "C:/models" };
    const store = storeFor(cfg);
    store.updateConfig = vi.fn().mockResolvedValue(cfg);
    render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store }) }));
    expect(await screen.findByText("Split model · 2 files")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("300 MB")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select large.gguf" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ active_model: files[0] })));
    expect(screen.queryByLabelText("File actions: large.gguf")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Copy path: large.gguf" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Delete: large.gguf" }));
    expect(await screen.findByText("All 2 files belonging to large.gguf will be permanently removed. This cannot be undone.")).toBeInTheDocument();
    expect(mocked.deleteModel).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete model" }));
    await waitFor(() => expect(mocked.deleteModel).toHaveBeenCalledWith(files[0], files));
  });

  it("shows incomplete shards without allowing selection or launch", async () => {
    const path = "C:/models/partial-00002-of-00003.gguf";
    mocked.listModels.mockReset().mockResolvedValue({ models: [{ name: "partial.gguf", path, size_mb: 100, is_vision: false, shards: { files: [path], total: 3, missing: [1, 3] } }], truncated: false });
    render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ModelsPanel, { store: storeFor({ ...baseCfg, models_dir: "C:/models" }) }) }));
    expect(await screen.findByText("Incomplete model · 2 of 3 files missing")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select partial.gguf" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Start: partial.gguf" })).toBeDisabled();
  });

  it("keeps loaded models visible after a rescan fails and replaces the toolbar action with Retry", async () => {
    const model = { name: "kept.gguf", path: "C:/models/kept.gguf", size_mb: 100, is_vision: false };
    mocked.listModels.mockReset().mockResolvedValueOnce({ models: [model], truncated: false })
      .mockRejectedValueOnce(new Error("scan failed"))
      .mockResolvedValueOnce({ models: [model], truncated: false });
    const cfg = { ...baseCfg, models_dir: "C:/models" };
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(cfg) }),
    }));

    await screen.findByText("kept.gguf");
    fireEvent.click(screen.getByRole("button", { name: "Rescan" }));
    const retryButton = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByText("kept.gguf")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rescan" })).not.toBeInTheDocument();
    fireEvent.click(retryButton);
    expect(await screen.findByRole("button", { name: "Rescan" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
    expect(mocked.listModels).toHaveBeenCalledTimes(3);
    expect(screen.getByText("kept.gguf")).toBeInTheDocument();
  });

  it("keeps the folder controls always visible without a collapse toggle", async () => {
    mocked.listModels.mockReset().mockResolvedValue({ models: [], truncated: false });
    mocked.pickModelsDir.mockReset().mockResolvedValue(null);
    const view = render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor({ ...baseCfg, models_dir: "C:/models" }) }),
    }));
    await screen.findByRole("heading", { name: "No GGUF models found" });
    expect(screen.getByRole("button", { name: "Rescan" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Browse" })).toBeVisible();
    expect(view.container.querySelector("details.models-folder")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Choose folder" }));
    await waitFor(() => expect(mocked.pickModelsDir).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() => expect(mocked.pickModelsDir).toHaveBeenCalledTimes(2));
    expect(screen.getByRole("button", { name: "Rescan" })).toBeEnabled();
  });

  it("gives the LoRA add button an explicit hover class instead of the unsupported hover:app-bg-accent-solid variant", async () => {
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(baseCfg), focus: "lora" }),
    }));

    const addButton = await screen.findByRole("button", { name: "Add GGUF" });
    expect(addButton).toHaveClass("app-button--primary");
    expect(addButton.className).not.toMatch(/hover:app-bg-accent-solid/);
  });

  it("gives the model row start/switch button the same explicit hover class", async () => {
    mocked.listModels.mockResolvedValue({
      models: [{ path: "C:/models/a.gguf", name: "a.gguf", size_mb: 128, is_vision: false }],
      truncated: false,
    });
    const cfg = { ...baseCfg, models_dir: "C:/models" };
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: storeFor(cfg) }),
    }));

    const startButton = await screen.findByRole("button", { name: /^Start/ });
    expect(startButton).toHaveClass("app-button--primary");
    expect(startButton.className).not.toMatch(/hover:app-bg-accent-solid/);
  });
});
