import PanelFeedback from "../components/PanelFeedback";
import StableLabel from "../components/StableLabel";
import type { AppStore } from "../store";
import ConfirmDialog from "../components/ConfirmDialog";
import FeedbackBanner from "../components/FeedbackBanner";
import { useI18n } from "../i18n";
import { buildNumber } from "../runtimeUtils";
import { normalizeDisplayText } from "../lifecycleUtils";
import { useRuntimesController } from "./useRuntimesController";
import { computeVisibleRows, deviceSummaryOf } from "./runtimeRowPresentation";
import RuntimeDeviceCard from "./RuntimeDeviceCard";
import RuntimeCapabilitiesCard from "./RuntimeCapabilitiesCard";
import RuntimePullRequestCard from "./RuntimePullRequestCard";
import RuntimePortableBundle from "./RuntimePortableBundle";
import RuntimeBackendList from "./RuntimeBackendList";
import PullRequestProvenance from "./RuntimePullRequestProvenance";
import RuntimeGpuAssignment from "./RuntimeGpuAssignment";
import { runtimeGpuDevices } from "../sessionUtils";

export type { BackendRow } from "./runtimesHelpers";

export default function RuntimesPanel({ store, active = true, onOpenProfiles }: { store: AppStore; active?: boolean; onOpenProfiles?: () => void }) {
  const { t, locale } = useI18n();
  const rt = useRuntimesController(store, active);
  const runtimeChoices = rt.capabilities && rt.capabilities.backend === store.cfg?.active_backend && rt.capabilities.build === store.cfg?.active_build
    ? runtimeGpuDevices(rt.capabilities.backend, rt.capabilities.devices) : [];
  const managedRuntime = !!(store.cfg?.active_backend && store.cfg?.active_build);
  const assignmentDevice = rt.device && managedRuntime
    ? { ...rt.device, profile: { ...rt.device.profile, gpus: runtimeChoices } } : rt.device;
  const { visibleRows, hiddenCount } = computeVisibleRows(rt.rows, rt.device, rt.showAll);
  const activePrProgress = rt.activePrBackend ? rt.rows.find((row) => row.backend === rt.activePrBackend)?.progress : null;
  const deviceSummary = deviceSummaryOf(locale, rt.device);

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col p-4">
      <p className="mb-4 break-words text-sm text-muted">{t("ui.runtimesIntro")}</p>

      <RuntimeDeviceCard
        t={t}
        device={rt.device}
        deviceSummary={deviceSummary}
        showAll={rt.showAll}
        hiddenCount={hiddenCount}
        onToggleShowAll={rt.toggleShowAll}
      />
      <PanelFeedback>
        {rt.failure && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => rt.setFailure(null)}>{rt.failure}</FeedbackBanner>}
        {rt.loadError && <div className="flex flex-wrap items-center gap-2 rounded-lg border border-error-line bg-error-soft/50 px-3.5 py-2.5 text-sm text-error" role="alert"><span className="min-w-0 flex-1 break-words">{t("ui.runtimeLookupFailed")}: {normalizeDisplayText(rt.loadError)}</span><button type="button" onClick={() => void rt.refresh()} className="app-button app-button--danger app-button--sm">{t("panel.retry")}</button></div>}
      </PanelFeedback>

      <div className="runtime-refresh-row mb-3 flex flex-wrap items-center justify-between gap-2">
        <PanelFeedback>
          {rt.flash && <div className="w-full break-words rounded-lg border border-accent-line bg-accent-soft/50 px-3.5 py-2.5 text-sm text-accent" role="status" aria-live="polite">{normalizeDisplayText(rt.flash)}</div>}
        </PanelFeedback>
        <button type="button" onClick={() => void rt.refresh(true)} disabled={rt.runtimeBusy} className="app-button app-button--secondary app-button--sm shrink-0">{t("ui.refreshRemote")}</button>
      </div>

      <RuntimeBackendList
        t={t}
        locale={locale}
        visibleRows={visibleRows}
        device={rt.device}
        activeBackend={rt.activeBackend}
        activeBuild={rt.activeBuild}
        serverRunning={rt.serverRunning}
        prBusy={rt.prBusy}
        bundleBusy={rt.bundleBusy}
        cancelBusy={rt.cancelBusy}
        onBlockedAction={(msg) => rt.setFailure(msg)}
        onCancelInstall={() => void rt.cancelInstall()}
        onInstall={(backend) => void rt.install(backend)}
        onSelect={(backend, build) => void rt.select(backend, build)}
        onUninstall={(backend, build) => void rt.uninstall(backend, build)}
      />

      {managedRuntime && <div className="my-3 flex justify-end"><button type="button" onClick={() => void rt.probe()} disabled={rt.probeBusy || rt.runtimeBusy || rt.serverRunning} className="app-button app-button--secondary app-button--sm"><StableLabel value={rt.probeBusy ? t("ui.probing") : t("ui.probeRuntime")} labels={[t("ui.probing"), t("ui.probeRuntime")]} /></button></div>}
      {store.cfg && (
        <RuntimeGpuAssignment
          t={t}
          device={assignmentDevice}
          placement={store.cfg.gpu ?? { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null }}
          disabled={rt.serverRunning || rt.runtimeBusy || rt.probeBusy || (managedRuntime && !runtimeChoices.length)}
          onChange={(gpu) => store.updateConfig({ gpu }).then(() => undefined)}
        />
      )}

      {onOpenProfiles && <p className="runtime-profiles-link">{t("ui.runtimeProfilesMoved")} <button type="button" onClick={onOpenProfiles} className="app-button app-button--ghost app-button--sm">{t("ui.executionProfiles")}</button></p>}

      <details className="runtime-advanced mb-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" >
        <summary className="cursor-pointer text-sm font-semibold ui-color-ink" >{t("settings.advanced")}</summary>
        <div className="mt-4">
          <RuntimeCapabilitiesCard
            t={t}
            capabilities={rt.capabilities}
            probeBusy={rt.probeBusy}
            serverRunning={rt.serverRunning}
            activeBackend={rt.activeBackend}
            activeBuild={rt.activeBuild}
            onProbe={() => void rt.probe()}
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
            cancelBusy={rt.cancelBusy}
            activePrProgress={activePrProgress}
            onReview={() => void rt.reviewPullRequest()}
            onCancel={() => void rt.cancelInstall()}
          />
          <RuntimePortableBundle
            t={t}
            rows={rt.rows}
            bundleBusy={rt.bundleBusy}
            bundleProgress={rt.bundleProgress}
            runtimeBusy={rt.runtimeBusy}
            serverRunning={rt.serverRunning}
            cancelBusy={rt.cancelBusy}
            onImport={() => void rt.importRuntime()}
            onExport={(backend, build) => void rt.exportRuntime(backend, build)}
            onCancel={() => void rt.cancelInstall()}
          />
        </div>
      </details>
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
        description={rt.pendingUninstall ? t("ui.removeRuntimeBody", { backend: rt.pendingUninstall.backend, build: buildNumber(rt.pendingUninstall.build) }) : ""}
        confirmLabel={t("ui.removeRuntime")}
        busy={rt.uninstallBusy}
        onConfirm={() => void rt.confirmUninstall()}
        onCancel={() => { if (!rt.uninstallBusy) rt.setPendingUninstall(null); }}
      />
    </div>
  );
}
