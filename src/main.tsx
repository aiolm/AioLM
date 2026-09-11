import { normalizeDisplayText } from "./lifecycleUtils";
import React, { useEffect, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { migrateBrowserStorage, type MigratedPath } from "./storageMigration";
import InitialSurface, { SurfaceLoading } from "./components/InitialSurface";
import "./index.css";
import "./App.css";

const copy = {
 en: { loading: "Preparing your workspace", failed: "Your data could not be migrated", preserved: "Your original data is preserved. Resolve the problem and retry.", retry: "Retry" },
 ko: { loading: "작업 공간을 준비하고 있습니다", failed: "데이터를 이전하지 못했습니다", preserved: "원본 데이터는 보존되어 있습니다. 문제를 해결한 뒤 다시 시도해 주세요.", retry: "다시 시도" },
 ja: { loading: "ワークスペースを準備しています", failed: "データを移行できませんでした", preserved: "元のデータは保持されています。問題を解決して再試行してください。", retry: "再試行" },
 zh: { loading: "正在准备工作空间", failed: "无法迁移数据", preserved: "原始数据已保留。请解决问题后重试。", retry: "重试" },
};
function Bootstrap() {
 const locale = navigator.language.slice(0, 2);
 const text = copy[locale as keyof typeof copy] ?? copy.en;
 const [content, setContent] = useState<ReactNode>(null);
 const [error, setError] = useState("");
 const [attempt, setAttempt] = useState(0);
 useEffect(() => {
  let cancelled = false;
  const start = async () => {
   let paths: MigratedPath[] = [];
   if ("__TAURI_INTERNALS__" in window) {
    const { invoke } = await import("@tauri-apps/api/core");
    paths = await invoke<MigratedPath[]>("migration_paths");
   }
   await migrateBrowserStorage(paths);
   const [{ default: App }, { default: ErrorBoundary }, { I18nProvider }, { loadPreferences }, { applyTheme }] = await Promise.all([
    import("./App"), import("./components/ErrorBoundary"), import("./i18n"), import("./preferences"), import("./theme"),
    document.fonts.load('14px "Pretendard Variable"'),
   ]);
   const preferences = loadPreferences();
   applyTheme(preferences.theme);
   document.documentElement.lang = preferences.locale;
   document.documentElement.dataset.density = preferences.appearance.density;
   document.documentElement.classList.toggle("app-reduce-motion", preferences.appearance.reduceMotion);
   if (!cancelled) setContent(<React.StrictMode><I18nProvider initialLocale={preferences.locale}><ErrorBoundary label="AioLM"><InitialSurface><App /></InitialSurface></ErrorBoundary></I18nProvider></React.StrictMode>);
  };
  void start().catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause)); });
  return () => { cancelled = true; };
 }, [attempt]);
 return content ?? (error ? <div className="app-runtime-empty"><div className="app-empty-state"><div className="app-eyebrow">AioLM · All-In-One LM</div><h1>{text.failed}</h1><p role="alert">{normalizeDisplayText(error)}</p><p>{text.preserved}</p><div className="app-empty-actions"><button className="app-button app-button--primary" onClick={() => { setError(""); setAttempt(n => n + 1); }}>{text.retry}</button></div></div></div> : <SurfaceLoading />);
}
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Bootstrap />);
