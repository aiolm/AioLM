import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { finishTask, getTaskSnapshot, registerTask, removeTask, TASK_CLEAR_DELAY_MS, updateTask } from "../../shared/state/taskRegistry";
import { resetPendingDownloadsStoreForTests } from "../../shared/state/pendingDownloadsStore";
import { defined } from "../../testing/assertDefined";
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
  hfTokenStatus: vi.fn(async () => ({ configured: false })),
  hfSetToken: vi.fn(async () => ({ configured: true })),
  hfClearToken: vi.fn(async () => ({ configured: false })),
}));

const repository = { id: "owner/model", author: "owner", downloads: 12, likes: 3, last_modified: "", tags: [], gated: false };

function listed(id: string) {
  return { ...repository, id };
}

/** A repository tree with GGUF files and no root safetensors weights. */
function ggufOnly(gguf_files: api.HfFile[]): api.HfRepositoryInspection {
  return { gguf_files, safetensors_files: [], has_root_safetensors: false };
}

function DirtyDraft() {
  useEditorDraft({ dirty: true, save: async () => true, discard: () => undefined });
  return null;
}


/** Folder snapshots are listed under a Safetensors format, which the user picks explicitly. */
function chooseSafetensors() {
  fireEvent.click(screen.getByRole("combobox", { name: "Model format" }));
  fireEvent.click(screen.getByRole("option", { name: "HF Safetensors" }));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([]));
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([]);
    vi.mocked(api.hfInstalledSnapshots).mockResolvedValue([]);
    resetPendingDownloadsStoreForTests();
    localStorage.clear();
  });
  afterEach(() => { resetPendingDownloadsStoreForTests(); for (const task of getTaskSnapshot()) removeTask(task.id); });

  it("opens on trending repositories without a search term and still re-lists by most downloads", async () => {
    // The synthetic Hub ranks a different repository first for each order, so
    // the visible listing shows which order the panel actually requested.
    vi.mocked(api.hfSearchModels).mockImplementation(async (_query, _limit, sort) =>
      sort === "trendingScore" ? [listed("owner/rising")] : sort === "downloads" ? [listed("owner/most-downloaded")] : []);
    render(<I18nProvider initialLocale="ko"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    expect(await screen.findByRole("button", { name: /owner\/rising/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /owner\/most-downloaded/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "정렬" })).toHaveTextContent("인기 급상승순 (Trending)");
    expect(screen.getByRole("textbox")).toHaveValue("");
    expect(api.hfSearchModels).toHaveBeenCalledWith("", 30, "trendingScore", "all");
    fireEvent.click(screen.getByRole("combobox", { name: "정렬" }));
    fireEvent.click(await screen.findByRole("option", { name: "다운로드순" }));
    expect(await screen.findByRole("button", { name: /owner\/most-downloaded/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /owner\/rising/ })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "정렬" })).toHaveTextContent("다운로드순");
    expect(api.hfSearchModels).toHaveBeenLastCalledWith("", 30, "downloads", "all");
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
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledTimes(1));
  });

  it("re-runs the current search in the chosen order", async () => {
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    await screen.findByRole("button", { name: "Search models" });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    await waitFor(() => expect(vi.mocked(api.hfSearchModels).mock.lastCall?.[0]).toBe("qwen"));
    fireEvent.click(screen.getByRole("combobox", { name: "Sort" }));
    fireEvent.click(await screen.findByRole("option", { name: "Most likes" }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenLastCalledWith("qwen", 30, "likes", "all"));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model.Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
      { path: "model.Q8_0.gguf", size_bytes: 2000, is_mmproj: false, download_url: "" },
    ]));
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([
      { path: "model.Q4_K_M.gguf", local_path: "D:/library/hf/owner/model/model.Q4_K_M.gguf", size_bytes: 1000, missing_shards: [] },
    ]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    const present = await screen.findByRole("button", { name: "Installed: model.Q4_K_M.gguf" });
    expect(present).toBeDisabled();
    expect(present).toHaveAttribute("title", String.raw`Already downloaded to D:\library\hf\owner\model\model.Q4_K_M.gguf`);
    expect(screen.getByRole("button", { name: "Download: model.Q8_0.gguf" })).toBeEnabled();
    // The lookup is scoped to the configured destination, not a fixed folder.
    expect(api.hfInstalledFiles).toHaveBeenCalledWith("owner/model", ["model.Q4_K_M.gguf", "model.Q8_0.gguf"], "D:/library");
  });

  it("reports the parts a split model is still missing", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "big-00001-of-00003.gguf", size_bytes: 10, is_mmproj: false, download_url: "" },
    ]));
    vi.mocked(api.hfInstalledFiles).mockResolvedValue([
      { path: "big-00001-of-00003.gguf", local_path: "/library/hf/owner/model/big-00001-of-00003.gguf", size_bytes: 10, missing_shards: ["big-00002-of-00003.gguf", "big-00003-of-00003.gguf"] },
    ]);
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    expect(await screen.findByText("Incomplete model · 2 of 3 files missing")).toBeVisible();
  });

  it("marks a file installed as soon as its download completes", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]));
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
    expect(api.hfDownloadModel).toHaveBeenCalledWith("owner/second", "model.gguf", "models", undefined, undefined, expect.any(String));
  });

  it("recovers repository files in place without rerunning the search or downloading automatically", async () => {
    // The project's ES2020 library predates Promise.withResolvers.
    let finishFiles!: (value: api.HfRepositoryInspection) => void;
    let finishInstalled!: (value: api.HfInstalledFile[]) => void;
    vi.mocked(api.hfModelFiles)
      .mockRejectedValueOnce(new Error("Repository connection failed"))
      .mockImplementationOnce(() => new Promise(resolve => { finishFiles = resolve; }));
    vi.mocked(api.hfInstalledFiles).mockImplementationOnce(() => new Promise(resolve => { finishInstalled = resolve; }));
    const store = createTestStore({ models_dir: "D:/library" });
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    const detail = within(screen.getByRole("region", { name: "Repository files" }));
    expect(await detail.findByRole("alert")).toHaveTextContent("Repository connection failed");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "unsent search" } });
    fireEvent.click(detail.getByRole("button", { name: "Retry" }));
    expect(detail.getByText("Reading repository files")).toBeVisible();
    expect(detail.queryByRole("alert")).not.toBeInTheDocument();
    await act(async () => { finishFiles(ggufOnly([
      { path: "present.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
      { path: "available.gguf", size_bytes: 2000, is_mmproj: false, download_url: "" },
    ])); });
    expect(detail.getByRole("button", { name: "Download: available.gguf" })).toBeDisabled();
    await act(async () => { finishInstalled([
      { path: "present.gguf", local_path: "D:/library/present.gguf", size_bytes: 1000, missing_shards: [] },
    ]); });
    expect(detail.getByRole("button", { name: "Installed: present.gguf" })).toBeDisabled();
    expect(detail.getByRole("button", { name: "Download: available.gguf" })).toBeEnabled();
    expect(screen.getByRole("textbox")).toHaveValue("unsent search");
    expect(screen.getByRole("button", { name: /owner\/model/ })).toHaveAttribute("aria-current", "true");
    expect(api.hfModelFiles).toHaveBeenNthCalledWith(2, "owner/model");
    expect(api.hfSearchModels).toHaveBeenCalledOnce();
    expect(api.hfDownloadModel).not.toHaveBeenCalled();
    expect(api.hfDownloadSnapshot).not.toHaveBeenCalled();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)("ignores a retired retry's late %s after another repository recovers", async outcome => {
    // The project's ES2020 library predates Promise.withResolvers.
    let finishRetired!: (value: api.HfRepositoryInspection) => void;
    let failRetired!: (cause: Error) => void;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/first"), listed("owner/current")]);
    vi.mocked(api.hfModelFiles)
      .mockRejectedValueOnce(new Error("First repository unavailable"))
      .mockImplementationOnce(() => new Promise((resolve, reject) => { finishRetired = resolve; failRetired = reject; }))
      .mockRejectedValueOnce(new Error("Current repository unavailable"))
      .mockResolvedValueOnce(ggufOnly([{ path: "current.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    const detail = within(screen.getByRole("region", { name: "Repository files" }));
    fireEvent.click(await screen.findByRole("button", { name: /owner\/first/ }));
    fireEvent.click(await detail.findByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: /owner\/current/ }));
    expect(await detail.findByRole("alert")).toHaveTextContent("Current repository unavailable");
    fireEvent.click(detail.getByRole("button", { name: "Retry" }));
    const download = await detail.findByRole("button", { name: "Download: current.gguf" });
    await waitFor(() => expect(download).toBeEnabled());
    await act(async () => {
      if (outcome === "success") finishRetired(ggufOnly([{ path: "retired.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
      else failRetired(new Error("Retired repository failed"));
    });
    expect(detail.queryByRole("alert")).not.toBeInTheDocument();
    expect(detail.queryByText("retired.gguf")).not.toBeInTheDocument();
    expect(detail.getByRole("button", { name: "Download: current.gguf" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /owner\/current/ })).toHaveAttribute("aria-current", "true");
    expect(api.hfModelFiles).toHaveBeenNthCalledWith(4, "owner/current");
  });

  it("does not attach a slow file listing to a repository that is no longer selected", async () => {
    let releaseFiles: (value: api.HfRepositoryInspection) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/slow")]);
    vi.mocked(api.hfModelFiles).mockImplementationOnce(() => new Promise<api.HfRepositoryInspection>((resolve) => { releaseFiles = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/slow/ }));
    // Searching again clears the selection those files belonged to.
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    await waitFor(() => expect(api.hfSearchModels).toHaveBeenCalledTimes(2));
    releaseFiles({ gguf_files: [{ path: "late.gguf", size_bytes: 1, is_mmproj: false, download_url: "" }], safetensors_files: [{ path: "model.safetensors", size_bytes: 1000 }], has_root_safetensors: true });
    await waitFor(() => expect(screen.getByText("Select a repository to inspect model files.")).toBeVisible());
    expect(screen.queryByText("late.gguf")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download complete model folder" })).toBeNull();
  });

  it("keeps a completed download bound to the repository it was started from", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
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
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(screen.queryByRole("button", { name: "Discard & continue" })).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not apply a completed download after its destination changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore({ models_dir: "models" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    store.cfg!.models_dir = "other-models";
    view.rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not apply a completed download after the configured engine or runtime changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore({ active_provider: "llama.cpp", active_runtime: "synthetic-llama-runtime" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    store.cfg!.active_provider = "vllm"; store.cfg!.active_runtime = "synthetic-vllm-runtime";
    view.rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not replace a newer active model selection with an older download", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/model")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore({ active_model: "models/previous.gguf" });
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    store.cfg!.active_model = "models/newer.gguf";
    view.rerender(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not call a stale onSelectModel callback after repository selection changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const onSelectModel = vi.fn(async () => undefined);
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} onSelectModel={onSelectModel} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => releaseDownload({ path: "models/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(onSelectModel).not.toHaveBeenCalled();
  });

  it("does not apply a stale projector download after repository selection changes", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "mmproj.gguf", size_bytes: 1000, is_mmproj: true, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download projector: mmproj.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    await act(async () => releaseDownload({ path: "models/mmproj.gguf", repo_id: "owner/from", file_path: "mmproj.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.kind === "model-download")?.state).toBe("completed"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("applies a projector download when its repository and runtime remain current", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "mmproj.gguf", size_bytes: 1000, is_mmproj: true, download_url: "" }]));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: file, size_bytes: 1000, is_mmproj: isMmproj, download_url: "" }]));
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
      const dlTaskId = defined(getTaskSnapshot().find(task => task.kind === "model-download")).id;
      expect(getTaskSnapshot().find(task => task.id === dlTaskId)?.state).toBe("completed");
      await act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === dlTaskId)).toBeUndefined();
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
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
      const previous = defined(getTaskSnapshot().find(task => task.kind === "model-download"));
      expect(previous.state).toBe("completed");
      const replacementCancel = () => Promise.resolve();
      await act(() => registerTask({ id: previous.id, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous.startedAt, cancel: replacementCancel }));
      expect(getTaskSnapshot().find(task => task.id === previous.id)?.cancel).toBe(replacementCancel);
      act(() => finishTask(previous.id, "completed"));
      await act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === previous.id)).toBeUndefined();
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
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
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
      const previous = defined(getTaskSnapshot().find(task => task.kind === "model-download"));
      expect(previous.state).toBe("completed");
      await act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === previous.id)).toBeUndefined();
      const replacementCancel = () => Promise.resolve();
      await act(() => registerTask({ id: previous.id, kind: "model-download", repoId: "owner/model", downloadKind: "gguf", filePath: "model.gguf", label: "replacement", interruptible: true, startedAt: previous.startedAt, cancel: replacementCancel }));
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Discard & continue" }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(store.updateConfig).not.toHaveBeenCalled();
      expect(getTaskSnapshot().find(task => task.id === previous.id)?.cancel).toBe(replacementCancel);
      expect(screen.getByRole("button", { name: "Downloading: model.gguf" })).toBeDisabled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cleans snapshot busy state when its completed task row clears before the result settles", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue({ gguf_files: [], safetensors_files: [{ path: "model.safetensors", size_bytes: 1000 }], has_root_safetensors: true });
    let releaseSnapshot: (value: api.ModelArtifact) => void = () => undefined;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    chooseSafetensors();
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
      const dlTaskId = defined(getTaskSnapshot().find(task => task.kind === "model-download")).id;
      act(() => finishTask(dlTaskId, "completed"));
      await act(() => vi.advanceTimersByTime(TASK_CLEAR_DELAY_MS + 1));
      expect(getTaskSnapshot().find(task => task.id === dlTaskId)).toBeUndefined();
      await act(async () => releaseSnapshot(artifact));
      expect(screen.getByRole("button", { name: "Configure and run" })).toBeVisible();
      expect(toolbar).toHaveAttribute("aria-busy", "false");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an old completion settle a newer global download task", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    const previous = defined(getTaskSnapshot().find(task => task.kind === "model-download"));
    expect(previous.cancel).toBeTypeOf("function");
    act(() => updateTask(previous.id, { received: 4 }));
    expect(getTaskSnapshot().find(task => task.id === previous.id)?.cancel).toBe(previous.cancel);
    const replacementCancel = () => Promise.resolve();
    await act(() => registerTask({ id: previous.id, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous.startedAt, cancel: replacementCancel }));
    expect(getTaskSnapshot().find(task => task.id === previous.id)?.cancel).toBe(replacementCancel);
    act(() => updateTask(previous.id, { received: 12 }));
    expect(getTaskSnapshot().find(task => task.id === previous.id)?.cancel).toBe(replacementCancel);
    await act(async () => releaseDownload({ path: "models/old.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === previous.id)?.state).toBe("running"));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it("does not let an old cancellation failure alter a newer global download task", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    let rejectCancel: (reason?: unknown) => void = () => undefined;
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([{ path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]));
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise(resolve => { releaseDownload = resolve; }));
    vi.mocked(api.hfCancelDownload).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectCancel = reject; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    const previous = defined(getTaskSnapshot().find(task => task.kind === "model-download"));
    expect(previous.cancel).toBeTypeOf("function");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledOnce());
    const replacementCancel = () => Promise.resolve();
    await act(() => registerTask({ id: previous.id, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous.startedAt, cancel: replacementCancel }));
    await act(async () => rejectCancel(new Error("old cancel failed")));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === previous.id)?.state).toBe("running"));
    expect(screen.queryByText("old cancel failed")).not.toBeInTheDocument();
    await act(async () => releaseDownload({ path: "models/old.gguf", repo_id: "owner/model", file_path: "model.gguf", size_bytes: 1000 }));
    expect(store.updateConfig).not.toHaveBeenCalled();
  });

  it.each(["unmounted", "replaced"] as const)("announces a committed snapshot after its originating panel is %s", async retirement => {
    vi.mocked(api.hfModelFiles).mockResolvedValue({ gguf_files: [], safetensors_files: [{ path: "model.safetensors", size_bytes: 1000 }], has_root_safetensors: true });
    let releaseSnapshot!: (value: api.ModelArtifact) => void;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore();
    const view = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    chooseSafetensors();
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download complete model folder");
    const previousId = defined(getTaskSnapshot().find(task => task.kind === "model-download")).id;
    const replacementCancel = () => Promise.resolve();
    if (retirement === "unmounted") view.unmount();
    else await act(() => registerTask({ id: previousId, kind: "model-download", label: "replacement", interruptible: true, cancel: replacementCancel }));
    const changed = vi.fn();
    window.addEventListener(MODEL_CATALOG_CHANGED, changed);
    try {
      await act(async () => releaseSnapshot({ path: "models/committed-snapshot", name: "committed-snapshot",
        format: "hf-safetensors", role: "model", size_bytes: 1000, file_count: 1, architectures: [],
        modalities: { text: true, image: false, audio: false, video: false }, missing: [], incomplete: false, ownership: "app", notes: [] }));
      expect(changed).toHaveBeenCalledTimes(1);
      const task = getTaskSnapshot().find(item => item.id === previousId);
      expect(task?.state).toBe(retirement === "unmounted" ? "completed" : "running");
      if (retirement === "replaced") expect(task?.cancel).toBe(replacementCancel);
      expect(store.updateConfig).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener(MODEL_CATALOG_CHANGED, changed);
    }
  });

  it("does not let an old snapshot completion clear a newer global download task", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue({ gguf_files: [], safetensors_files: [{ path: "model.safetensors", size_bytes: 1000 }], has_root_safetensors: true });
    let releaseSnapshot: (value: Awaited<ReturnType<typeof api.hfDownloadSnapshot>>) => void = () => undefined;
    vi.mocked(api.hfDownloadSnapshot).mockImplementation(() => new Promise(resolve => { releaseSnapshot = resolve; }));
    const store = createTestStore();
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    chooseSafetensors();
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download complete model folder");
    const previous = defined(getTaskSnapshot().find(task => task.kind === "model-download"));
    expect(previous.cancel).toBeTypeOf("function");
    const replacementCancel = () => Promise.resolve();
    await act(() => registerTask({ id: previous.id, kind: "model-download", label: "replacement", interruptible: true, startedAt: previous.startedAt, cancel: replacementCancel }));
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
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === previous.id)?.state).toBe("running"));
    expect(screen.queryByText("Download complete")).not.toBeInTheDocument();
  });

  it("downloads multiple GGUF files concurrently and pauses one independently", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model-Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
      { path: "model-Q8_0.gguf", size_bytes: 2000, is_mmproj: false, download_url: "" },
    ]));
    const pendingResolvers = new Map<string, { resolve: (value: api.DownloadedModel) => void; reject: (err: Error) => void }>();
    vi.mocked(api.hfDownloadModel).mockImplementation(async (_repoId, filePath) =>
      new Promise<api.DownloadedModel>((resolve, reject) => {
        pendingResolvers.set(filePath, { resolve, reject });
      }),
    );

    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model-Q4_K_M.gguf");
    await clickDownload("Download: model-Q8_0.gguf");

    expect(api.hfDownloadModel).toHaveBeenCalledTimes(2);
    expect(getTaskSnapshot().filter(task => task.kind === "model-download" && task.state === "running")).toHaveLength(2);
    const pauseButtons = screen.getAllByRole("button", { name: "Pause" });
    expect(pauseButtons).toHaveLength(2);
    const q4DownloadId = defined(vi.mocked(api.hfDownloadModel).mock.calls[0]?.[5]);
    const q4Row = pauseButtons[0]!.closest<HTMLElement>('[role="listitem"]')!;
    fireEvent.click(within(q4Row).getByRole("button", { name: "Pause" }));
    await waitFor(() => expect(api.hfCancelDownload).toHaveBeenCalledWith(q4DownloadId));
  });

  it("says so when the installed-file lookup fails instead of failing the file list", async () => {
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]));
    vi.mocked(api.hfInstalledFiles).mockRejectedValue(new Error("command not found"));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    expect(await screen.findByText("Could not check which files are already downloaded.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Download: model.gguf" })).toBeEnabled();
  });

  it("clears catalog search, filters in-repo files with type=search, manages HF token, and links gated warning", async () => {
    vi.mocked(api.hfSearchModels).mockResolvedValue([
      { ...repository, id: "owner/gated-repo", gated: true },
    ]);
    vi.mocked(api.hfModelFiles).mockResolvedValue(ggufOnly([
      { path: "model-Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
      { path: "model-F16.gguf", size_bytes: 2000, is_mmproj: false, download_url: "" },
    ]));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);

    const catalogSearch = screen.getByRole("textbox");
    fireEvent.change(catalogSearch, { target: { value: "qwen" } });
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    expect(catalogSearch).toHaveValue("");
    expect(catalogSearch).toHaveFocus();

    fireEvent.click(await screen.findByRole("button", { name: /owner\/gated-repo/ }));
    expect(await screen.findByText("Gated repository")).toBeVisible();

    const fileFilter = screen.getByLabelText("Filter repository files");
    expect(fileFilter).toHaveAttribute("type", "search");
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(fileFilter, { target: { value: "Q4_K_M" } });
    expect(screen.getByRole("button", { name: "Download: model-Q4_K_M.gguf" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download: model-F16.gguf" })).not.toBeInTheDocument();

    fireEvent.change(fileFilter, { target: { value: "nomatch" } });
    expect(screen.getByText("No repository files match the filter.")).toBeVisible();
    fireEvent.click(screen.getAllByRole("button", { name: "Clear filter" })[0]!);
    expect(screen.getByRole("button", { name: "Download: model-F16.gguf" })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Configure token" }));
    const tokenInput = screen.getByLabelText("Access token");
    expect(tokenInput).toHaveAttribute("type", "password");
    await waitFor(() => expect(tokenInput).toHaveFocus());
    fireEvent.change(tokenInput, { target: { value: "hf_synthetic_test_token" } });
    fireEvent.click(screen.getByRole("button", { name: "Save token" }));
    await waitFor(() => expect(api.hfSetToken).toHaveBeenCalledWith("hf_synthetic_test_token"));
    expect(await screen.findByText("Hugging Face access token saved.")).toBeVisible();
    expect(screen.getByText("Token saved")).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Clear token" }));
    await waitFor(() => expect(api.hfClearToken).toHaveBeenCalledOnce());
    expect(await screen.findByText("Hugging Face access token removed.")).toBeVisible();
    expect(screen.getByText("Not set")).toBeVisible();
  });

  it("does not freeze searching when re-selecting the active format in flight or when typing a new query", async () => {
    let resolveFirst!: (value: api.HfModel[]) => void;
    vi.mocked(api.hfSearchModels).mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);

    expect(screen.getByRole("button", { name: "Scanning" })).toBeDisabled();
    // Re-selecting the currently selected format while a search is in flight must not retire the spinner without stopping it.
    fireEvent.click(screen.getByRole("combobox", { name: "Model format" }));
    fireEvent.click(screen.getByRole("option", { name: "All formats" }));
    expect(api.hfSearchModels).toHaveBeenCalledTimes(1);

    await act(async () => resolveFirst([listed("owner/initial")]));
    expect(await screen.findByRole("button", { name: /owner\/initial/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Search models" })).toBeEnabled();

    // Re-selecting the already-active format while idle must not wipe results or search on keystrokes.
    fireEvent.click(screen.getByRole("combobox", { name: "Model format" }));
    fireEvent.click(screen.getByRole("option", { name: "All formats" }));
    expect(screen.getByRole("button", { name: /owner\/initial/ })).toBeVisible();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "H" } });
    expect(api.hfSearchModels).toHaveBeenCalledTimes(1);
  });

  it("lets a new query supersede a slow in-flight search immediately", async () => {
    let resolveOpening!: (value: api.HfModel[]) => void;
    let resolveHy4!: (value: api.HfModel[]) => void;
    vi.mocked(api.hfSearchModels)
      .mockImplementationOnce(() => new Promise(resolve => { resolveOpening = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveHy4 = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);

    expect(screen.getByRole("button", { name: "Scanning" })).toBeDisabled();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Hy4" } });
    // Once the query diverges from the in-flight search, submit becomes enabled immediately.
    const submit = screen.getByRole("button", { name: "Search models" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(api.hfSearchModels).toHaveBeenNthCalledWith(2, "Hy4", 30, "trendingScore", "all");
    expect(screen.getByRole("button", { name: "Scanning" })).toBeDisabled();

    await act(async () => resolveOpening([listed("owner/opening")]));
    expect(screen.queryByRole("button", { name: /owner\/opening/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Scanning" })).toBeDisabled();

    await act(async () => resolveHy4([listed("owner/Hy4-model")]));
    expect(await screen.findByRole("button", { name: /owner\/Hy4-model/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Search models" })).toBeEnabled();
  });
});
