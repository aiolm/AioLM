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

const mount = (preferences: AppPreferences = defaultPreferences(), locale: AppPreferences["locale"] = "en") => {
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

  it("reads notification access and requests it explicitly from the Allow button", async () => {
    mount();
    expect(notifications.getNotificationPermission).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(await screen.findByText("Not allowed yet")).toBeInTheDocument();
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Send test notification" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "Allow notifications" }));
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
    expect(notifications.requestNotificationPermission).toHaveBeenCalledTimes(1);
    // Submission readiness cannot confirm system approval or alert display.
    expect(screen.getByText(/Your system may ask for permission on the first notification, including a test/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    expect(await screen.findByText(/Test notification submitted to the system/)).toBeInTheDocument();
  });

  it.each([
    { locale: "en", tab: "Notifications", ready: "Ready to send", oldGranted: "Allowed", firstPrompt: "Your system may ask for permission on the first notification, including a test", send: "Send test notification", submitted: "Test notification submitted to the system." },
    { locale: "ko", tab: "알림", ready: "전송 가능", oldGranted: "허용됨", firstPrompt: "시스템이 테스트를 포함한 첫 알림에서 권한을 물을 수 있으며", send: "테스트 알림 보내기", submitted: "시스템에 테스트 알림 전송을 요청했습니다." },
    { locale: "ja", tab: "通知", ready: "送信可能", oldGranted: "許可済み", firstPrompt: "テストを含む最初の通知でシステムが許可を求める場合があり", send: "テスト通知を送信", submitted: "システムにテスト通知の送信を依頼しました。" },
    { locale: "zh", tab: "通知", ready: "可发送", oldGranted: "已允许", firstPrompt: "系统可能在首次通知（包括测试通知）时请求权限", send: "发送测试通知", submitted: "已向系统提交测试通知。" },
  ] as const)("describes available notification submission without claiming system approval in $locale", async (copy) => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("granted");
    const update = mount(defaultPreferences(), copy.locale);
    fireEvent.click(screen.getByRole("tab", { name: copy.tab }));
    expect(await screen.findByText(copy.ready)).toBeInTheDocument();
    expect(screen.queryByText(copy.oldGranted)).not.toBeInTheDocument();
    expect(screen.getByText((text) => text.includes(copy.firstPrompt))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: copy.send }));
    expect(await screen.findByText((text) => text.startsWith(copy.submitted))).toBeInTheDocument();
    expect(notifications.sendTestNotification).toHaveBeenCalledTimes(1);
    expect(notifications.requestNotificationPermission).not.toHaveBeenCalled();
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    for (const category of screen.getAllByRole("switch")) expect(category).toHaveAttribute("aria-checked", "false");
    expect(update).not.toHaveBeenCalled();
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
    expect(await screen.findByText("No test notification was submitted. Check your system notification settings and try again.")).toBeInTheDocument();
  });

  it("explains blocked notifications and offers a recheck instead of a prompt", async () => {
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("denied");
    mount();
    fireEvent.click(screen.getByRole("tab", { name: "Notifications" }));
    expect(await screen.findByText(/Notifications are blocked for AioLM/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Allow notifications" })).not.toBeInTheDocument();
    vi.mocked(notifications.getNotificationPermission).mockResolvedValue("granted");
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText("Ready to send")).toBeInTheDocument();
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
