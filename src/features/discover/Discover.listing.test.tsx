import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import DiscoverPanel from "./Discover";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  onModelDownloadProgress: vi.fn(async () => () => undefined), hfSearchModels: vi.fn(), hfModelFiles: vi.fn(), hfDownloadModel: vi.fn(), hfInstalledFiles: vi.fn(),
}));

const repository = { id: "owner/model", author: "owner", downloads: 12, likes: 3, last_modified: "", tags: [], gated: false };

function listed(id: string) {
  return { ...repository, id };
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
    localStorage.clear();
  });
  afterEach(() => { for (const task of getTaskSnapshot()) removeTask(task.id); });

  it("lists repositories on entry without a search term", async () => {
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    expect(await screen.findByRole("button", { name: /owner\/model/ })).toBeVisible();
    expect(api.hfSearchModels).toHaveBeenCalledWith("", 30, "downloads");
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
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    await clickDownload("Download: model.gguf");
    const present = await screen.findByRole("button", { name: "Installed: model.gguf" });
    expect(present).toBeDisabled();
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
    await waitFor(() => expect(screen.getByText("Select a repository to inspect its GGUF files and choose a quant.")).toBeVisible());
    expect(screen.queryByText("late.gguf")).toBeNull();
  });

  it("keeps a completed download bound to the repository it was started from", async () => {
    let releaseDownload: (value: Awaited<ReturnType<typeof api.hfDownloadModel>>) => void = () => undefined;
    vi.mocked(api.hfSearchModels).mockResolvedValue([listed("owner/from"), listed("owner/other")]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([
      { path: "model.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" },
    ]);
    vi.mocked(api.hfDownloadModel).mockImplementation(() => new Promise((resolve) => { releaseDownload = resolve; }));
    render(<I18nProvider initialLocale="en"><DiscoverPanel store={createTestStore()} /></I18nProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /owner\/from/ }));
    await clickDownload("Download: model.gguf");
    fireEvent.click(screen.getByRole("button", { name: /owner\/other/ }));
    releaseDownload({ path: "/library/hf/owner/from/model.gguf", repo_id: "owner/from", file_path: "model.gguf", size_bytes: 1000 });
    await waitFor(() => expect(api.hfInstalledFiles).toHaveBeenCalledWith("owner/other", ["model.gguf"], "models"));
    expect(screen.queryByRole("button", { name: "Installed: model.gguf" })).toBeNull();
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
