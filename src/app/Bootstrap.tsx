import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { normalizeDisplayText } from "../shared/lib/displayPaths";
import { migrateBrowserStorage, type MigratedPath } from "../shared/storage/storageMigration";
import InitialSurface, { SurfaceLoading } from "../shared/ui/InitialSurface";
import TitleBar from "./TitleBar";

// Bootstrap cannot load the normal catalogs or preferences before migration.
const copy = {
  en: {
    failed: "Your data could not be migrated",
    preserved: "Your original data is preserved. Resolve the problem and retry.",
    retry: "Retry",
  },
};

export default function Bootstrap() {
  // No language has been loaded or selected before migration finishes.
  const text = copy.en;
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
        import("./App"),
        import("../shared/ui/ErrorBoundary"),
        import("../shared/i18n/i18n"),
        import("../shared/config/preferences"),
        import("../shared/config/theme"),
        document.fonts.load('14px "Pretendard Variable"'),
      ]);
      const preferences = loadPreferences();
      applyTheme(preferences.theme);
      document.documentElement.lang = preferences.locale;
      document.documentElement.dataset.density = preferences.appearance.density;
      document.documentElement.classList.toggle("app-reduce-motion", preferences.appearance.reduceMotion);
      if (!cancelled) {
        setContent(
          <StrictMode>
            <I18nProvider initialLocale={preferences.locale}>
              <ErrorBoundary label="AioLM">
                <InitialSurface><App /></InitialSurface>
              </ErrorBoundary>
            </I18nProvider>
          </StrictMode>,
        );
      }
    };
    void start().catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { cancelled = true; };
  }, [attempt]);

  const failure = (
    <div className="app-runtime-empty">
      <div className="app-empty-state">
        <div className="app-eyebrow">AioLM · All-In-One LM</div>
        <h1>{text.failed}</h1>
        <p role="alert">{normalizeDisplayText(error)}</p>
        <p>{text.preserved}</p>
        <div className="app-empty-actions">
          <button className="app-button app-button--primary" onClick={() => { setError(""); setAttempt(current => current + 1); }}>
            {text.retry}
          </button>
        </div>
      </div>
    </div>
  );

  // The title bar stays mounted across loading, failure and the app itself, so
  // a frameless window can always be moved and closed, and the app below it is
  // never remounted because of the bar.
  return (
    <div className="app-window">
      <TitleBar />
      <div className="app-window-body">{content ?? (error ? failure : <SurfaceLoading />)}</div>
    </div>
  );
}
