import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { isNativeRuntimeAvailable } from "../shared/api/transport";
import { AioMark } from "../shared/ui/AppIcons";
import type { Locale } from "../shared/i18n/i18nCatalog";

/*
 * The desktop title bar, with native macOS or app-drawn frame controls.
 *
 * Windows and Linux use app-drawn captions. macOS reserves the same strip for
 * its real traffic lights over the webview. Native frame detection decides
 * which presentation to draw, without guessing the platform or duplicating
 * controls when frame removal is unavailable. Browser previews draw neither.
 *
 * It is mounted once above every surface, from the first loading screen
 * through setup and the workspace, so the window stays movable and closable
 * even when the app fails to start. It sits outside the i18n provider for that
 * reason and follows the document language the app already publishes.
 */

type NativeWindow = Awaited<ReturnType<typeof frameWindow>> | null;

const copy: Record<Locale, { controls: string; minimize: string; maximize: string; restore: string; close: string }> = {
  en: { controls: "Window controls", minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
  ko: { controls: "창 제어", minimize: "최소화", maximize: "최대화", restore: "이전 크기로 복원", close: "닫기" },
  ja: { controls: "ウィンドウの操作", minimize: "最小化", maximize: "最大化", restore: "元のサイズに戻す", close: "閉じる" },
  zh: { controls: "窗口控制", minimize: "最小化", maximize: "最大化", restore: "向下还原", close: "关闭" },
};

async function frameWindow() {
  const [{ getCurrentWindow }, { invoke }] = await Promise.all([
    import("@tauri-apps/api/window"),
    import("@tauri-apps/api/core"),
  ]);
  const chrome = await invoke<"frameless" | "overlay" | "native">("window_chrome");
  return {
    window: getCurrentWindow(),
    chrome,
    // Linux needs an actual System policy, not tao's setTheme(null), which
    // writes prefer-dark=false. Other platforms retain the SDK behavior.
    setTheme: (theme: "light" | "dark" | null) => invoke<void>("window_theme", { theme }),
  };
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

const readAppearance = () => ({
  locale: readLocale(),
  theme: document.documentElement.dataset.themeMode === "system" ? null
    : document.documentElement.dataset.theme === "dark" ? "dark" as const
    : document.documentElement.dataset.theme === "light" ? "light" as const : null,
});

function useDocumentAppearance() {
  const [appearance, setAppearance] = useState(readAppearance);
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const next = readAppearance();
      setAppearance(previous => previous.locale === next.locale && previous.theme === next.theme ? previous : next);
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang", "data-theme", "data-theme-mode"] });
    return () => observer.disconnect();
  }, []);
  return appearance;
}

// A modal makes the rest of the document inert, regardless of z-index. Move
// the single portal host into the latest opened dialog, not the app itself:
// editors, dirty guards and the native modal focus owner stay mounted.
function useChromeHost(enabled: boolean) {
  const slot = useRef<HTMLDivElement>(null);
  const [host] = useState(() => document.createElement("div"));
  useLayoutEffect(() => {
    if (!enabled || !slot.current) return;
    host.className = "app-titlebar-host";
    document.documentElement.dataset.windowChrome = "custom";
    const stack: HTMLDialogElement[] = Array.from(document.querySelectorAll("dialog[open]"));
    const sync = (records: MutationRecord[] = []) => {
      for (const record of records) {
        if (record.type !== "attributes" || !(record.target instanceof HTMLDialogElement)) continue;
        const dialog = record.target;
        const index = stack.indexOf(dialog);
        if (index >= 0) stack.splice(index, 1);
        if (dialog.open && dialog.isConnected) stack.push(dialog);
      }
      for (let index = stack.length - 1; index >= 0; index--) {
        if (!stack[index].open || !stack[index].isConnected) stack.splice(index, 1);
      }
      const owner = stack.at(-1) ?? slot.current;
      if (owner && host.parentElement !== owner) owner.append(host);
    };
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => {
      observer.disconnect();
      host.remove();
      delete document.documentElement.dataset.windowChrome;
    };
  }, [enabled, host]);
  return { slot, host };
}

export default function TitleBar() {
  const [frame, setFrame] = useState<NativeWindow | undefined>(detected);
  const [maximized, setMaximized] = useState(false);
  const themeUpdate = useRef<Promise<void> | null>(null);
  const { locale, theme } = useDocumentAppearance();
  const text = copy[locale];
  const win = frame?.window;
  const captions = frame?.chrome === "frameless";
  const customChrome = !!frame && frame.chrome !== "native";
  const { slot, host } = useChromeHost(customChrome);
  useEffect(() => {
    let live = true;
    void detectFrameWindow().then((result) => { if (live) setFrame(result); });
    return () => { live = false; };
  }, []);
  useEffect(() => {
    if (!win || !captions) return undefined;
    let live = true;
    let unlisten: (() => void) | undefined;
    const sync = () => { void win.isMaximized().then((value) => { if (live) setMaximized(value); }, () => undefined); };
    sync();
    // Maximizing from the keyboard, a snap or a double-click on the bar all
    // arrive as resizes, so the restore glyph follows every path.
    void win.onResized(sync).then((stop) => { if (live) unlisten = stop; else stop(); }, () => undefined);
    return () => { live = false; unlisten?.(); };
  }, [win, captions]);
  useEffect(() => {
    if (!frame) return undefined;
    let live = true;
    // Keep the native frame's last applied theme aligned with the document,
    // even if an earlier native update finishes after a newer selection.
    themeUpdate.current = (themeUpdate.current ?? Promise.resolve())
      .then(() => { if (live) return frame.setTheme(theme); })
      .catch(error => { console.error("Native window appearance could not be synchronized", error); });
    return () => { live = false; };
  }, [frame, theme]);
  if (!frame || !win || frame.chrome === "native") return null;
  const maximizeLabel = maximized ? text.restore : text.maximize;
  // Only the bar itself carries the drag attribute: the brand ignores the
  // pointer so presses fall through to it, and the buttons stay clickable.
  return <div className="app-titlebar-slot" ref={slot}>{createPortal(<div className="app-titlebar" data-chrome={frame.chrome} data-tauri-drag-region>
    <div className="app-titlebar-brand"><AioMark /><span>AioLM</span></div>
    {captions && <div className="app-titlebar-controls" role="group" aria-label={text.controls}>
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
    </div>}
  </div>, host)}</div>;
}
