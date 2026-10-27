import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { finishTask, getTaskSnapshot, registerTask, removeTask, TASK_CLEAR_DELAY_MS, updateTask } from "../../shared/state/taskRegistry";
import { MODEL_DOWNLOAD_TASK_ID } from "../../shared/state/modelDownloadTask";
import { DraftGuardProvider, useEditorDraft } from "../../shared/state/draftGuard";
import DiscoverPanel from "./Discover";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { MODEL_CATALOG_CHANGED } from "../model-settings/useModelCatalog";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../shared/api/index")>(),
  isNativeRuntimeAvailable: vi.fn(() => true), hfOpenModelCard: vi.fn(async () => undefined),
  onModelDownloadProgress: vi.fn(async () => () => undefined), hfSearchModels: vi.fn(), hfModelFiles: vi.fn(), hfDownloadModel: vi.fn(), hfInstalledFiles: vi.fn(),
  hfDownloadSnapshot: vi.fn(), hfInstalledSnapshots: vi.fn(), hfCancelDownload: vi.fn(async () => undefined),
}));

const repository = { id: "owner/model", author: "owner", downloads: 12, likes: 3, last_modified: "", tags: [], gated: false };

function listed(id: string) {
  return { ...repository, id };
}

function DirtyDraft() {
  useEditorDraft({ dirty: true, save: async () => true, discard: () => undefined });
  return null;
}


/** Download stays disabled until the installed-file lookup has answered. */
async function clickDownload(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

describe("Discover listing and installed files", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useModelSettings).mockReturnValue(null);
    vi.mocked(api.hfSearchModels).mockResolvedValue([repository]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([]);
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([]);
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([]);
    localStorage.clear();
  });
  afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

  it("lists repositories on entry without a search term", async () => {
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    expect(await screen.findByRole("button", { name: /owner\/model/ })).toBeVisible();
    expect(api.hfSearchModels).toHaveBeenCalledWith("", 30, "downloads");
  });

  it("loads a fresh catalog after mount effect replay and ignores the retired request", async () => {
    let releaseFirst!: (models: api.HfModel[]) => void;
    vi.mocked(api.hfSearchModels)
      .mockImplementationOnce(() => new Promise(resolve => { releaseFirst = resolve; }))
      .mockResolvedValue([listed("owner/current")]);
    render(<StrictMode><I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider></StrictMode>);
    expect(await screen.findByRole("button", { name: /owner\/current/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Search models" })).toBeEnabled();
    releaseFirst([listed("owner/retired")]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /owner\/retired/ })).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: /owner\/current/ })).toBeVisible();
  });

  it("summarizes Hub tags in the listing and preserves all values in repository details", async () => {
    vi.mocked(api.hfSearchModels).mockResolvedValue([{ ...repository,
      tags: ['gguf', 'en', 'text-generation', 'license:apache-2.0', 'qwen4exp', 'custom-tag', 'base_model:original/long-model-name'] }]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    expect(await screen.findByText('qwen4exp')).toBeVisible();
    expect(screen.getByText('custom-tag')).toBeVisible();
    const result = screen.getByRole('button', { name: /owner\/model/ });
    expect(within(result).queryByText('license:apache-2.0')).not.toBeInTheDocument();
    expect(within(result).getByText('+2 more')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /owner\/model/ }));
    const disclosure = screen.getByText(/All model information/).closest('details')!;
    expect(within(disclosure).getByText('apache-2.0')).not.toBeVisible();
    fireEvent.click(within(disclosure).getByText(/All model information/));
    expect(within(disclosure).getByText('qwen4exp')).toBeVisible();
    expect(within(disclosure).getByText('custom-tag')).toBeVisible();
    expect(within(disclosure).getByText('apache-2.0')).toBeVisible();
    expect(within(disclosure).getByText('original/long-model-name')).toBeVisible();
  });

  it("opens the selected repository model card without changing its file selection", async () => {
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    const link = screen.getByRole("link", { name: "Model card on Hugging Face" });
    expect(link).toHaveAttribute("href", "https://huggingface.co/owner/model");
    fireEvent.click(link);
    await waitFor(() => expect(api.hfOpenModelCard).toHaveBeenCalledWith("owner/model"));
    expect(api.hfModelFiles).toHaveBeenCalledTimes(1);
  });

  it("reports a failure to open the model card", async () => {
    vi.mocked(api.hfOpenModelCard).mockRejectedValueOnce(new Error("Browser unavailable"));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    fireEvent.click(screen.getByRole("link", { name: "Model card on Hugging Face" }));
    expect(await screen.findByText("Browser unavailable")).toBeVisible();
  });

  it("does not spend a request until the panel is opened", async () => {
    const { rerender } = render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} active={false} /></I18nProvider>);
    expect(api.hfSearchModels).not.toHaveBeenCalled();
    rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} active /></I18nProvider>);
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledWith("", 30, "downloads"));
  });

  it("re-runs the current search in the chosen order", async () => {
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    await screen.findByRole("button", { name: "Search models" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledWith("qwen", 30, "downloads"));
    fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    fireEvent.click(await screen.findByRole("option", { name: "Trending" }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledWith("qwen", 30, "trendingScore"));
  });

  it("loads trending repositories without requiring a search term", async () => {
    render(<I18nProvider initialLocale="ko"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    await screen.findByRole("button", { name: /owner\/model/ });
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/trending")]);
    fireEvent.click(screen.getByRole("combobox", { name: "정렬" }));
    fireEvent.click(await screen.findByRole("option", { name: "인기 급상승순 (Trending)" }));
    expect(await screen.findByRole("button", { name: /owner\/trending/ })).toBeVisible();
    expect(api.hfSearchModels).toHaveBeenLastCalledWith("", 30, "trendingScore");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(screen.getByRole("combobox", { name: "정렬" })).toHaveTextContent("인기 급상승순 (Trending)");
  });

  it("keeps the newest listing when an earlier request settles last", async () => {
    let releaseFirst: (value: api.HfModel[]) => void = () => undefined;
    vi.mocked(api.hfSearchModels)
      .mockImplementationOnce(() => new Promise<api.HfModel[]>((resolve) => { releaseFirst = resolve; }))
      .mockResolvedValue([listed("owner/newest")]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    // Re-sort while the opening listing is still in flight.
    fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    fireEvent.click(await screen.findByRole("option", { name: "Most likes" }));
    expect(await screen.findByRole("button", { name: /owner\/newest/ })).toBeVisible();
    releaseFirst([listed("owner/stale")]);
    await waitFor(() => expect(screen.queryByRole("button", { name: /owner\/stale/ })).toBeNull());
    expect(screen.getByRole("button", { name: /owner\/newest/ })).toBeVisible();
  });

  it("marks an already downloaded file installed and does not offer it again", async () => {
    const store = createTestStore({ models_dir: "D:/library" });
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
      { path: "model.Q8_0.gguf", size_bytes: 2000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([
      { path: "model.Q4_K_M.gguf", local_path: "D:/library/hf/owner/model/model.Q4_K_M.gguf", size_bytes: 1000, missing_shards: [] },
    ]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    const present = await screen.findByRole("button", { name: "Installed: model.Q4_K_M.gguf" });
    expect(present).toBeDisabled();
    expect(present).toHaveAttribute("title", "Already downloaded to D:/library/hf/owner/model/model.Q4_K_M.gguf");
    expect(screen.getByRole("button", { name: "Download: model.Q8_0.gguf" })).toBeEnabled();
    // The lookup is scoped to the configured destination, not a fixed folder.
    expect(api.hfInstalledFiles).toHaveBeenCalledWith("owner/model", ["model.Q4_K_M.gguf", "model.Q8_0.gguf"], "D:/library");
  });

  it("reports the parts a split model is still missing", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "big-00001-of-00003.gguf", size_bytes: 10, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([
      { path: "big-00001-of-00003.gguf", local_path: "/library/hf/owner/model/big-00001-of-00003.gguf", size_bytes: 10, missing_shards: ["big-00002-of-00003.gguf", "big-00003-of-00003.gguf"] },
    ]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    expect(await screen.findByText("Incomplete model · 2 of 3 files missing")).toBeVisible();
  });

  it("marks a file installed as soon as its download completes", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfDownloadModel).mockResolvedValue({ path: "/library/hf/owner/model/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 });
    // Leave the confirming re-read outstanding, so only the immediate mark
    // can turn this row into an installed one.
    vi.mocked(api.hfInstalledFiles).mockResolvedValueOnce([]).mockImplementation(() => new Promise<api.HfInstalledFile[]>(() => undefined));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    const present = await screen.findByRole("button", { name: "Installed: model.gguf" });
    expect(present).toBeDisabled();
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith({ active_model: "/library/hf/owner/model/model.gguf" }));
  });

  it("never marks another repository's file of the same name installed", async () => {
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/first"), listed("owner/second")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfInstalledFiles).mockImplementation(async (repoId: string) => repoId === "owner/first"
      ? [{ path: "model.gguf", local_path: "/library/hf/owner/first/model.gguf", size_bytes: 1000, missing_shards: [] }]
      : []);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/first/ }));
    expect(await screen.findByRole("button", { name: "Installed: model.gguf" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /owner\/second/ }));
    // The previous answer must not survive the selection change for even one
    // render: the second repository publishes the same file name.
    expect(screen.queryByRole("button", { name: "Installed: model.gguf" })).toBeNull();
    await clickDownload("Download: model.gguf");
    expect(api.hfDownloadModel).toHaveBeenCalledWith("owner/second", "model.gguf", "models");
  });

  it("does not attach a slow file listing to a repository that is no longer selected", async () => {
    let releaseFiles: (value: api.HfFile[]) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/slow")]);
    vi.mocked(api.hfModelFiles).mockImplementationOnce(() => new Promise<api.HfFile[]>((resolve) => { releaseFiles = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/slow/ }));
    // Searching again clears the selection those files belonged to.
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledTimes(2));
    releaseFiles([{ path: "late.gguf", size_bytes: 1, is_mmproj: false, download_url: "" }]);
    await waitFor(() => expect(screen.getByText("Select a repository to inspect model files.")).toBeVisible());
    expect(screen.queryByText("late.gguf")).toBeNull();
  });

  it("keeps a completed download bound to the repository it was started from", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise((resolve) => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    releaseDownload({ path: "/library/hf/owner/from/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 });
    await waitFor(() => expect(api.hfInstalledFiles).toHaveBeenCalledWith("owner/other", ["model.gguf"], "models"));
    expect(screen.queryByRole("button", { name: "Installed: model.gguf" })).toBeNull();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not open draft confirmation for an already stale automatic completion", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <DraftGuardProvider>
          <DirtyDraft />
          <DiscoverPanel store={store} />
        </DraftGuardProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === "model-download")?.state).toBe("completed"));
    expect(screen.queryByRole("button", { name: "Discard & continue" })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not apply a completed download after its destination changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore({ models_dir: "models" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    store.cfg!.models_dir = "other-models";
    view.rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not replace a newer active model selection with an older download", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/model")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore({ active_model: "models/previous.gguf" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    store.cfg!.active_model = "models/newer.gguf";
    view.rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not call a stale onSelectModel callback after repository selection changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const onSelectModel = vi.fn(async () => undefined);
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} onSelectModel={onSelectModel} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === "model-download")?.state).toBe("completed"));
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("does not apply a stale projector download after repository selection changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "mmproj.gguf", size_bytes: 1000, is_mmproj: true, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download projector: mmproj.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => releaseDownload({ path: "models/mmproj.gguf", repo_id: "owner/from", file_path: "mmproj.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("applies a projector download when its repository and runtime remain current", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "mmproj.gguf", size_bytes: 1000, is_mmproj: true, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockResolvedValue({ path: "models/mmproj.gguf", repo_id: "owner/model", file_path: "mmproj.gguf", size_bytes: 1000 });
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download projector: mmproj.gguf");
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith({ mmproj: "models/mmproj.gguf" }));
  });

  it("rechecks fallback ownership after a draft confirmation is resolved", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <DraftGuardProvider>
          <DirtyDraft />
          <DiscoverPanel store={store} />
        </DraftGuardProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    expect(screen.getByRole("button", { name: "Discard & continue" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Discard & continue" })));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Discard & continue" })).not.toBeInTheDocument());
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["model", "model.gguf", false, { active_model: "models/model.gguf" }],
    ["projector", "mmproj.gguf", true, { mmproj: "models/mmproj.gguf" }],
  ])("applies a valid %s download after its completed task row clears during draft confirmation", async (_kind, file, isMmproj, patch) => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: file, size_bytes: 1000, is_mmproj: isMmproj, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <DraftGuardProvider>
          <DirtyDraft />
          <DiscoverPanel store={store} />
        </DraftGuardProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload(`${isMmproj ? "Download projector" : "Download"}: ${file}`);
    vi.useFakeTimers();
    try {
      await act(async () => releaseDownload({ path: `models/${file}`, repo_id: "owner/model", file_path: file, size_bytes: 1000 }));
      expect(screen.getByRole("button", { name: "Discard & continue" })).toBeVisible();
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.state).toBe("completed");
      act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)).toBeUndefined();
      const toolbar = screen.getByRole("textbox").closest("form");
      expect(toolbar).toHaveAttribute("aria-busy", "true");
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard & continue" }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(store.updateConfig).toHaveBeenCalledWith(patch);
      expect(toolbar).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not revive an old guard action after a replacement task also clears", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <DraftGuardProvider>
          <DirtyDraft />
          <DiscoverPanel store={store} />
        </DraftGuardProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    vi.useFakeTimers();
    try {
      await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
      expect(screen.getByRole("button", { name: "Discard & continue" })).toBeVisible();
      const previous = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
      expect(previous?.state).toBe("completed");
      const replacementCancel = () => Promise.resolve();
      act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous!.startedAt, cancel: replacementCancel }));
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.cancel).toBe(replacementCancel);
      act(() => finishTask(MODEL_DOWNLOAD_TASK_ID, "completed"));
      act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)).toBeUndefined();
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard & continue" }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(store.updateConfig).not.toHaveBeenCalled();
      expect(screen.queryByText("Downloaded and selected model: model.gguf")).not.toBeInTheDocument();
      expect(screen.getByRole("textbox").closest("form")).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles old local busy state without applying after a newer task replaces it", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(
      <I18nProvider initialLocale="en">
        <DraftGuardProvider>
          <DirtyDraft />
          <DiscoverPanel store={store} />
        </DraftGuardProvider>
      </I18nProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    vi.useFakeTimers();
    try {
      await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
      expect(screen.getByRole("button", { name: "Discard & continue" })).toBeVisible();
      const previous = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
      expect(previous?.state).toBe("completed");
      act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)).toBeUndefined();
      const replacementCancel = () => Promise.resolve();
      act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous!.startedAt, cancel: replacementCancel }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard & continue" }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(store.updateConfig).not.toHaveBeenCalled();
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.cancel).toBe(replacementCancel);
      expect(screen.getByRole("button", { name: "Download: model.gguf" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans snapshot busy state when its completed task row clears before the result settles", async () => {
    let releaseSnapshot: (value: api.ModelArtifact) => void = () => undefined;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore({ active_provider: "vllm" });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    const download = await screen.findByRole("button", { name: "Download complete model folder" });
    await waitFor(() => expect(download).toBeEnabled());
    fireEvent.click(download);
    const toolbar = screen.getByRole("textbox").closest("form");
    const artifact: api.ModelArtifact = {
      path: "models/hf/owner/model/snapshots/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "model",
      format: "mlx",
      role: "model",
      size_bytes: 1000,
      file_count: 1,
      architectures: [],
      modalities: { text: true, image: false, audio: false, video: false },
      missing: [],
      incomplete: false,
      ownership: "app",
      notes: [],
    };
    vi.useFakeTimers();
    try {
      act(() => finishTask(MODEL_DOWNLOAD_TASK_ID, "completed"));
      act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)).toBeUndefined();
      await act(async () => releaseSnapshot(artifact));
      expect(screen.getByRole("button", { name: "Configure and run" })).toBeVisible();
      expect(toolbar).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old completion settle a newer global download task", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    const previous = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
    expect(previous?.cancel).toBeTypeOf("function");
    act(() => updateTask(MODEL_DOWNLOAD_TASK_ID, { received: 4 }));
    expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.cancel).toBe(previous?.cancel);
    const replacementCancel = () => Promise.resolve();
    act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous!.startedAt, cancel: replacementCancel }));
    expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.cancel).toBe(replacementCancel);
    act(() => updateTask(MODEL_DOWNLOAD_TASK_ID, { received: 12 }));
    expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.cancel).toBe(replacementCancel);
    await act(async () => releaseDownload({ path: "models/old.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.state).toBe("running"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not let an old cancellation failure alter a newer global download task", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    let rejectCancel: (reason?: unknown) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    vi.mocked(api.hfCancelDownload).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCancel = reject; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledOnce());
    const previous = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
    expect(previous?.cancel).toBeTypeOf("function");
    const replacementCancel = () => Promise.resolve();
    act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous!.startedAt, cancel: replacementCancel }));
    await act(async () => rejectCancel(new Error("old cancel failed")));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.state).toBe("running"));
    expect(screen.queryByText("old cancel failed")).not.toBeInTheDocument();
    await act(async () => releaseDownload({ path: "models/old.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["unmounted", "replaced"] as const)("announces a committed snapshot after its originating panel is %s", async retirement => {
    let releaseSnapshot!: (value: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore({ active_provider: "vllm" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download complete model folder");
    const replacementCancel = () => Promise.resolve();
    if (retirement === "unmounted") view.unmount();
    else act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, cancel: replacementCancel }));
    const changed = vi.fn();
    window.addEventListener(MODEL_CATALOG_CHANGED, changed);
    try {
      await act(async () => releaseSnapshot({ path: "models/committed-snapshot", name: "committed-snapshot",
        format: "hf-safetensors", role: "model", size_bytes: 1000, file_count: 1, architectures: [],
        modalities: { text: true, image: false, audio: false, video: false }, missing: [], incomplete: false, ownership: "app", notes: [] }));
      expect(changed).toHaveBeenCalledTimes(1);
      const task = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
      expect(task?.state).toBe(retirement === "unmounted" ? "completed" : "running");
      if (retirement === "replaced") expect(task?.cancel).toBe(replacementCancel);
      expect(store.updateConfig).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(MODEL_CATALOG_CHANGED, changed);
    }
  });

  it("does not let an old snapshot completion clear a newer global download task", async () => {
    let releaseSnapshot: (value: Awaited<ReturnType<typeof api.hfDownloadSnapshot>>) => void = () => undefined;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore({ active_provider: "vllm" });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download complete model folder");
    const previous = getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID);
    expect(previous?.cancel).toBeTypeOf("function");
    const replacementCancel = () => Promise.resolve();
    act(() => registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous!.startedAt, cancel: replacementCancel }));
    await act(async () => releaseSnapshot({
      path: "models/old-snapshot",
      name: "old-snapshot",
      format: "hf-safetensors",
      role: "model",
      size_bytes: 1000,
      file_count: 1,
      architectures: [],
      modalities: { text: true, audio: false, video: false, image: false },
      missing: [],
      incomplete: false,
      ownership: "app",
      notes: [],
    }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === MODEL_DOWNLOAD_TASK_ID)?.state).toBe("running"));
    expect(screen.queryByText("Download complete")).not.toBeInTheDocument();
  });

  it("says so when the installed-file lookup fails instead of failing the file list", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfInstalledFiles).mockRejectedValue(new Error("command not found"));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    expect(await screen.findByText("Could not check which files are already downloaded.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download: model.gguf" })).toBeEnabled();
  });
});
