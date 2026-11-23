import { StrictMode, useEffect, useState, type ReactNode } from "react";
import { migrationPaths } from "../shared/api/desktop";
import { errorMessage } from "../shared/api/errors";
import { isNativeRuntimeAvailable } from "../shared/api/transport";
import { normalizeDisplayText } from "../shared/lib/displayPaths";
import { migrateBrowserStorage, type MigratedPath } from "../shared/storage/storageMigration";
import InitialSurface, { SurfaceLoading } from "../shared/ui/InitialSurface";
import TitleBar from "./TitleBar";

// Bootstrap cannot load the normal catalogs or preferences before migration.
const copy = {
  en: {
    migrationFailed: "Your data could not be migrated",
    migrationPreserved: "Your original data is preserved. Resolve the problem and retry.",
    startupFailed: "AioLM could not start",
    startupPreserved: "Resolve the problem and retry.",
    retry: "Retry",
  },
  ko: {
    migrationFailed: "데이터를 마이그레이션하지 못했습니다",
    migrationPreserved: "원본 데이터는 그대로 보존되어 있습니다. 문제를 해결한 뒤 다시 시도해 주세요.",
    startupFailed: "AioLM을 시작할 수 없습니다",
    startupPreserved: "문제를 해결한 뒤 다시 시도해 주세요.",
    retry: "다시 시도",
  },
  ja: {
    migrationFailed: "データを移行できませんでした",
    migrationPreserved: "元のデータはそのまま保護されています。問題を解決してから再試行してください。",
    startupFailed: "AioLM を起動できませんでした",
    startupPreserved: "問題を解決してから再試行してください。",
    retry: "再試行",
  },
  zh: {
    migrationFailed: "无法迁移您的数据",
    migrationPreserved: "您的原始数据已完整保留。解决问题后请重试。",
    startupFailed: "无法启动 AioLM",
    startupPreserved: "解决问题后请重试。",
    retry: "重试",
  },
} as const;

function resolveBootstrapLocale(): keyof typeof copy {
  const lang = (typeof navigator !== "undefined" ? navigator.language : "en").toLowerCase();
  if (lang.startsWith("ko")) return "ko";
  if (lang.startsWith("ja")) return "ja";
  if (lang.startsWith("zh")) return "zh";
  return "en";
}

export default function Bootstrap() {
  // No language has been loaded or selected before migration finishes.
  const text = copy[resolveBootstrapLocale()];
  const [content, setContent] = useState<ReactNode>(null);
  const [error, setError] = useState<{ phase: "migration" | "startup"; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let phase: "migration" | "startup" = "migration";
    const start = async () => {
      let paths: MigratedPath[] = [];
      if (isNativeRuntimeAvailable()) paths = await migrationPaths();
      await migrateBrowserStorage(paths);
      phase = "startup";

      const [{ default: App }, { default: ErrorBoundary }, { I18nProvider, detectLocale, loadLocale }, { loadPreferences }, { applyTheme }, { applyTypography }] = await Promise.all([
        import("./App"),
        import("../shared/ui/ErrorBoundary"),
        import("../shared/i18n/i18n"),
        import("../shared/config/preferences"),
        import("../shared/config/theme"),
        import("../shared/config/typography"),
        document.fonts.load('14px "Pretendard Variable"').catch(() => undefined),
      ]);
      const preferences = loadPreferences(detectLocale?.());
      await loadLocale(preferences.locale);
      applyTheme(preferences.theme);
      if (preferences.appearance && preferences.chat) applyTypography(document.documentElement, preferences);
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
      if (!cancelled) setError({ phase, message: errorMessage(cause) });
    });
    return () => { cancelled = true; };
  }, [attempt]);

  const failure = error && (
    <div className="app-runtime-empty">
      <div className="app-empty-state">
        <div className="app-eyebrow">AioLM · All-In-One LM</div>
        <h1>{error.phase === "migration" ? text.migrationFailed : text.startupFailed}</h1>
        <p role="alert">{normalizeDisplayText(error.message)}</p>
        <p>{error.phase === "migration" ? text.migrationPreserved : text.startupPreserved}</p>
        <div className="app-empty-actions">
          <button className="app-button app-button--primary" onClick={() => { setError(null); setAttempt(current => current + 1); }}>
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
