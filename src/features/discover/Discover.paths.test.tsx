import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createTestStore } from "../../testing/appStore";
import DiscoverPanel from "./Discover";

vi.mock("../../shared/api/index", () => ({
  onModelDownloadProgress: vi.fn(async () => () => undefined), hfSearchModels: vi.fn(), hfModelFiles: vi.fn(), hfDownloadModel: vi.fn(),
}));

describe("Discover path presentation", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cleans destination tooltips and download failures while passing the stored destination to downloads", async () => {
    const raw = String.raw`\\?\UNC\server\share\models`;
    const display = String.raw`\\server\share\models`;
    const store = createTestStore({ models_dir: raw });
    vi.mocked(api.hfSearchModels).mockResolvedValue([{ id: "owner/model", author: "owner", downloads: 1, likes: 1, last_modified: "", tags: [], gated: false }]);
    vi.mocked(api.hfModelFiles).mockResolvedValue([{ path: "model.Q4_K_M.gguf", size_bytes: 1000, is_mmproj: false, download_url: "" }]);
    vi.mocked(api.hfDownloadModel).mockRejectedValue(new Error(`Cannot write ${raw}`));
    const { container } = render(<I18nProvider initialLocale="en"><DiscoverPanel store={store} /></I18nProvider>);
    expect(screen.getByText(display)).toHaveAttribute("title", display);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "Search models" }));
    fireEvent.click(await screen.findByRole("button", { name: /owner\/model/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Download: model.Q4_K_M.gguf" }));
    await waitFor(() => expect(api.hfDownloadModel).toHaveBeenCalledWith("owner/model", "model.Q4_K_M.gguf", raw));
    expect(await screen.findByText(`Cannot write ${display}`)).toBeInTheDocument();
    expect(container.textContent).not.toContain('\\\\?\\');
    expect(store.cfg?.models_dir).toBe(raw);
  });
});
