import StableLabel from "../../shared/ui/StableLabel";
import ProgressBar from "../../shared/ui/ProgressBar";
import type { MutableRefObject } from "react";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { canBuildPrBackend, buildPhaseLabelKey, isRuntimeDownloadPhase } from "../../shared/runtime/runtimeUtils";
import { formatBytes, formatSpeedBps } from "../../shared/lib/units";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { BACKENDS, type BackendRow } from "./runtimesHelpers";
import type * as api from "../../shared/api/types";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  prBackend: string;
  setPrBackend: (value: string) => void;
  prBackendTouched: MutableRefObject<boolean>;
  prSource: string;
  setPrSource: (value: string) => void;
  prBusy: boolean;
  bundleBusy: boolean;
  prReviewBusy: boolean;
  serverRunning: boolean;
  rows: BackendRow[];
  activePrProgress: api.DownloadProgress | null | undefined;
  downloadSpeedBps?: number;
  onReview: () => void;
}

export default function RuntimePullRequestCard({
  t, prBackend, setPrBackend, prBackendTouched, prSource, setPrSource, prBusy, bundleBusy, prReviewBusy,
  serverRunning, rows, activePrProgress, downloadSpeedBps, onReview,
}: Props) {
  const isPrDownload = Boolean(activePrProgress && isRuntimeDownloadPhase(activePrProgress.phase));
  const showPrBytes = Boolean(
    activePrProgress && isPrDownload && (activePrProgress.total > 0 || activePrProgress.received > 0),
  );
  const prPercent =
    activePrProgress && isPrDownload && activePrProgress.total > 0
      ? Math.min(100, Math.round((activePrProgress.received / activePrProgress.total) * 100))
      : undefined;
  const prDetail = (() => {
    if (!activePrProgress || !showPrBytes) return null;
    const moved = activePrProgress.total > 0
      ? `${formatBytes(activePrProgress.received)} / ${formatBytes(activePrProgress.total)}`
      : formatBytes(activePrProgress.received);
    if (downloadSpeedBps !== undefined && Number.isFinite(downloadSpeedBps) && downloadSpeedBps >= 0) {
      return `${moved} · ${formatSpeedBps(downloadSpeedBps)}`;
    }
    return moved;
  })();

  return (
    <section className="app-card runtime-tool" aria-labelledby="pull-request-runtime-heading">
      <div className="runtime-tool__header">
        <h3 id="pull-request-runtime-heading" className="runtime-tool__title">{t("ui.installPrTitle")}</h3>
        <p className="app-section-hint">{t("ui.installPrHint")}</p>
        <p className="runtime-tool__caution">{t("ui.prBackendUnsupportedHint")}</p>
      </div>
      <div className="runtime-tool__form">
        <label className="runtime-tool__field">
          <span>{t("ui.prBackendLabel")}</span>
          <CustomSelect
            value={prBackend}
            options={BACKENDS.map((backend) => {
              const supported = canBuildPrBackend(backend.id);
              return {
                value: backend.id,
                label: `${t(`ui.${backend.label}`, { id: backend.id })}${supported ? "" : " — " + t("ui.prBackendUnsupported")}`,
                disabled: !supported,
              };
            })}
            onChange={(val) => {
              prBackendTouched.current = true;
              setPrBackend(val);
            }}
            disabled={prBusy || bundleBusy || serverRunning}
            triggerClassName="w-full"
          />
        </label>
        <label className="runtime-tool__field">
          <span>{t("ui.prSourceLabel")}</span>
          <input value={prSource} onChange={(event) => setPrSource(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") onReview(); }} disabled={prBusy || bundleBusy || serverRunning} placeholder={t("ui.prSourcePlaceholder")} className="app-input" />
        </label>
        <div className="app-page-actions runtime-tool__actions">
          <button type="button" onClick={onReview} disabled={!prSource.trim() || prBusy || bundleBusy || prReviewBusy || !canBuildPrBackend(prBackend) || rows.some((row) => row.busy) || serverRunning} title={serverRunning ? t("ui.stopBeforeRuntime") : !canBuildPrBackend(prBackend) ? t("ui.prBackendBlocked", { backend: prBackend }) : undefined} className="app-button app-button--secondary"><StableLabel value={prBusy ? t("ui.installingPr") : prReviewBusy ? t("ui.prResolving") : t("ui.reviewPrAction")} labels={[t("ui.installingPr"), t("ui.prResolving"), t("ui.reviewPrAction")]} /></button>
        </div>
      </div>
      <div className="runtime-progress-slot">
        {prBusy && activePrProgress && <div role="status" aria-live="polite"><div className="runtime-progress-label"><span>{t(`ui.${buildPhaseLabelKey(activePrProgress.phase)}`)}</span>{prDetail ? <span className="runtime-number">{prDetail}</span> : <span>{t("ui.installingPr")}</span>}</div><ProgressBar label={t("ui.installingPr")} value={prPercent} /></div>}
      </div>
    </section>
  );
}
