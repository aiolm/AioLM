import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke, isNativeRuntimeAvailable } from "../api/transport";
import { defaultPreferences, savePreferences, type AppPreferences } from "../config/preferences";
import { getNotificationPermission, notifyCompletion, requestNotificationPermission, sendTestNotification } from "./notifications";

vi.mock("../api/transport", () => ({
  invoke: vi.fn(),
  isNativeRuntimeAvailable: vi.fn(() => true),
}));

const invokeMock = vi.mocked(invoke);
const nativeMock = vi.mocked(isNativeRuntimeAvailable);

function savePrefs(notifications: Partial<AppPreferences["notifications"]>, locale: AppPreferences["locale"] = "en") {
  const base = defaultPreferences();
  savePreferences({ ...base, locale, notifications: { ...base.notifications, ...notifications } });
}

/** Native plugin double: permission state plus every notify payload it accepted. */
function plugin(permission: boolean | null = true, notify: () => Promise<unknown> = async () => undefined) {
  const sent: Array<{ title: string; body: string }> = [];
  invokeMock.mockImplementation(async (command: string, args?: Record<string, unknown>) => {
    if (command === "plugin:notification|is_permission_granted") return permission;
    if (command === "plugin:notification|request_permission") return "granted";
    if (command === "plugin:notification|notify") {
      await notify();
      sent.push((args as { options: { title: string; body: string } }).options);
      return undefined;
    }
    throw new Error(`unexpected command ${command}`);
  });
  return sent;
}

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
  nativeMock.mockReturnValue(true);
});

afterEach(() => localStorage.clear());

describe("notification permission", () => {
  it("maps the native permission state without prompting", async () => {
    plugin(true);
    await expect(getNotificationPermission()).resolves.toBe("granted");
    plugin(false);
    await expect(getNotificationPermission()).resolves.toBe("denied");
    plugin(null);
    await expect(getNotificationPermission()).resolves.toBe("default");
    expect(invokeMock).not.toHaveBeenCalledWith("plugin:notification|request_permission");
  });

  it("requests permission only when asked and maps prompt states to default", async () => {
    invokeMock.mockResolvedValueOnce("granted");
    await expect(requestNotificationPermission()).resolves.toBe("granted");
    invokeMock.mockResolvedValueOnce("denied");
    await expect(requestNotificationPermission()).resolves.toBe("denied");
    invokeMock.mockResolvedValueOnce("prompt-with-rationale");
    await expect(requestNotificationPermission()).resolves.toBe("default");
    expect(invokeMock).toHaveBeenCalledWith("plugin:notification|request_permission");
  });

  it("reports the browser preview as unavailable without touching IPC or window.Notification", async () => {
    nativeMock.mockReturnValue(false);
    const browserNotification = vi.fn();
    vi.stubGlobal("Notification", browserNotification);
    try {
      await expect(getNotificationPermission()).resolves.toBe("unavailable");
      await expect(requestNotificationPermission()).resolves.toBe("unavailable");
      await expect(sendTestNotification()).resolves.toBe(false);
      savePrefs({ chat: true });
      await notifyCompletion("chat");
    } finally {
      vi.unstubAllGlobals();
    }
    expect(invokeMock).not.toHaveBeenCalled();
    expect(browserNotification).not.toHaveBeenCalled();
  });

  it("treats a failing permission call as unavailable", async () => {
    invokeMock.mockRejectedValue(new Error("ipc down"));
    await expect(getNotificationPermission()).resolves.toBe("unavailable");
    await expect(requestNotificationPermission()).resolves.toBe("unavailable");
  });
});

describe("sendTestNotification", () => {
  it("submits a localized sample even with every category off", async () => {
    savePrefs({}, "ko");
    const sent = plugin(true);
    await expect(sendTestNotification()).resolves.toBe(true);
    expect(sent).toEqual([{ title: "알림이 켜져 있습니다", body: "작업이 끝나면 AioLM이 여기에서 알려 드립니다." }]);
  });

  it("returns false without sending when permission is not granted", async () => {
    const sent = plugin(false);
    await expect(sendTestNotification()).resolves.toBe(false);
    expect(sent).toEqual([]);
  });

  it("rejects when the native send fails so Settings can report it", async () => {
    plugin(true, async () => { throw new Error("toast failed"); });
    await expect(sendTestNotification()).rejects.toThrow("toast failed");
  });
});

describe("notifyCompletion", () => {
  it("stays silent with default settings", async () => {
    const sent = plugin(true);
    await notifyCompletion("chat");
    await notifyCompletion("download");
    await notifyCompletion("benchmark");
    expect(sent).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("gates each kind on its own category", async () => {
    savePrefs({ downloads: true });
    const sent = plugin(true);
    await notifyCompletion("chat");
    await notifyCompletion("benchmark");
    await notifyCompletion("download");
    expect(sent).toEqual([{ title: "Download complete", body: "A download has finished." }]);
  });

  it("reads settings and locale at finish time, not earlier", async () => {
    const sent = plugin(true);
    savePrefs({ benchmark: false });
    await notifyCompletion("benchmark");
    savePrefs({ benchmark: true }, "ja");
    await notifyCompletion("benchmark");
    expect(sent).toEqual([{ title: "ベンチマーク完了", body: "ベンチマークの実行が完了しました。" }]);
  });

  it("uses generic copy in every locale", async () => {
    const sent = plugin(true);
    for (const locale of ["en", "ko", "ja", "zh"] as const) {
      savePrefs({ chat: true }, locale);
      await notifyCompletion("chat");
    }
    expect(sent.map((item) => item.title)).toEqual(["Response ready", "응답 완료", "応答が完了しました", "回复已完成"]);
  });

  it("does not send or prompt when permission is denied or undecided", async () => {
    savePrefs({ chat: true });
    for (const permission of [false, null]) {
      const sent = plugin(permission);
      await notifyCompletion("chat");
      expect(sent).toEqual([]);
    }
    expect(invokeMock).not.toHaveBeenCalledWith("plugin:notification|request_permission");
  });

  it("swallows native send failures", async () => {
    savePrefs({ chat: true });
    plugin(true, async () => { throw new Error("toast failed"); });
    await expect(notifyCompletion("chat")).resolves.toBeUndefined();
  });
});
