import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../shared/i18n/i18n";
import { createUpdateStore, type AppUpdateInfo, type AppUpdateProgress } from "./updateStore";
import AppUpdateNotice from "./AppUpdateNotice";
import AppUpdateSettings from "./AppUpdateSettings";

const release: AppUpdateInfo = {
  current_version: "1.0.0", latest_version: "1.1.0", available: true, can_install: true,
  release_url: "https://github.com/aiolm/AioLM/releases/tag/v1.1.0", published_at: null, notes: "Improved startup.",
};

function fixture(info = release, native = true) {
  let emit!: (progress: AppUpdateProgress) => void;
  const check = vi.fn(async () => info);
  const install = vi.fn(async (_version: string) => undefined);
  const updater = createUpdateStore({ isNative: () => native, check, install, listen: async callback => { emit = callback; return () => undefined; } });
  return { updater, check, install, emit: (progress: AppUpdateProgress) => emit(progress) };
}

describe("application update surfaces", () => {
  it("announces a newer version once across StrictMode replay and allows opening settings and dismissal", async () => {
    const { updater, check, install } = fixture();
    const open = vi.fn();
    render(<StrictMode><I18nProvider initialLocale="en"><AppUpdateNotice updater={updater} onOpenSettings={open} /></I18nProvider></StrictMode>);
    expect(await screen.findByText("A new AioLM version is available")).toBeVisible();
    expect(screen.getByText("1.0.0 → 1.1.0")).toBeVisible();
    expect(check).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "View update" }));
    expect(open).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("A new AioLM version is available")).not.toBeInTheDocument();
    await act(() => updater.check());
    expect(screen.queryByText("A new AioLM version is available")).not.toBeInTheDocument();
  });

  it("keeps startup network failures out of the app banner while displaying a retry in settings", async () => {
    const { updater, check } = fixture();
    check.mockRejectedValueOnce(new Error("Offline"));
    const { container } = render(<I18nProvider initialLocale="en"><AppUpdateNotice updater={updater} onOpenSettings={vi.fn()} /></I18nProvider>);
    await waitFor(() => expect(updater.getSnapshot().phase).toBe("error"));
    expect(container).toBeEmptyDOMElement();
    render(<I18nProvider initialLocale="en"><AppUpdateSettings updater={updater} /></I18nProvider>);
    expect(screen.getByRole("alert")).toHaveTextContent("Offline");
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("button", { name: "Download and install" })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("requires confirmation before installing and exposes download progress without claiming completion", async () => {
    const { updater, install, emit } = fixture();
    let finish!: () => void;
    install.mockImplementation(() => new Promise(resolve => { finish = () => resolve(undefined); }));
    render(<I18nProvider initialLocale="en"><AppUpdateSettings updater={updater} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download and install" }));
    expect(install).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Install AioLM update?" });
    expect(dialog).toHaveTextContent("Running chats, servers and tasks will stop.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(install).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download and install" }));
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Download and install" }));
    await waitFor(() => expect(install).toHaveBeenCalledExactlyOnceWith("1.1.0"));
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
    act(() => emit({ phase: "downloading", downloaded: 25, total: 100 }));
    expect(screen.getByRole("progressbar", { name: "Update download progress" })).toHaveAttribute("value", "25");
    expect(screen.getByText("25%")).toBeVisible();
    await act(async () => { finish(); });
    expect(screen.getByText("Installer opened. Follow its instructions to finish updating.")).toBeVisible();
  });

  it("disables unsupported installation but still allows update checks", async () => {
    const { updater } = fixture({ ...release, can_install: false });
    const openRelease = vi.fn(async () => undefined);
    render(<I18nProvider initialLocale="en"><AppUpdateSettings updater={updater} openRelease={openRelease} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByRole("button", { name: "Download and install" })).toBeDisabled();
    expect(screen.getByText(/In-app installation is unavailable/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Open release page" }));
    expect(openRelease).toHaveBeenCalledTimes(1);
  });

  it("distinguishes an up-to-date app from a repository with no published release", async () => {
    const { updater, check } = fixture({ ...release, latest_version: "1.0.0", available: false });
    render(<I18nProvider initialLocale="en"><AppUpdateSettings updater={updater} /></I18nProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("AioLM is up to date.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Download and install" })).not.toBeInTheDocument();
    check.mockResolvedValueOnce({ ...release, latest_version: null, available: false });
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(await screen.findByText("No published release is available yet.")).toBeVisible();
  });

  it("shows localized desktop-only guidance in a browser preview", () => {
    const { updater, check } = fixture(release, false);
    render(<I18nProvider initialLocale="ko"><AppUpdateSettings updater={updater} /></I18nProvider>);
    expect(screen.getByText("데스크톱 앱에서 업데이트를 확인할 수 있습니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "업데이트 확인" })).toBeDisabled();
    expect(check).not.toHaveBeenCalled();
  });
});
