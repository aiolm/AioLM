import StableLabel from "../../shared/ui/StableLabel";
import StatusBadge from "../../shared/ui/StatusBadge";
import ProgressBar from "../../shared/ui/ProgressBar";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import type * as api from "../../shared/api/types";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { buildNumber, buildPhaseLabelKey, formatRuntimeVersion, runtimeRowAction } from "../../shared/runtime/runtimeUtils";
import { normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { formatBytes, formatMebibytes } from "../../shared/lib/units";
import type { UnifiedKey, TranslationVars } from "../../shared/i18n/i18nUnified";
import { prSourceTitle, type BackendRow } from "./runtimesHelpers";
import { fitLabelOf, fitOf, reasonText, stateOf, suitabilityOf } from "./runtimeRowPresentation";

export interface RuntimeBackendRowProps {
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  locale: Locale;
  row: BackendRow;
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

/** One backend as a group: name, fit and status inline, the latest release and
 * its install action on the same line, then installed versions as indented rows
 * with an aligned size and inline Probe and Remove actions. */
export default function RuntimeBackendRow({
  t, locale, row, device, serverRunning, prBusy, bundleBusy, cancelBusy, probeBusy, probeTarget,
  onBlockedAction, onCancelInstall, onInstall, onProbe, onUninstall,
}: RuntimeBackendRowProps) {
  const state = stateOf(locale, row);
  const info = row.latest;
  const newestInstalled = !!info && row.installed.some((item) => item.build === info.build);
  const rowAction = runtimeRowAction({ busy: row.busy, newestInstalled });
  const backendName = t(`ui.${row.label}`, { id: row.backend });
  const fit = device ? fitOf(device, row.backend) : null;
  const reason = device ? reasonText(locale, suitabilityOf(device, row.backend)) : "";
  const installBlockedReason = serverRunning
    ? t("ui.stopBeforeRuntime")
    : prBusy
      ? t("ui.installingPr")
      : bundleBusy
        ? t("ui.runtimeBundleWorking")
        : !info ? t("ui.noLatestResolved") : null;
  const probeBlockedReason = serverRunning ? t("ui.stopBeforeSelect") : null;
  return (
    <section className={`runtime-group${row.busy ? " is-busy" : ""}`} aria-labelledby={`runtime-${row.backend}`} aria-busy={row.busy}>
      <div className="runtime-group__header">
        <div className="runtime-group__identity">
          <div className="runtime-group__title">
            <h3 id={`runtime-${row.backend}`}>{backendName}</h3>
            {fit && <span className={`runtime-group__fit is-${fit}`}>{fitLabelOf(locale, fit)}</span>}
            {row.installed.length > 0 || row.busy ? <StatusBadge className={`runtime-group__state is-${state.tone}`} label={state.label} tone={state.tone} /> : null}
          </div>
          <p className="runtime-group__note">{t(`ui.${row.note}`)}{reason ? ` · ${normalizeDisplayText(reason)}` : ""}</p>
        </div>
        <div className={`runtime-group__latest runtime-latest-slot ${info ? "" : "is-error"}`}>
          {info
            ? <span className="app-text-wrap">{t("ui.latestBuild")} <span className="runtime-number">{t("ui.buildLabel", { build: buildNumber(info.build) })}</span><span className="runtime-group__digest"> · {info.digest ? t("ui.digestPublished") : t("ui.digestUnavailable")}</span></span>
            : <span className="app-text-wrap">{t("ui.latestUnavailable")}{row.latestErr ? `: ${normalizeDisplayText(row.latestErr)}` : ` ${t("ui.latestUnavailableRetry")}`}</span>}
        </div>
        <div className="runtime-group__action">
          {rowAction === "cancel" ? (
            <LocalTaskCancelButton taskId="runtime-operation" pending={cancelBusy} onClick={onCancelInstall} disabled={cancelBusy} className="app-button app-button--danger"><StableLabel value={cancelBusy ? t("ui.cancelling") : prBusy ? t("ui.cancelPrBuild") : t("ui.cancelInstall")} labels={[t("ui.cancelling"), t("ui.cancelPrBuild"), t("ui.cancelInstall")]} /></LocalTaskCancelButton>
          ) : rowAction === "install" ? (
            <button type="button" data-icon="download" onClick={() => installBlockedReason ? onBlockedAction?.(installBlockedReason) : onInstall(row.backend)} aria-disabled={installBlockedReason ? "true" : undefined} title={installBlockedReason ?? undefined} aria-label={`${info ? t("ui.installBuild", { build: t("ui.buildLabel", { build: buildNumber(info.build) }) }) : t("ui.installLatest")}: ${backendName}`} className="app-button app-button--primary">
              <StableLabel value={info ? t("ui.installBuild", { build: t("ui.buildLabel", { build: buildNumber(info.build) }) }) : t("ui.installLatest")} labels={[t("ui.installBuild", { build: t("ui.buildLabel", { build: buildNumber(info?.build ?? "") }) }), t("ui.installLatest")]} />
            </button>
          ) : null}
        </div>
      </div>

      {row.busy && row.progress && <div className="runtime-progress-slot">
        <div className="runtime-progress-label"><span>{t(`ui.${buildPhaseLabelKey(row.progress.phase)}`)}</span>{row.progress.total > 0 && <span className="runtime-number">{formatBytes(row.progress.received)} / {formatBytes(row.progress.total)}</span>}</div>
        <ProgressBar label={t("ui.installedBuilds", { label: row.backend })} value={row.progress.total > 0 ? Math.round(row.progress.received / row.progress.total * 100) : undefined} />
      </div>}

      {row.installed.length > 0 && <ul className="runtime-versions" aria-label={t("ui.installedBuilds", { label: backendName })}>
        {row.installed.map((item) => {
          const probed = probeTarget?.backend === row.backend && probeTarget.build === item.build;
          const uninstallBlockedReason = row.busy ? undefined : serverRunning ? t("ui.stopBeforeRemoveRuntime") : prBusy ? t("ui.installingPr") : null;
          const version = normalizeDisplayText(formatRuntimeVersion(item.build, item.version));
          return <li key={item.build} className={`runtime-version${probed ? " is-selected" : ""}`} title={normalizeDisplayPath(item.dir)}>
            <span className="runtime-version__name" title={normalizeDisplayText(item.source?.commit ? prSourceTitle(locale, item.source) : item.version?.commit ? `commit ${item.version.commit}` : item.build)}>
              {item.source && <span className="runtime-version__tag">{t("ui.runtimePrBuild", { pr: item.source.pull_request })}</span>}
              <span className="runtime-version__label">{item.source ? `${item.source.commit.slice(0, 7)} · ` : ""}{version}</span>
            </span>
            <span className="runtime-version__size">{formatMebibytes(item.size_mb)}</span>
            <span className="runtime-version__actions">
              <button type="button" data-icon="probe" onClick={() => onProbe(row.backend, item.build)} disabled={row.busy || probeBusy || serverRunning} title={probeBlockedReason ?? undefined} aria-label={`${t("ui.probeBuild")}: ${backendName} ${item.build}`} className="app-button app-button--secondary app-button--sm">{t("ui.probeBuild")}</button>
              <button type="button" data-icon="delete" onClick={() => uninstallBlockedReason ? onBlockedAction?.(uninstallBlockedReason) : onUninstall(row.backend, item.build)} disabled={row.busy} aria-disabled={uninstallBlockedReason ? "true" : undefined} title={uninstallBlockedReason ?? undefined} aria-label={`${t("panel.remove")}: ${backendName} ${item.build}`} className="app-button app-button--ghost app-button--danger app-button--sm">{t("panel.remove")}</button>
            </span>
          </li>;
        })}
      </ul>}
    </section>
  );
}
