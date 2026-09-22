import StableLabel from "../../shared/ui/StableLabel";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import type * as api from "../../shared/api/types";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { buildNumber, buildPhaseLabelKey, formatRuntimeVersion, runtimeRowAction } from "../../shared/runtime/runtimeUtils";
import { normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatBytes, formatMebibytes } from "../../shared/lib/units";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { prSourceTitle, type BackendRow } from "./runtimesHelpers";
import { fitClassOf, fitLabelOf, fitOf, reasonText, stateOf, suitabilityOf } from "./runtimeRowPresentation";

interface Props {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  locale: Locale;
  visibleRows: BackendRow[];
  device: api.DeviceReport | null;
  serverRunning: boolean;
  prBusy: boolean;
  bundleBusy: boolean;
  cancelBusy: boolean;
  probeBusy: boolean;
  probeTarget: { backend: string; build: string } | null;
  onBlockedAction?: (message: string) => void;
  onCancelInstall: () => void;
  onInstall: (backend: string) => void;
  onProbe: (backend: string, build: string) => void;
  onUninstall: (backend: string, build: string) => void;
}

export default function RuntimeBackendList({
  t, locale, visibleRows, device, serverRunning, prBusy, bundleBusy, cancelBusy, probeBusy, probeTarget,
  onBlockedAction, onCancelInstall, onInstall, onProbe, onUninstall,
}: Props) {
  const installedRows = visibleRows.filter((row) => row.installed.length > 0);
  const availableRows = visibleRows.filter((row) => row.installed.length === 0);

  const renderRow = (row: BackendRow) => {
    const state = stateOf(locale, row);
    const info = row.latest;
    const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
    const rowAction = runtimeRowAction({ busy: row.busy, newestInstalled });
    const backendName = t(`ui.${row.label}`, { id: row.backend });
    const installBlockedReason = serverRunning
      ? t("ui.stopBeforeRuntime")
      : prBusy
        ? t("ui.installingPr")
        : bundleBusy
          ? t("ui.runtimeBundleWorking")
          : !info ? t("ui.noLatestResolved") : null;
    return (
      <section key={row.backend} className="min-w-0 app-card app-card--muted" aria-labelledby={`runtime-${row.backend}`} aria-busy={row.busy}>
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 id={`runtime-${row.backend}`} className="text-sm font-semibold text-ink">{backendName}</h3>
              <span className={`rounded px-2 py-0.5 text-xs ${state.cls}`}>{state.label}</span>
              {device && <span className={`rounded px-2 py-0.5 text-xs ${fitClassOf(fitOf(device, row.backend))}`}>{fitLabelOf(locale, fitOf(device, row.backend))}</span>}
            </div>
            <div className="mt-0.5 break-words text-xs text-muted">{t(`ui.${row.note}`)}{device && reasonText(locale, suitabilityOf(device, row.backend)) ? ` · ${normalizeDisplayText(reasonText(locale, suitabilityOf(device, row.backend)))}` : ""}</div>
          </div>
          {rowAction === "cancel" ? (
            <LocalTaskCancelButton taskId="runtime-operation" pending={cancelBusy} onClick={onCancelInstall} disabled={cancelBusy} className="app-button app-button--danger app-button--sm shrink-0"><StableLabel value={cancelBusy ? t("ui.cancelling") : prBusy ? t("ui.cancelPrBuild") : t("ui.cancelInstall")} labels={[t("ui.cancelling"), t("ui.cancelPrBuild"), t("ui.cancelInstall")]} /></LocalTaskCancelButton>
          ) : rowAction === "install" ? (
            <button type="button" onClick={() => installBlockedReason ? onBlockedAction?.(installBlockedReason) : onInstall(row.backend)} aria-disabled={installBlockedReason ? "true" : undefined} title={installBlockedReason ?? undefined} aria-label={`${info ? t("ui.installBuild", { build: buildNumber(info.build) }) : t("ui.installLatest")}: ${backendName}`} className={`app-button app-button--primary app-button--sm shrink-0 ${installBlockedReason ? "opacity-80" : ""}`}>
              <StableLabel value={info ? t("ui.installBuild", { build: buildNumber(info.build) }) : t("ui.installLatest")} labels={[t("ui.installBuild", { build: buildNumber(info?.build ?? "") }), t("ui.installLatest")]} />
            </button>
          ) : null}
        </div>

        <div className={`runtime-latest-slot mt-2 text-xs ${info ? "text-muted" : "text-error"}`}>
          {info ? <span className="block app-text-wrap">{t("ui.latestBuild")}: <span className="text-ink">{t("ui.buildLabel", { build: buildNumber(info.build) })}</span>{" · "}{info.digest ? t("ui.digestPublished") : t("ui.digestUnavailable")}</span> : <span className="block app-text-wrap">{t("ui.latestUnavailable")}{row.latestErr ? `: ${normalizeDisplayText(row.latestErr)}` : ` ${t("ui.latestUnavailableRetry")}`}</span>}
        </div>

        {row.busy && row.progress && <div className="runtime-progress-slot mt-3" role="progressbar" aria-label={t("ui.installedBuilds", { label: row.backend })} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.progress.total > 0 ? Math.round(row.progress.received / row.progress.total * 100) : undefined}>
          <div className="mb-1 flex justify-between gap-2 text-xs text-muted"><span>{t(`ui.${buildPhaseLabelKey(row.progress.phase)}`)}</span>{row.progress.total > 0 && <span>{formatBytes(row.progress.received)} / {formatBytes(row.progress.total)}</span>}</div>
          <div className="h-2 overflow-hidden rounded-full app-bg-elevated"><div className="h-full rounded-full app-bg-accent-solid transition-all" style={{ width: row.progress.total > 0 ? `${Math.min(100, row.progress.received / row.progress.total * 100)}%` : "100%" }} /></div>
        </div>}

        {row.installed.length > 0 && <div className="mt-3 flex min-w-0 flex-wrap gap-2.5" role="list" aria-label={t("ui.installedBuilds", { label: backendName })}>
          {row.installed.map((item) => {
            const probed = probeTarget?.backend === row.backend && probeTarget.build === item.build;
            const uninstallBlockedReason = row.busy ? undefined : serverRunning ? t("ui.stopBeforeRemoveRuntime") : prBusy ? t("ui.installingPr") : null;
            return <div key={item.build} role="listitem" className={`flex min-w-0 max-w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-1.5 text-xs ${probed ? "app-border-accent bg-accent-soft/40" : "border-line-strong app-bg-muted"}`} title={normalizeDisplayPath(item.dir)}>
              <span className="text-ink" title={normalizeDisplayText(item.source?.commit ? prSourceTitle(locale, item.source) : item.version?.commit ? `commit ${item.version.commit}` : item.build)}>{item.source ? `${t("ui.runtimePrBuild", { pr: item.source.pull_request })} · ${item.source.commit.slice(0, 7)} · ` : ""}{normalizeDisplayText(formatRuntimeVersion(item.build, item.version))}</span>
              <span className="text-muted">{formatMebibytes(item.size_mb)}</span>
              <button type="button" onClick={() => onProbe(row.backend, item.build)} disabled={row.busy || probeBusy || serverRunning} title={serverRunning ? t("ui.stopBeforeSelect") : undefined} aria-label={`${t("ui.probeBuild")}: ${backendName} ${item.build}`} className="app-button app-button--secondary app-button--sm">{t("ui.probeBuild")}</button>
              <button type="button" onClick={() => uninstallBlockedReason ? onBlockedAction?.(uninstallBlockedReason) : onUninstall(row.backend, item.build)} disabled={row.busy} aria-disabled={uninstallBlockedReason ? "true" : undefined} title={uninstallBlockedReason ?? undefined} aria-label={`${t("panel.remove")}: ${backendName} ${item.build}`} className={`app-button app-button--danger app-button--sm ${uninstallBlockedReason ? "opacity-80" : ""}`}>{t("panel.remove")}</button>
            </div>;
          })}
        </div>}
      </section>
    );
  };

  return <div className="runtime-list space-y-3.5">
    {installedRows.length > 0 && <section className="space-y-2" aria-labelledby="runtime-installed-heading"><h2 id="runtime-installed-heading" className="app-section-title">{t("ui.runtimeInstalledHeading")}</h2>{installedRows.map(renderRow)}</section>}
    <section className="space-y-2" aria-labelledby="runtime-available-heading"><h2 id="runtime-available-heading" className="app-section-title">{t("ui.runtimeAvailableHeading")}</h2>{availableRows.length > 0 ? availableRows.map(renderRow) : <p className="text-xs text-muted">{t("ui.none")}</p>}</section>
  </div>;
}
