import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import type { AppConfig } from "../../shared/api/types";
import type { AppStore } from "../../shared/state/store";
import { I18nProvider, type Locale } from "../../shared/i18n/i18n";
import "../../styles/app.css";
import * as api from "../../shared/api/index";
import { createTestStore } from "../../testing/appStore";
import ModelsPanel from "./Models";
import { panelText } from "../../shared/i18n/panelI18n";
import { providerCopy } from "../../shared/i18n/providerCopy";

vi.mock("../../shared/api/index", async importOriginal => ({
  ...await importOriginal<typeof import("../../shared/api/index")>(),
  isNativeRuntimeAvailable: vi.fn(() => false),
  listModels: vi.fn(async () => ({ models: [], truncated: false })),
  cancelModelScan: vi.fn(async () => undefined),
  pickModelsDir: vi.fn(async () => null),
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

describe('model library empty results and filter recovery', () => {
  const primary: api.GgufModel = { name: 'Example.gguf', path: 'C:/synthetic/models/Example.gguf', size_mb: 1, is_vision: false };
  const sidecar: api.GgufModel = { name: 'mmproj-vision.gguf', path: 'C:/synthetic/models/mmproj-vision.gguf', size_mb: 1, is_vision: true };
  const localCopy = [
    { locale: 'en', checkbox: "Show supporting model files", title: 'No matching models', description: 'None of the scanned models are shown with the current filters. Clear the search and engine filters to view the scanned models.', clear: 'Clear filters' },
    { locale: 'ko', checkbox: "모델 보조 파일 표시", title: '조건에 맞는 모델이 없습니다', description: '현재 필터에서는 검색된 모델이 표시되지 않습니다. 검색어와 추론 엔진 필터를 지우면 검색된 모델을 볼 수 있습니다.', clear: '필터 지우기' },
    { locale: 'ja', checkbox: "モデルの補助ファイルを表示", title: '条件に一致するモデルがありません', description: '現在のフィルターでは、検索済みのモデルが表示されません。検索語と推論エンジンのフィルターをクリアすると、検索済みのモデルを確認できます。', clear: 'フィルターをクリア' },
    { locale: 'zh', checkbox: "显示模型辅助文件", title: '没有符合条件的模型', description: '当前筛选条件下未显示扫描到的模型。清除搜索和推理引擎筛选条件即可查看扫描到的模型。', clear: '清除筛选条件' },
  ] as const;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.isNativeRuntimeAvailable).mockReturnValue(false);
    vi.mocked(api.listModels).mockReset();
    vi.mocked(api.cancelModelScan).mockReset().mockResolvedValue(undefined);
    vi.mocked(api.pickModelsDir).mockReset().mockResolvedValue(null);
    vi.mocked(api.sessionList).mockResolvedValue([]);
  });

  async function library(catalog: api.GgufModel[], locale: Locale = 'en') {
    const base = createTestStore({ models_dir: 'C:/synthetic/models', active_model: '' });
    const before = structuredClone(base.cfg);
    const onModels = vi.fn();
    vi.mocked(api.listModels).mockResolvedValue({ models: catalog, truncated: false });
    const view = render(<I18nProvider initialLocale={locale}><ModelsPanel store={base} compact onSelectModel={vi.fn(async () => undefined)} onModels={onModels} /></I18nProvider>);
    await waitFor(() => expect(onModels).toHaveBeenCalledWith(catalog));
    return { base, before, onModels, view };
  }

  async function filterToVllm() {
    fireEvent.click(screen.getByRole('combobox', { name: providerCopy.en.engine }));
    fireEvent.click(await screen.findByRole('option', { name: api.providerDisplayName('vllm') }));
  }

  it.each(localCopy)('explains query no-matches in $locale and restores the scanned rows without changing the folder', async ({ locale, checkbox, title, description, clear }) => {
    const catalog = structuredClone([primary, sidecar]);
    const { base, before, onModels } = await library(catalog, locale);
    const input = screen.getByRole('textbox', { name: panelText[locale].searchModels });
    fireEvent.change(input, { target: { value: 'nothing matches' } });
    expect(await screen.findByRole('heading', { name: title })).toBeVisible();
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.queryByRole('button', { name: panelText[locale].chooseFolder })).not.toBeInTheDocument();
    const recover = screen.getByRole('button', { name: clear });
    recover.focus();
    fireEvent.click(recover);
    await waitFor(() => expect(screen.getByTestId('models-list')).toHaveAttribute('role', 'list'));
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByRole('checkbox', { name: checkbox })).not.toBeChecked();
    expect(within(screen.getByTestId('models-list')).getAllByRole('listitem')).toHaveLength(1);
    expect(base.cfg).toEqual(before);
    expect(base.updateConfig).not.toHaveBeenCalled();
    expect(api.pickModelsDir).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledOnce();
    expect(onModels.mock.calls).toEqual([[catalog]]);
    expect(catalog).toEqual([primary, sidecar]);
  });

  it('clears combined search and engine filters while retaining an explicit sidecar display choice', async () => {
    const { base, before } = await library(structuredClone([primary, sidecar]));
    const input = screen.getByRole('textbox', { name: panelText.en.searchModels });
    const vision = screen.getByRole('checkbox', { name: panelText.en.visionModels });
    fireEvent.click(vision);
    await filterToVllm();
    fireEvent.change(input, { target: { value: 'nothing matches' } });
    const recover = await screen.findByRole('button', { name: 'Clear filters' });
    recover.focus();
    fireEvent.click(recover);
    expect(await screen.findByRole('button', { name: 'Configure & run: Example.gguf' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Configure & run: mmproj-vision.gguf' })).toBeVisible();
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByRole('combobox', { name: providerCopy.en.engine })).toHaveTextContent(providerCopy.en.all);
    expect(vision).toBeChecked();
    expect(base.cfg).toEqual(before);
    expect(base.updateConfig).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledOnce();
  });

  it('offers an explicit sidecar reveal and keeps sidecars hidden by default on a fresh library view', async () => {
    const { base, before, view } = await library(structuredClone([sidecar]));
    expect(await screen.findByRole('heading', { name: 'Supporting model files are hidden' })).toBeVisible();
    expect(screen.getByText('The current scan found only supporting model files. These files are used alongside a model. Show them to view the results.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Choose folder' })).not.toBeInTheDocument();
    const reveal = screen.getByRole('button', { name: 'Show supporting model files' });
    reveal.focus();
    fireEvent.click(reveal);
    expect(await screen.findByRole('button', { name: 'Configure & run: mmproj-vision.gguf' })).toBeVisible();
    expect(within(screen.getByRole('button', { name: 'Configure & run: mmproj-vision.gguf' }).closest<HTMLElement>('[role="listitem"]')!).getByText('Supporting model file')).toBeVisible();
    expect(screen.getByRole('checkbox', { name: panelText.en.visionModels })).toBeChecked();
    expect(screen.getByRole('textbox', { name: panelText.en.searchModels })).toHaveFocus();
    expect(base.cfg).toEqual(before);
    expect(base.updateConfig).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledOnce();
    view.unmount();
    await library(structuredClone([sidecar]));
    expect(await screen.findByRole('heading', { name: 'Supporting model files are hidden' })).toBeVisible();
    expect(screen.getByRole('checkbox', { name: panelText.en.visionModels })).not.toBeChecked();
  });

  it('makes combined-filter sidecar recovery explicit and restores rows in one local action', async () => {
    const { base, before } = await library(structuredClone([sidecar]));
    await filterToVllm();
    const input = screen.getByRole('textbox', { name: panelText.en.searchModels });
    fireEvent.change(input, { target: { value: 'nothing matches' } });
    const recover = await screen.findByRole('button', { name: 'Clear filters and show supporting model files' });
    recover.focus();
    fireEvent.click(recover);
    expect(await screen.findByRole('button', { name: 'Configure & run: mmproj-vision.gguf' })).toBeVisible();
    expect(input).toHaveValue('');
    expect(input).toHaveFocus();
    expect(screen.getByRole('combobox', { name: providerCopy.en.engine })).toHaveTextContent(providerCopy.en.all);
    expect(screen.getByRole('checkbox', { name: panelText.en.visionModels })).toBeChecked();
    expect(base.cfg).toEqual(before);
    expect(base.updateConfig).not.toHaveBeenCalled();
    expect(api.pickModelsDir).not.toHaveBeenCalled();
    expect(api.listModels).toHaveBeenCalledOnce();
  });

  it('retains actual empty-catalog folder guidance even when a query is present', async () => {
    const { base, before } = await library([]);
    fireEvent.change(screen.getByRole('textbox', { name: panelText.en.searchModels }), { target: { value: 'nothing matches' } });
    expect(await screen.findByRole('heading', { name: 'No models found' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    await waitFor(() => expect(api.pickModelsDir).toHaveBeenCalledOnce());
    expect(base.cfg).toEqual(before);
    expect(base.updateConfig).not.toHaveBeenCalled();
  });

  it('keeps pending, cancellation, error, retry and truncated-scan feedback separate from no-matches', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.listModels>>) => void;
    vi.mocked(api.listModels).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockRejectedValueOnce(new Error('synthetic scan failed'))
      .mockResolvedValueOnce({ models: structuredClone([primary]), truncated: true });
    const base = createTestStore({ models_dir: 'C:/synthetic/models', active_model: '' });
    const onModels = vi.fn();
    render(<I18nProvider initialLocale="en"><ModelsPanel store={base} compact onSelectModel={vi.fn(async () => undefined)} onModels={onModels} /></I18nProvider>);
    await waitFor(() => expect(api.listModels).toHaveBeenCalledOnce());
    const input = screen.getByRole('textbox', { name: panelText.en.searchModels });
    fireEvent.change(input, { target: { value: 'nothing matches' } });
    expect(screen.getByRole('button', { name: 'Cancel scan' })).toBeEnabled();
    expect(screen.queryByRole('heading', { name: 'No matching models' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose folder' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel scan' }));
    expect(api.cancelModelScan).toHaveBeenCalledOnce();
    await act(async () => { finish({ models: structuredClone([primary]), truncated: false }); });
    expect(onModels).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Rescan' }));
    const retry = await screen.findByRole('button', { name: 'Retry' });
    expect(screen.getByText('synthetic scan failed')).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'No matching models' })).not.toBeInTheDocument();
    fireEvent.click(retry);
    const recover = await screen.findByRole('button', { name: 'Clear filters' });
    const truncated = 'Only part of this folder was scanned because it contains too many files. Choose a smaller folder to find the remaining models.';
    expect(screen.getByText(truncated)).toBeVisible();
    recover.focus();
    fireEvent.click(recover);
    expect(await screen.findByRole('button', { name: 'Configure & run: Example.gguf' })).toBeVisible();
    expect(input).toHaveFocus();
    expect(screen.getByText(truncated)).toBeVisible();
    expect(api.listModels).toHaveBeenCalledTimes(3);
    expect(onModels).toHaveBeenCalledOnce();
    expect(base.updateConfig).not.toHaveBeenCalled();
  });
});
