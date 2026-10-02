import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "../../shared/i18n/i18n";
import { defaultPreferences, type AppPreferences } from "../../shared/config/preferences";
import * as notifications from "../../shared/lib/notifications";
import SettingsPanel from "./Settings";

vi.mock("../../shared/api/index", () => ({ isNativeRuntimeAvailable: () => true }));
vi.mock("../../shared/lib/notifications", () => ({
  getNotificationPermission: vi.fn(),
  requestNotificationPermission: vi.fn(),
  sendTestNotification: vi.fn(),
}));

const mount = (preferences: AppPreferences = defaultPreferences(), locale: "en" | "ko" = "en") => {
  const update = vi.fn();
  render(<I18nProvider initialLocale={locale}><SettingsPanel preferences={preferences} update={update} reset={vi.fn()} /></I18nProvider>);
  return update;
};
const choose = (combobox: string, option: string) => {
  fireEvent.click(screen.getByRole("combobox", { name: combobox }));
  fireEvent.click(screen.getByRole("option", { name: option }));
};

describe("typography preferences", () => {
  it("patches the app and code fonts and previews them immediately", () => {
    const update = mount({ ...defaultPreferences(), appearance: { ...defaultPreferences().appearance, fontFamily: "serif", codeFontFamily: "system" } });
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    const preview = screen.getByRole("figure", { name: "Font preview" });
    expect(preview.querySelector("p")!.style.fontFamily).toMatch(/serif$/);
    expect(preview.querySelector("code")!.style.fontFamily).toMatch(/monospace$/);

    choose("App font", "System sans-serif");
    expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ fontFamily: "system", codeFontFamily: "system", density: "comfortable" }) });
    choose("Code font", "AioLM default");
    expect(update).toHaveBeenLastCalledWith({ appearance: expect.objectContaining({ fontFamily: "serif", codeFontFamily: "default" }) });
  });

  it("previews the default fonts through the stylesheet tokens", () => {
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }));
    const preview = screen.getByRole("figure", { name: "Font preview" });
    expect(preview.querySelector("p")!.style.fontFamily).toBe("var(--font-sans)");
    expect(preview.querySelector("code")!.style.fontFamily).toBe("var(--font-chat-code)");
  });

  it("patches chat line spacing and previews the chosen leading", () => {
    const update = mount({ ...defaultPreferences(), chat: { ...defaultPreferences().chat, lineSpacing: "relaxed" } });
    fireEvent.click(screen.getByRole("tab", { name: "Chat" }));
    expect(screen.getByRole("figure", { name: "Line spacing preview" }).querySelector("p")!.style.lineHeight).toBe("1.9");
    choose("Chat line spacing", "Compact");
    expect(update).toHaveBeenLastCalledWith({ chat: { ...defaultPreferences().chat, lineSpacing: "compact" } });
  });

  it("resets typography through the existing appearance and chat resets", () => {
    const update = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset appearance" }));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ appearance: expect.objectContaining({ fontFamily: "default", codeFontFamily: "default" }) }));
    fireEvent.click(screen.getByRole("button", { name: "Reset chat" }));
    expect(update).toHaveBeenLastCalledWith({ chat: expect.objectContaining({ lineSpacing: "normal" }) });
  });
});

describe("notification preferences", () => {
  beforeEach(() => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("default");
    vi.mocked(notifications.requestNotificationPermission).mockResolvedValue("granted");
    vi.mocked(notifications.sendTestNotification).mockResolvedValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it("reads permission without prompting and asks only from the Allow button", async () => {
    mount();
    expect(notifications.getNotificationPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(await screen.findByText("Not allowed yet")).toBeInTheDocument();
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(notifications.requestNotificationPermission).toHaveBeenCalledTimes(1);
    // Desktop permission cannot see OS-level muting, so the hint stays visible.
    expect(screen.getByText(/managed in your system notification settings/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(await screen.findByText(/Test notification sent/)).toBeInTheDocument();
  });

  it("reports test failures without raw error details", async () => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("granted");
    vi.mocked(notifications.sendTestNotification).mockRejectedValueOnce(new Error("plugin:notification|notify failed"));
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    fireEvent.click(await screen.findByRole("button", { name: "Send test notification" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The test notification could not be sent.");
    expect(alert).not.toHaveTextContent("plugin:");

    vi.mocked(notifications.sendTestNotification).mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(await screen.findByText("Notifications are not allowed, so nothing was sent.")).toBeInTheDocument();
  });

  it("explains blocked notifications and offers a recheck instead of a prompt", async () => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("denied");
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(await screen.findByText(/Notifications are blocked for AioLM/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).not.toBeInTheDocument();
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("granted");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Allowed")).toBeInTheDocument();
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
  });

  it("keeps categories configurable where notifications are unavailable", async () => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("unavailable");
    const update = mount();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(await screen.findByText(/System notifications work in the AioLM desktop app/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).not.toBeInTheDocument();

    const chat = screen.getByRole("switch", { name: "Chat responses" });
    expect(chat).toHaveAttribute("aria-checked", "false");
    expect(chat).toBeEnabled();
    fireEvent.click(chat);
    expect(update).toHaveBeenLastCalledWith({ notifications: { chat: true, downloads: false, benchmark: false } });
    fireEvent.click(screen.getByRole("switch", { name: "Downloads" }));
    expect(update).toHaveBeenLastCalledWith({ notifications: { chat: false, downloads: true, benchmark: false } });
    fireEvent.click(screen.getByRole("switch", { name: "Benchmarks" }));
    expect(update).toHaveBeenLastCalledWith({ notifications: { chat: false, downloads: false, benchmark: true } });
  });

  it("resets notification categories to off", () => {
    const update = mount({ ...defaultPreferences(), notifications: { chat: true, downloads: true, benchmark: true } });
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset notifications" }));
    expect(update).toHaveBeenLastCalledWith({ notifications: { chat: false, downloads: false, benchmark: false } });
  });

  it("is localized", async () => {
    mount(defaultPreferences(), "ko");
    fireEvent.click(screen.getByRole("tab", { name: "알림" }));
    expect(await screen.findByRole("button", { name: "알림 허용" })).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "채팅 응답" })).toBeInTheDocument();
  });
});
