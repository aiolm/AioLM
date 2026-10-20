import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import type { AppConfig } from "../../shared/api/types";
import type { AppStore } from "../../shared/state/store";
import { I18nProvider } from "../../shared/i18n/i18n";
import "../../styles/app.css";
import * as api from "../../shared/api/index";
import { createTestStore } from "../../testing/appStore";
import ModelsPanel from "./Models";

vi.mock("../../shared/api/index", async importOriginal => ({
  ...await importOriginal<typeof import("../../shared/api/index")>(),
  isNativeRuntimeAvailable: vi.fn(() => false),
  listModels: vi.fn(async () => ({ models: [], truncated: false })),
  cancelModelScan: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []),
  deleteModel: vi.fn(async () => undefined),
}));

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
  active_model: "C:/models/example.gguf",
  active_backend: "PATH",
  active_build: "",
  iters: 1,
  parallel: 1,
  request_timeout_seconds: 60,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies AppConfig;

const store = {
  cfg,
  status: { state: "stopped" },
  busy: false,
  updateConfig: async () => cfg,
  start: async () => "",
  stop: async () => undefined,
} as unknown as AppStore;

describe("ModelsPanel layout", () => {
  it("does not render tuning controls in the model library", () => {
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store }),
    }));

    const scrollRegion = screen.getByTestId("models-scroll-region");
    expect(scrollRegion).toHaveClass("models-panel");
    expect(screen.queryByTestId("execution-profiles-section")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Execution profiles" })).not.toBeInTheDocument();
    expect(screen.getByTestId("models-list")).toHaveClass("models-model-list");
    expect(screen.queryByTestId("models-header-actions")).not.toBeInTheDocument();
  });

  it("leaves server lifecycle controls to the app toolbar", () => {
    const startingStore = {
      ...store,
      status: { state: "starting" },
      busy: true,
    } as AppStore;
    render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: startingStore }),
    }));

    expect(screen.queryByRole("button", { name: "Stop server" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unload model" })).toBeDisabled();
  });

  it("does not show the model's private server address next to the loaded model", () => {
    const runningStore = {
      ...store,
      status: { state: "running", url: "http://127.0.0.1:49152/v1", api_key: "private-key", model: cfg.active_model },
    } as unknown as AppStore;
    const { container } = render(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ModelsPanel, { store: runningStore }),
    }));

    expect(screen.getByRole("button", { name: "Unload model" })).toBeEnabled();
    expect(container.textContent).not.toContain("127.0.0.1");
    expect(container.textContent).not.toContain("private-key");
  });
});

describe("model library loaded path identity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(true);
  });

  it("marks equivalent Windows paths as loaded and prevents deleting the named session model", async () => {
    const path = "c:/models/Example.gguf";
    vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: "Example.gguf", path, size_mb: 1, is_vision: false }], truncated: false });
    vi.mocked(api.sessionList).mockResolvedValue([{ id: "named", name: "Named", state: "running", model: "served-alias", execution: { active_model: "C:\\Models\\example.gguf" } }]);
    const base = createTestStore({ active_model: "", models_dir: "C:/models" });
    render(<I18nProvider initialLocale="en"><ModelsPanel store={base} compact onSelectModel={vi.fn()} /></I18nProvider>);

    const button = await screen.findByRole("button", { name: "Configure & run: Example.gguf" });
    await waitFor(() => expect(api.sessionList).toHaveBeenCalled());
    await act(async () => { await vi.mocked(api.sessionList).mock.results[0].value; });
    const row = within(button.closest<HTMLElement>('[role="listitem"]')!);
    expect.soft(row.queryByText("Running")).toBeVisible();
    const remove = row.getByRole("button", { name: "Delete: Example.gguf" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(api.deleteModel).not.toHaveBeenCalled();
    expect(base.cfg?.active_model).toBe("");
  });

  it("keeps POSIX model paths that differ only by case distinct", async () => {
    vi.mocked(api.listModels).mockResolvedValue({ models: [
      { name: "Example.gguf", path: "/models/Example.gguf", size_mb: 1, is_vision: false },
      { name: "example.gguf", path: "/models/example.gguf", size_mb: 1, is_vision: false },
    ], truncated: false });
    vi.mocked(api.sessionList).mockResolvedValue([{ id: "named", name: "Named", state: "running", model: "served-alias", execution: { active_model: "/models/example.gguf" } }]);
    const base = createTestStore({ active_model: "", models_dir: "/models" });
    render(<I18nProvider initialLocale="en"><ModelsPanel store={base} compact onSelectModel={vi.fn()} /></I18nProvider>);

    const upper = await screen.findByRole("button", { name: "Configure & run: Example.gguf" });
    const lower = await screen.findByRole("button", { name: "Configure & run: example.gguf" });
    const upperRow = within(upper.closest<HTMLElement>('[role="listitem"]')!);
    const lowerRow = within(lower.closest<HTMLElement>('[role="listitem"]')!);
    await waitFor(() => expect(lowerRow.getByText("Running")).toBeVisible());
    expect(upperRow.queryByText("Running")).not.toBeInTheDocument();
    expect(upperRow.getByRole("button", { name: "Delete: Example.gguf" })).toBeEnabled();
    expect(lowerRow.getByRole("button", { name: "Delete: example.gguf" })).toBeDisabled();
    expect(api.deleteModel).not.toHaveBeenCalled();
  });

  it("marks the default server model through an equivalent Windows execution path", async () => {
    const path = "C:/Models/Example.gguf";
    vi.mocked(api.listModels).mockResolvedValue({ models: [{ name: "Example.gguf", path, size_mb: 1, is_vision: false }], truncated: false });
    vi.mocked(api.sessionList).mockResolvedValue([]);
    const base = createTestStore({ active_model: "C:/Models/Other.gguf", models_dir: "C:/Models" });
    base.status = { state: "running", model: "served-alias", execution: { active_model: "c:\\models\\example.gguf" } };
    render(<I18nProvider initialLocale="en"><ModelsPanel store={base} compact onSelectModel={vi.fn()} /></I18nProvider>);

    const button = await screen.findByRole("button", { name: "Configure & run: Example.gguf" });
    const row = within(button.closest<HTMLElement>('[role="listitem"]')!);
    expect(row.getByText("Running")).toBeVisible();
    expect(button).toHaveAttribute("title", path);
    expect(base.cfg?.active_model).toBe("C:/Models/Other.gguf");
    expect(base.updateConfig).not.toHaveBeenCalled();
  });

  it("protects a grouped model loaded through an equivalent later-shard path and keeps its original selection paths", async () => {
    const first = "C:/Models/Shard-00001-of-00002.gguf";
    const files = [first, "C:/Models/Shard-00002-of-00002.gguf"];
    const model = { name: "Shard.gguf", path: first, size_mb: 2, is_vision: false, shards: { files, total: 2, missing: [] } };
    vi.mocked(api.listModels).mockResolvedValue({ models: [model], truncated: false });
    vi.mocked(api.sessionList).mockResolvedValue([{ id: "named", name: "Named", state: "running", model: "served-alias", execution: { active_model: "c:\\models\\shard-00002-of-00002.gguf" } }]);
    const base = createTestStore({ active_model: "", models_dir: "C:/Models" });
    const select = vi.fn();
    render(<I18nProvider initialLocale="en"><ModelsPanel store={base} compact onSelectModel={select} /></I18nProvider>);

    const button = await screen.findByRole("button", { name: "Configure & run: Shard.gguf" });
    await waitFor(() => expect(api.sessionList).toHaveBeenCalled());
    await act(async () => { await vi.mocked(api.sessionList).mock.results[0].value; });
    const row = within(button.closest<HTMLElement>('[role="listitem"]')!);
    expect(row.getByText("Running")).toBeVisible();
    const remove = row.getByRole("button", { name: "Delete: Shard.gguf" });
    expect(remove).toBeDisabled();
    fireEvent.click(remove);
    expect(api.deleteModel).not.toHaveBeenCalled();
    fireEvent.click(button);
    expect(select).toHaveBeenCalledWith(expect.objectContaining({ path: first, shards: { files, total: 2, missing: [] } }));
    expect(button).toHaveAttribute("title", first);
    expect(model.shards.files).toEqual([first, "C:/Models/Shard-00002-of-00002.gguf"]);
  });
});
