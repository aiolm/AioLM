import StableLabel from "../../shared/ui/StableLabel";
import ProgressBar from "../../shared/ui/ProgressBar";
import type * as api from "../../shared/api/types";
import { buildPhaseLabelKey, formatRuntimeVersion } from "../../shared/runtime/runtimeUtils";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import type { BackendRow } from "./runtimesHelpers";
import { formatBytes } from "../../shared/lib/units";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  rows: BackendRow[];
  bundleBusy: boolean;
  bundleProgress: api.DownloadProgress | null;
  runtimeBusy: boolean;
  serverRunning: boolean;
  onImport: () => void;
  onExport: (backend: string, build: string) => void;
}

/** Presentational: the "Portable runtime" import/export card on the Runtimes panel. */
export default function RuntimePortableBundle({
  t, rows, bundleBusy, bundleProgress, runtimeBusy, serverRunning, onImport, onExport,
}: Props) {
  return (
    <section className="app-card runtime-tool" aria-labelledby="portable-runtime-heading" aria-busy={bundleBusy}>
      <div className="runtime-tool__header runtime-tool__header--split">
        <div>
          <h3 id="portable-runtime-heading" className="runtime-tool__title">{t("ui.portableRuntimeTitle")}</h3>
          <p className="app-section-hint">{t("ui.portableRuntimeHint")}</p>
        </div>
        <button type="button" onClick={onImport} disabled={runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : undefined} className="app-button app-button--secondary"><StableLabel value={bundleBusy ? t("ui.runtimeBundleWorking") : t("ui.importRuntimeBundle")} labels={[t("ui.runtimeBundleWorking"), t("ui.importRuntimeBundle")]} /></button>
      </div>
      <div className="runtime-progress-slot">
        {bundleBusy && bundleProgress && (
          <div>
            <div className="runtime-progress-label">
              <span>{t(`ui.${buildPhaseLabelKey(bundleProgress.phase)}`)}</span>
              {bundleProgress.total > 0 && <span className="runtime-number">{formatBytes(bundleProgress.received)} / {formatBytes(bundleProgress.total)}</span>}
            </div>
            <ProgressBar label={t("ui.portableRuntimeTitle")} value={bundleProgress.total > 0 ? Math.round((bundleProgress.received / bundleProgress.total) * 100) : undefined} />
          </div>
        )}
      </div>
      {rows.some((row) => row.installed.length > 0) && (
        <div className="runtime-tool__actions" role="group" aria-label={t("ui.exportRuntime")}>
          {rows.flatMap((row) => row.installed.map((item) => (
            <button key={row.backend + ":" + item.build} type="button" data-icon="download" onClick={() => onExport(row.backend, item.build)} disabled={runtimeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : undefined} className="app-button app-button--secondary app-button--sm">
              {t("ui.exportRuntime")}: {row.backend} {formatRuntimeVersion(item.build, item.version)}
            </button>
          )))}
        </div>
      )}
    </section>
  );
}
