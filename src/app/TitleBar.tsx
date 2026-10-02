import { useEffect, useState } from "react";
import { isNativeRuntimeAvailable } from "../shared/api/transport";
import { AioMark } from "../shared/ui/AppIcons";
import type { Locale } from "../shared/i18n/i18nCatalog";

/*
 * The desktop title bar for frameless windows.
 *
 * On Windows and Linux the native side removes the system frame before the
 * window is shown; macOS keeps its native frame and traffic lights. Rather than
 * guess the platform, the bar asks the window whether it is still decorated
 * and appears only when it is not, so a frame that could not be removed keeps
 * the native controls and the browser preview never shows controls it cannot
 * operate.
 *
 * It is mounted once above every surface, from the first loading screen
 * through setup and the workspace, so the window stays movable and closable
 * even when the app fails to start. It sits outside the i18n provider for that
 * reason and follows the document language the app already publishes.
 */

type NativeWindow = Awaited<ReturnType<typeof frameWindow>>;

const copy: Record<Locale, { controls: string; minimize: string; maximize: string; restore: string; close: string }> = {
  en: { controls: "Window controls", minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
  ko: { controls: "창 제어", minimize: "최소화", maximize: "최대화", restore: "이전 크기로 복원", close: "닫기" },
  ja: { controls: "ウィンドウの操作", minimize: "最小化", maximize: "最大化", restore: "元のサイズに戻す", close: "閉じる" },
  zh: { controls: "窗口控制", minimize: "最小化", maximize: "最大化", restore: "向下还原", close: "关闭" },
};

async function frameWindow() {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  const current = getCurrentWindow();
  return (await current.isDecorated()) ? null : current;
}

// The frame is decided once per window, so every mount shares one answer and
// a remount does not flash the bar away while it asks again.
let detection: Promise<NativeWindow> | null = null;
let detected: NativeWindow | undefined;
function detectFrameWindow(): Promise<NativeWindow> {
  detection ??= (isNativeRuntimeAvailable() ? frameWindow() : Promise.resolve(null))
    .catch(() => null)
    .then((result) => { detected = result; return result; });
  return detection;
}

const readLocale = (): Locale => {
  const lang = document.documentElement.lang;
  return lang === "ko" || lang === "ja" || lang === "zh" ? lang : "en";
};

function useDocumentLocale(): Locale {
  const [locale, setLocale] = useState(readLocale);
  useEffect(() => {
    const observer = new MutationObserver(() => setLocale(readLocale()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
    return () => observer.disconnect();
  }, []);
  return locale;
}

export default function TitleBar() {
  const [win, setWin] = useState<NativeWindow | undefined>(detected);
  const [maximized, setMaximized] = useState(false);
  const text = copy[useDocumentLocale()];
  useEffect(() => {
    let live = true;
    void detectFrameWindow().then((result) => { if (live) setWin(result); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!win) return undefined;
    let live = true;
    let unlisten: (() => void) | undefined;
    const sync = () => { void win.isMaximized().then((value) => { if (live) setMaximized(value); }, () => undefined); };
    sync();
    // Maximizing from the keyboard, a snap or a double-click on the bar all
    // arrive as resizes, so the restore glyph follows every path.
    void win.onResized(sync).then((stop) => { if (live) unlisten = stop; else stop(); }, () => undefined);
    return () => { live = false; unlisten?.(); };
  }, [win]);
  if (!win) return null;
  const maximizeLabel = maximized ? text.restore : text.maximize;
  // Only the bar itself carries the drag attribute: the brand ignores the
  // pointer so presses fall through to it, and the buttons stay clickable.
  return <div className="app-titlebar" data-tauri-drag-region>
    <div className="app-titlebar-brand"><AioMark /><span>AioLM</span></div>
    <div className="app-titlebar-controls" role="group" aria-label={text.controls}>
      <button type="button" className="app-titlebar-button" aria-label={text.minimize} title={text.minimize} onClick={() => { void win.minimize().catch(() => undefined); }}>
        <svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"><path d="M0 5.5h10" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
      <button type="button" className="app-titlebar-button" aria-label={maximizeLabel} title={maximizeLabel} onClick={() => { void win.toggleMaximize().catch(() => undefined); }}>
        <svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1">{maximized
          ? <><path d="M2.5 2.5V.5h7v7h-2" /><path d="M.5 2.5h7v7h-7z" /></>
          : <path d="M.5.5h9v9h-9z" />}</svg>
      </button>
      {/* close(), not destroy(): the close request still reaches the native
          handler, so "close to tray" hides the window instead of quitting. */}
      <button type="button" className="app-titlebar-button app-titlebar-button--close" aria-label={text.close} title={text.close} onClick={() => { void win.close().catch(() => undefined); }}>
        <svg aria-hidden="true" viewBox="0 0 10 10" width="10" height="10"><path d="M.5.5l9 9M9.5.5l-9 9" stroke="currentColor" strokeWidth="1" /></svg>
      </button>
    </div>
  </div>;
}
