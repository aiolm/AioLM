import { invoke, isNativeRuntimeAvailable } from "../api/transport";
import { loadPreferences, type NotificationPreferences } from "../config/preferences";
import type { Locale } from "../i18n/i18nCatalog";

/**
 * Operating-system notifications for finished work.
 *
 * Every desktop OS goes through the official Tauri notification plugin. Its
 * commands are invoked directly rather than through the plugin's JavaScript
 * wrappers: `sendNotification` is fire-and-forget through a patched
 * `window.Notification`, so a failure never reaches the caller, and on Windows
 * the wrapper's permission check reads a cached "denied" until a request has
 * been made in the same session, which would silence every alert after a
 * restart. The browser preview has no native runtime and reports
 * "unavailable"; the browser's own Notification API is never used.
 *
 * Desktop limits of the plugin: permission is always reported as granted
 * without an OS prompt, and `notify` resolves once the toast has been prepared
 * and handed to the OS. Whether the OS then shows it (Focus Assist, per-app
 * settings, an unregistered app identity in development builds on Windows) is
 * not observable, so a resolved call means "submitted", not "delivered".
 */

export type NotificationPermission = "granted" | "denied" | "default" | "unavailable";
export type CompletionNotificationKind = "chat" | "download" | "benchmark";

const CATEGORY: Record<CompletionNotificationKind, keyof NotificationPreferences> = {
  chat: "chat",
  download: "downloads",
  benchmark: "benchmark",
};

type NoticeCopy = { title: string; body: string };

// Generic on purpose: an alert can appear on a lock screen or a shared
// display, so it never carries prompts, answers, file names, paths or ids.
const COPY: Record<Locale, Record<CompletionNotificationKind | "test", NoticeCopy>> = {
  en: {
    chat: { title: "Response ready", body: "AioLM finished writing a reply." },
    download: { title: "Download complete", body: "A download has finished." },
    benchmark: { title: "Benchmark complete", body: "The benchmark run has finished." },
    test: { title: "Notifications are on", body: "AioLM will notify you here when work finishes." },
  },
  ko: {
    chat: { title: "응답 완료", body: "AioLM이 답변 작성을 마쳤습니다." },
    download: { title: "다운로드 완료", body: "다운로드가 끝났습니다." },
    benchmark: { title: "벤치마크 완료", body: "벤치마크 실행이 끝났습니다." },
    test: { title: "알림이 켜져 있습니다", body: "작업이 끝나면 AioLM이 여기에서 알려 드립니다." },
  },
  ja: {
    chat: { title: "応答が完了しました", body: "AioLM が返信を書き終えました。" },
    download: { title: "ダウンロード完了", body: "ダウンロードが完了しました。" },
    benchmark: { title: "ベンチマーク完了", body: "ベンチマークの実行が完了しました。" },
    test: { title: "通知はオンです", body: "作業が終わると AioLM がここでお知らせします。" },
  },
  zh: {
    chat: { title: "回复已完成", body: "AioLM 已完成回复。" },
    download: { title: "下载完成", body: "下载已完成。" },
    benchmark: { title: "基准测试完成", body: "基准测试运行已完成。" },
    test: { title: "通知已开启", body: "任务完成时，AioLM 会在这里通知你。" },
  },
};

function fromPluginState(state: unknown): NotificationPermission {
  if (state === "granted" || state === true) return "granted";
  if (state === "denied" || state === false) return "denied";
  return "default";
}

/** Read the current permission. Never prompts and never rejects. */
export async function getNotificationPermission(): Promise<NotificationPermission> {
  if (!isNativeRuntimeAvailable()) return "unavailable";
  try {
    // `null` is the plugin's "not decided yet".
    return fromPluginState(await invoke<boolean | null>("plugin:notification|is_permission_granted"));
  } catch {
    return "unavailable";
  }
}

/**
 * Ask the OS for permission. Only an explicit Settings action calls this;
 * neither startup nor a finished task ever prompts.
 */
export async function requestNotificationPermission(): Promise<NotificationPermission> {
  if (!isNativeRuntimeAvailable()) return "unavailable";
  try {
    return fromPluginState(await invoke<string>("plugin:notification|request_permission"));
  } catch {
    return "unavailable";
  }
}

async function submit(copy: NoticeCopy): Promise<void> {
  await invoke<void>("plugin:notification|notify", { options: { title: copy.title, body: copy.body } });
}

/**
 * Send a sample notification regardless of the category toggles.
 *
 * Resolves true when the native call accepted it (submitted, not necessarily
 * displayed) and false when permission is missing or there is no native
 * runtime. A failing native call rejects so Settings can show the error.
 */
export async function sendTestNotification(): Promise<boolean> {
  if ((await getNotificationPermission()) !== "granted") return false;
  await submit(COPY[loadPreferences().locale].test);
  return true;
}

/**
 * Announce a finished job when the user turned that category on.
 *
 * Settings are read now rather than when the job started, so a toggle changed
 * mid-run applies to that run. This never rejects: an alert that fails must
 * not turn the work it reports into an error.
 */
export async function notifyCompletion(kind: CompletionNotificationKind): Promise<void> {
  try {
    const preferences = loadPreferences();
    if (!preferences.notifications[CATEGORY[kind]]) return;
    if ((await getNotificationPermission()) !== "granted") return;
    await submit(COPY[preferences.locale][kind]);
  } catch {
    // Nothing to recover; the job itself already succeeded.
  }
}
