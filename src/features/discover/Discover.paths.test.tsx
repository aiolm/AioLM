import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { PanelFeedbackActivity, PanelFeedbackIndicator, PanelFeedbackOutlet, PanelFeedbackProvider } from "../../shared/ui/PanelFeedback";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import DiscoverPanel from "./Discover";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { rememberExecution } from '../models/modelExecutionState';

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shared/api/index")>(),
  onModelDownloadProgress: vi.fn(async () => () => undefined), hfSearchModels: vi.fn(), hfModelFiles: vi.fn(), hfDownloadModel: vi.fn(), hfInstalledFiles: vi.fn(),
  hfDownloadSnapshot: vi.fn(), hfInstalledSnapshots: vi.fn(), hfCancelDownload: vi.fn(async () => undefined),
}));


/** Download stays disabled until the installed-file lookup has answered. */
async function clickDownload(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("Discover path presentation", () => {
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(useModelSettings).mockReturnValue(null); vi.mocked(api.hfInstalledFiles).mockResolvedValue([]); vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([]); localStorage.clear(); });
  afterEach(() => { for (const t of getTaskSnapshot()) removeTask(t.id); });

  it.each([false, true])("offers downloaded files for explicit configuration without changing the active model (projector: %s)", async (projector) => {
    const settings: ModelSettingsContext = { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
    vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_model: "models/current.gguf" });
    const file = projector ? "mmproj.gguf" : "download.gguf";
    const downloadedPath = `models/${file}`;
    vi.mocked(api.hfSearchModels).mockResolvedValue([{ id: "owner/model", author: "owner", downloads: 1, likes: 1, last_modified: "", tags: [], gated: false }]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: file, size_bytes: 1000, is_mmproj: projector, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockResolvedValue({ path: downloadedPath, repo_id: "owner/model", file_path: file, size_bytes: 1000 });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    // The panel lists the catalog as soon as it opens; wait for that request
    // to settle so the search below is the one under test.
    await screen.findByRole("button", { name: "Search models" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload(`${projector ? "Download projector" : "Download"}: ${file}`);
    fireEvent.click(await screen.findByRole("button", { name: "Configure and run" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "default" }, section: projector ? "adapters" : "model", config: expect.objectContaining(projector
      ? { active_model: "models/current.gguf", mmproj: downloadedPath }
      : { active_model: downloadedPath }) }));
    expect(api.hfDownloadModel).toHaveBeenCalledOnce();
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(store.start).not.toHaveBeenCalled();
    expect(store.stop).not.toHaveBeenCalled();
    expect(store.cfg?.active_model).toBe("models/current.gguf");
  });

  it("cleans destination tooltips and download failures while passing the stored destination to downloads", async () => {
    const raw = String.raw`\\?\UNC\server\share\models`;
    const display = String.raw`\\server\share\models`;
    const store = createTestStore({ models_dir: raw });
    vi.mocked(api.hfSearchModels).mockResolvedValue([{ id: "owner/model", author: "owner", downloads: 1, likes: 1, last_modified: "", tags: [], gated: false }]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockRejectedValue(new Error(`Cannot write ${raw}`));
    const { container } = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    expect(screen.getByText(display)).toHaveAttribute("title", display);
    await screen.findByRole("button", { name: "Search models" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.Q4_K_M.gguf");
    await waitFor(() => expect(api.hfDownloadModel).toHaveBeenCalledWith("owner/model", "model.Q4_K_M.gguf", raw));
    expect(await screen.findByText(`Cannot write ${display}`)).toBeInTheDocument();
    expect(container.textContent).not.toContain('\\\\?\\');
    expect(store.cfg?.models_dir).toBe(raw);
  });

  it("keeps download progress card inline and does not register a drawer notice count", async () => {
    type DownloadResult = Awaited<ReturnType<typeof api.hfDownloadModel>>;
    let resolveDownload: (value: DownloadResult) => void;
    const downloadPromise = new Promise<DownloadResult>((resolve) => { resolveDownload = resolve; });
    vi.mocked(api.hfSearchModels).mockResolvedValue([{ id: "owner/model", author: "owner", downloads: 1, likes: 1, last_modified: "", tags: [], gated: false }]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockReturnValue(downloadPromise);
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <PanelFeedbackProvider>
          <PanelFeedbackActivity hasActivity={false}>
            <summary>
              <PanelFeedbackIndicator message="Error" globalError={false} />
            </summary>
            <PanelFeedbackOutlet />
          </PanelFeedbackActivity>
          <DiscoverPanel store={store} />
        </PanelFeedbackProvider>
      </I18nProvider>
    );
    await screen.findByRole("button", { name: "Search models" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");

    const progressBar = screen.getByRole("progressbar", { name: "Download progress" });
    expect(progressBar).toBeVisible();
    expect(progressBar.closest(".app-panel-notices")).toBeNull();
    expect(screen.queryByText(/notices/)).not.toBeInTheDocument();
    expect(getTaskSnapshot().some((t) => t.id === "model-download" && t.state === "running")).toBe(true);

    resolveDownload!({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 });
  });
});

const repo = { id: 'owner/model', author: 'owner', downloads: 1, likes: 1, last_modified: '', tags: [], gated: false };
const snapshot: api.ModelArtifact = {
  path: 'models/hf/owner/model/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: 'model', format: 'mlx',
  role: 'model', size_bytes: 1000, file_count: 3, architectures: ['LlamaForCausalLM'], model_type: 'llama',
  modalities: { text: true, image: false, audio: false, video: false }, missing: [], incomplete: false, ownership: 'app', notes: [],
};

function settingsContext(): ModelSettingsContext {
  return { open: vi.fn(), suspended: false, resume: vi.fn(), getRequestConfig: (_id, cfg) => cfg, getRequestProfile: () => null };
}

describe('Discover runtime journeys', () => {
  it('browses another engine without altering execution and starts setup with that engine instead of reusing a foreign runtime', async () => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_provider: 'llama.cpp', active_runtime: 'old-foreign-runtime' });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Inference engine' }));
    fireEvent.click(screen.getByRole('option', { name: 'MLX' }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenLastCalledWith('', 30, 'downloads', 'mlx'));
    expect(store.cfg?.active_provider).toBe('llama.cpp');
    expect(store.updateConfig).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_provider: 'mlx-vlm', active_runtime: '' }) }));
  });
  beforeEach(() => {
    vi.clearAllMocks(); localStorage.clear();
    vi.mocked(useModelSettings).mockReturnValue(settingsContext());
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([]);
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([]);
    vi.mocked(api.hfSearchModels).mockResolvedValue([repo]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([]);
    vi.mocked(api.hfDownloadSnapshot).mockResolvedValue(snapshot);
  });
  afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

  it.each(['vllm', 'mlx-vlm'] as const)('preserves %s and its selected runtime when downloading MLX weights', async provider => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_provider: provider, active_runtime: provider === 'vllm' ? 'synthetic-vllm-metal' : 'synthetic-mlx-vlm' });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledWith('', 30, 'downloads', provider === 'vllm' ? 'safetensors' : 'mlx'));
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_provider: provider, active_runtime: store.cfg?.active_runtime, active_model: snapshot.path }) }));
    expect(api.hfModelFiles).not.toHaveBeenCalled();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it('binds snapshot setup to the originating runtime even after switching providers in flight', async () => {
    let finish!: (artifact: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal' });
    const renderPanel = () => <I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>;
    const view = render(renderPanel());
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    store.cfg!.active_provider = 'mlx-vlm'; store.cfg!.active_runtime = 'another-runtime'; view.rerender(renderPanel());
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenLastCalledWith('', 30, 'downloads', 'mlx'));
    await act(async () => finish(snapshot));
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal' }) }));
  });

  it('retires pending GGUF responses when the user switches to MLX search', async () => {
    let oldSearch!: (models: api.HfModel[]) => void;
    vi.mocked(api.hfSearchModels).mockReturnValueOnce(new Promise(resolve => { oldSearch = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Inference engine' }));
    fireEvent.click(screen.getByRole('option', { name: 'MLX' }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenLastCalledWith('', 30, 'downloads', 'mlx'));
    await act(async () => oldSearch([{ ...repo, id: 'old/gguf' }]));
    expect(screen.queryByRole('button', { name: /old\/gguf/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /owner\/model/ })).toBeInTheDocument();
  });

  it('requires the model to be stopped for snapshot downloads', async () => {
    const store = createTestStore({ active_provider: 'vllm' }); store.status = { state: 'running' };
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    expect(api.hfDownloadSnapshot).not.toHaveBeenCalled();
  });

  it('classifies cancellation correctly and allows a verified retry without overlapping transfers', async () => {
    let rejectDownload!: (error: Error) => void;
    vi.mocked(api.hfDownloadSnapshot).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectDownload = reject; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore({ active_provider: 'vllm' })} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    expect(download).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledOnce());
    expect(download).toBeDisabled();
    await act(async () => rejectDownload(new Error('model download cancelled')));
    expect(getTaskSnapshot().find(task => task.id === 'model-download')?.state).toBe('cancelled');
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    await waitFor(() => expect(api.hfDownloadSnapshot).toHaveBeenCalledTimes(2));
  });

  it('marks complete snapshots and exposes interrupted snapshots for retry', async () => {
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([snapshot, { ...snapshot, path: 'models/interrupted', incomplete: true, missing: ['weights.safetensors'] }]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore({ active_provider: 'vllm' })} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    expect(await screen.findByText('Installed')).toBeInTheDocument();
    expect(await screen.findByText('Required files are missing.')).toBeInTheDocument();
    expect(api.hfInstalledSnapshots).toHaveBeenCalledWith('owner/model', 'models');
  });

  it.each([false, true])('downloads same-repository GGUF companions only after explicit selection (opt in: %s)', async include => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal' });
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: 'model.gguf', size_bytes: 10, is_mmproj: false, download_url: '', companions_available: true }]);
    vi.mocked(api.hfDownloadModel).mockResolvedValue({ path: 'models/model.gguf', repo_id: repo.id, file_path: 'model.gguf', size_bytes: 10 });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(screen.getByRole('combobox', { name: 'Model format' }));
    fireEvent.click(screen.getByRole('option', { name: 'GGUF' }));
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const checkbox = await screen.findByRole('checkbox', { name: 'Download GGUF with local config and tokenizer' });
    expect(checkbox).not.toBeChecked();
    if (include) fireEvent.click(checkbox);
    await clickDownload('Download: model.gguf');
    await waitFor(() => expect(api.hfDownloadModel).toHaveBeenCalledWith(...(include ? [repo.id, 'model.gguf', 'models', true] : [repo.id, 'model.gguf', 'models'])));
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal' }) }));
  });

  it('downloads a split GGUF with one action and configures its first shard after all parts arrive', async () => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const first = 'model-00001-of-00002.gguf', second = 'model-00002-of-00002.gguf';
    vi.mocked(api.hfModelFiles).mockResolvedValue([first, second].map(path => ({ path, size_bytes: 10, is_mmproj: false, download_url: '' })));
    const installed: api.HfInstalledFile[] = [];
    vi.mocked(api.hfInstalledFiles).mockImplementation(async () => installed.map(entry => ({ ...entry })));
    vi.mocked(api.hfDownloadModel).mockImplementation(async (_repo, path) => {
      installed.push(...[first, second].map(part => ({ path: part, local_path: `models/${part}`, size_bytes: 10, missing_shards: [] })));
      return { path: `models/${first}`, repo_id: repo.id, file_path: path, size_bytes: 20 };
    });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    expect(await screen.findByText('Split model · 2 files')).toBeVisible();
    expect(screen.getByText('20 B')).toBeVisible();
    expect(screen.queryByText(second)).not.toBeInTheDocument();
    await clickDownload('Download: model.gguf');
    await waitFor(() => expect(api.hfDownloadModel).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    expect(api.hfDownloadModel).toHaveBeenCalledWith(repo.id, first, 'models');
    expect(await screen.findByRole('button', { name: 'Installed: model.gguf' })).toBeDisabled();
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_model: `models/${first}` }) }));
  });

  it.each(['model download cancelled', 'network failed'])('keeps a partial split model retryable after %s', async (failure) => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const first = 'model-00001-of-00002.gguf', second = 'model-00002-of-00002.gguf';
    vi.mocked(api.hfModelFiles).mockResolvedValue([first, second].map(path => ({ path, size_bytes: 10, is_mmproj: false, download_url: '' })));
    const installed: api.HfInstalledFile[] = [];
    vi.mocked(api.hfInstalledFiles).mockImplementation(async () => installed.map(entry => ({ ...entry })));
    vi.mocked(api.hfDownloadModel).mockImplementationOnce(async () => {
      installed.push({ path: first, local_path: `models/${first}`, size_bytes: 10, missing_shards: [second] });
      throw new Error(failure);
    }).mockImplementationOnce(async () => {
      installed[0].missing_shards = [];
      installed.push({ path: second, local_path: `models/${second}`, size_bytes: 10, missing_shards: [] });
      return { path: `models/${first}`, repo_id: repo.id, file_path: first, size_bytes: 20 };
    });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    await clickDownload('Download: model.gguf');
    expect(await screen.findByText('Incomplete model · 1 of 2 files missing')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Configure and run' })).not.toBeInTheDocument();
    expect(getTaskSnapshot().find(task => task.id === 'model-download')?.state).toBe(failure === 'model download cancelled' ? 'cancelled' : 'failed');
    await clickDownload('Download: model.gguf');
    expect(await screen.findByRole('button', { name: 'Configure and run' })).toBeEnabled();
    expect(api.hfDownloadModel).toHaveBeenCalledTimes(2);
    expect(api.hfDownloadModel).toHaveBeenLastCalledWith(repo.id, first, 'models');
    expect(await screen.findByRole('button', { name: 'Installed: model.gguf' })).toBeDisabled();
  });

  it('restores the downloaded models provider-specific settings while preserving the explicitly selected runtime', async () => {
    const settings = settingsContext(); vi.mocked(useModelSettings).mockReturnValue(settings);
    const store = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal', ctx_size: 2048 });
    rememberExecution({ ...store.cfg!, active_model: snapshot.path, active_runtime: 'older-runtime', ctx_size: 8192, provider_options: { vllm: { max_model_len: 8192 } } });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    const download = await screen.findByRole('button', { name: 'Download complete model snapshot' });
    await waitFor(() => expect(download).toBeEnabled()); fireEvent.click(download);
    fireEvent.click(await screen.findByRole('button', { name: 'Configure and run' }));
    // vLLM restores its own context option; the inactive llama.cpp context
    // field remains separate under the provider-specific profile allowlist.
    await waitFor(() => expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ active_provider: 'vllm', active_runtime: 'synthetic-vllm-metal', ctx_size: 2048, provider_options: { vllm: { max_model_len: 8192 } } }) })));
  });

  it('keeps successful downloads completed when a model started before fallback setup could run', async () => {
    vi.mocked(useModelSettings).mockReturnValue(null);
    let finish!: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void;
    vi.mocked(api.hfDownloadModel).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: 'model.gguf', size_bytes: 10, is_mmproj: false, download_url: '' }]);
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: /owner\/model/ }));
    await clickDownload('Download: model.gguf');
    store.status = { state: 'running' };
    await act(async () => finish({ path: 'models/model.gguf', file_path: 'model.gguf', repo_id: repo.id, size_bytes: 10 }));
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(getTaskSnapshot().find(task => task.id === 'model-download')?.state).toBe('completed');
  });
});
