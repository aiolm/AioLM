import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import type { AppStore } from "../../shared/state/store";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import Switch from "../../shared/ui/Switch";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { executionText } from "../../shared/i18n/executionI18n";
import { useRuntimesController } from "./useRuntimesController";
import { computeVisibleRows, deviceSummaryOf } from "./runtimeRowPresentation";
import RuntimeDeviceCard from "./RuntimeDeviceCard";
import RuntimeCapabilitiesCard from "./RuntimeCapabilitiesCard";
import RuntimePullRequestCard from "./RuntimePullRequestCard";
import RuntimePortableBundle from "./RuntimePortableBundle";
import RuntimeBackendList from "./RuntimeBackendList";
import PullRequestProvenance from "./RuntimePullRequestProvenance";
import RuntimeRemovalNotice from "./RuntimeRemovalNotice";
import { runtimeReferences } from "./runtimeReferences";
import { useDeepVerification } from "./useDeepVerification";

export type { BackendRow } from "./runtimesHelpers";

/** Installed runtimes only. Which runtime a model launches with is edited in
 * its profile, through model settings, so nothing here reads or writes the
 * execution configuration. */
export default function RuntimesPanel({ store, active = true, onOpenProfiles }: { store: AppStore; active?: boolean; onOpenProfiles?: () => void }) {
  const { t, locale } = useI18n();
  const rt = useRuntimesController(store, active);
  const { visibleRows, hiddenCount } = computeVisibleRows(rt.rows, rt.device, rt.showAll);
  const activePrProgress = rt.activePrBackend ? rt.rows.find((row) => row.backend === rt.activePrBackend)?.progress : null;
  const deviceSummary = deviceSummaryOf(locale, rt.device);
  const deepVerify = useDeepVerification(store, locale);

  return (
    <div className="app-page-scroll runtimes-page relative flex h-full min-h-0 flex-col">
      <header className="app-page-header">
        <div>
          <h2 className="app-page-title">{executionText[locale].manageRuntime}</h2>
          <p className="app-page-description">{t("ui.runtimesIntro")}</p>
        </div>
        <div className="app-page-actions">
          {rt.bundleBusy
            ? <LocalTaskCancelButton taskId="runtime-operation" pending={rt.cancelBusy} onClick={() => void rt.cancelInstall()} disabled={rt.cancelBusy} className="app-button app-button--danger shrink-0"><StableLabel value={rt.cancelBusy ? t("ui.cancelling") : t("ui.cancelRuntimeBundle")} labels={[t("ui.cancelling"), t("ui.cancelRuntimeBundle")]} /></LocalTaskCancelButton>
            : <button type="button" onClick={() => void rt.refresh(true)} disabled={rt.runtimeBusy} className="app-button app-button--secondary shrink-0 runtime-refresh">
                <svg aria-hidden="true" viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 10a6 6 0 1 1-1.76-4.24M16 4v3.5h-3.5" /></svg>
                {rt.loadError ? t("panel.retry") : t("ui.refreshRemote")}
              </button>}
        </div>
      </header>

      <div className="runtimes-layout">
      <aside className="runtimes-aside">
        <RuntimeDeviceCard t={t} device={rt.device} deviceSummary={deviceSummary} />
        <div className="runtime-show-all">
          <Switch id="runtime-show-all" checked={rt.showAll} onChange={rt.toggleShowAll} aria-describedby={!rt.showAll && hiddenCount > 0 ? "runtime-hidden-count" : undefined} />
          <label htmlFor="runtime-show-all">{t("ui.showAllBackends")}</label>
          {!rt.showAll && hiddenCount > 0 && <span id="runtime-hidden-count" className="runtime-hidden-count">{t("ui.hiddenBackends", { count: hiddenCount })}</span>}
        </div>
        {onOpenProfiles && <p className="runtime-profiles-link">{t("ui.runtimeProfilesMoved")} <button type="button" onClick={onOpenProfiles} className="app-link-button">{t("ui.executionProfiles")}</button></p>}
      </aside>

      <div className="runtimes-main">
      <PanelFeedback>
        {rt.failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => rt.setFailure(null)}>{rt.failure}</FeedbackBanner>}
        {rt.loadError && <FeedbackBanner tone="error">{`${t("ui.runtimeLookupFailed")}: ${normalizeDisplayText(rt.loadError)}`}</FeedbackBanner>}
      </PanelFeedback>
      {rt.flash && <FeedbackBanner tone="info" className="runtime-flash">{normalizeDisplayText(rt.flash)}</FeedbackBanner>}

      <RuntimeBackendList
        t={t}
        locale={locale}
        visibleRows={visibleRows}
        device={rt.device}
        serverRunning={rt.serverRunning}
        prBusy={rt.prBusy}
        bundleBusy={rt.bundleBusy}
        cancelBusy={rt.cancelBusy}
        probeBusy={rt.probeBusy}
        probeTarget={rt.probeTarget}
        onBlockedAction={(msg) => rt.setFailure(msg)}
        onCancelInstall={() => void rt.cancelInstall()}
        onInstall={(backend) => void rt.install(backend)}
        onProbe={(backend, build) => void rt.probe(backend, build)}
        onUninstall={(backend, build) => void rt.uninstall(backend, build)}
      />

      <details className="runtime-advanced">
        <summary>{t("settings.advanced")}</summary>
        <div className="runtime-advanced__body">
          <RuntimeCapabilitiesCard
            t={t}
            capabilities={rt.capabilities}
            probeBusy={rt.probeBusy}
            runtimeBusy={rt.runtimeBusy}
            serverRunning={rt.serverRunning}
            probeTarget={rt.probeTarget}
            onProbe={() => { if (rt.probeTarget) void rt.probe(rt.probeTarget.backend, rt.probeTarget.build); }}
            deepVerify={deepVerify}
          />
          <RuntimePullRequestCard
            t={t}
            prBackend={rt.prBackend}
            setPrBackend={rt.setPrBackend}
            prBackendTouched={rt.prBackendTouched}
            prSource={rt.prSource}
            setPrSource={rt.setPrSource}
            prBusy={rt.prBusy}
            bundleBusy={rt.bundleBusy}
            prReviewBusy={rt.prReviewBusy}
            serverRunning={rt.serverRunning}
            rows={rt.rows}
            activePrProgress={activePrProgress}
            onReview={() => void rt.reviewPullRequest()}
          />
          <RuntimePortableBundle
            t={t}
            rows={rt.rows}
            bundleBusy={rt.bundleBusy}
            bundleProgress={rt.bundleProgress}
            runtimeBusy={rt.runtimeBusy}
            serverRunning={rt.serverRunning}
            onImport={() => void rt.importRuntime()}
            onExport={(backend, build) => void rt.exportRuntime(backend, build)}
          />
        </div>
      </details>
      </div>
      </div>
      <ConfirmDialog
        open={rt.prPreview !== null}
        title={t("ui.prConfirmTitle")}
        description={rt.prPreview ? <PullRequestProvenance t={t} preview={rt.prPreview.preview} backend={rt.prPreview.backend} /> : ""}
        confirmLabel={t("ui.prConfirmAction")}
        tone="primary"
        busy={rt.prBusy}
        onConfirm={() => void rt.installPullRequest()}
        onCancel={() => { if (!rt.prBusy) rt.setPrPreview(null); }}
      />
      <ConfirmDialog
        open={rt.pendingUninstall !== null}
        title={t("ui.removeRuntimeTitle")}
        description={rt.pendingUninstall
          ? <RuntimeRemovalNotice t={t} backend={rt.pendingUninstall.backend} build={rt.pendingUninstall.build}
              references={runtimeReferences(store.cfg, rt.pendingUninstall.backend, rt.pendingUninstall.build)} />
          : ""}
        confirmLabel={t("ui.removeRuntime")}
        busy={rt.uninstallBusy}
        onConfirm={() => void rt.confirmUninstall()}
        onCancel={() => { if (!rt.uninstallBusy) rt.setPendingUninstall(null); }}
      />
    </div>
  );
}
