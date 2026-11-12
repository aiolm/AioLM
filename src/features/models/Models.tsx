import * as api from "../../shared/api/index";
import { modelActions } from '../../shared/i18n/modelActions';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { normalizeDisplayPath,normalizeDisplayText } from "../../shared/lib/displayPaths";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { formatMebibytes } from '../../shared/lib/units';
import { runSetupGapMessage } from '../../shared/runtime/runReadiness';
import Badge from "../../shared/ui/Badge";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { CustomSelect } from '../../shared/ui/CustomSelect';
import EmptyState from "../../shared/ui/EmptyState";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import ModelName from '../../shared/ui/ModelName';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import StatusBadge from "../../shared/ui/StatusBadge";
import { projectorChangeAllowed } from "../chat/visionState";
import { formatBytes } from '../discover/discoverUtils';
import TuningOptionMetadata from '../tuning/TuningOptionMetadata';
import { matchingSupportingFilesCopy } from './modelLibraryCopy';
import { useModelsController,type ModelsPanelProps } from "./useModelsController";

/** `sessions` comes from a parent that already holds the detailed session
 * subscription; without it the panel subscribes itself. `children` render the
 * parent's loaded-model controls between the page heading and the library. */
export default function ModelsPanel(props: ModelsPanelProps) {
  const { store, onSelectModel, onDiscoverModels, compact = false, active = true, children } = props;
  const { t, locale, copy, cfg, models, updateCatalog, scanning, scanError, scanTruncated, modelQuery, setModelQuery, modelFilterInput, providerFilter, setProviderFilter, dir, folderSaved, setFolderSaved, folderAction, folderError, setFolderError, setScanRequest, showVision, setShowVision, flash, notify, dismissFlash, pendingConfirm, setPendingConfirm, updatesCopy, sessionsReady, updateBlocked, modelUpdates, cancelScan, visible, onlyHiddenVision, hasModelFilters, clearModelFilters, liveModel, serverRunning, memoryLine, lifecycle, lifecycleLine, runtimeGap, isModelLoaded, selectModel, setProjector, browse, selectAndStart, copyPath, removeModel, modelSettings } = useModelsController(props);
  return (
    <div className={`app-page-scroll models-panel relative flex h-full min-h-0 min-w-0 flex-col${compact ? ' models-panel--compact' : ''}`} data-testid="models-scroll-region">
      <header className="app-page-header"><div><h1 className="app-page-title">{t("section.library")}</h1>{compact && <p className="app-page-description">{copy.hint}</p>}</div></header>

      <PanelFeedback>
        {folderError && <FeedbackBanner tone="error" onDismiss={() => setFolderError(null)}>{folderError}</FeedbackBanner>}
        {!scanning && scanError && <FeedbackBanner tone="error">{scanError}</FeedbackBanner>}
        {modelUpdates.lookupError && <FeedbackBanner tone="error" title={updatesCopy.lookupFailed} action={{ label: t('panel.retry'), onClick: modelUpdates.refresh }}>{normalizeDisplayText(modelUpdates.lookupError)}</FeedbackBanner>}
        {modelUpdates.updateError && <FeedbackBanner tone="error" title={updatesCopy.updateFailed} action={{ label: t('panel.retry'), onClick: modelUpdates.refresh }}>{normalizeDisplayText(modelUpdates.updateError)}</FeedbackBanner>}
        {flash && <FeedbackBanner tone="info" onDismiss={dismissFlash}>{flash}</FeedbackBanner>}
        {folderSaved && (
          <FeedbackBanner tone="info" onDismiss={() => setFolderSaved(false)}>
            <div className="flex items-center justify-between gap-2">
              <span>{t("panel.modelsSaved")}</span>
              <StatusBadge label={t("panel.saved")} tone="success" />
            </div>
          </FeedbackBanner>
        )}
        {scanTruncated && <FeedbackBanner tone="warning">{t("ui.modelsScanTruncated")}</FeedbackBanner>}
      </PanelFeedback>

      {children}

      <div className="models-folder" aria-busy={folderAction !== 'idle'}>
      <div className="models-folder-actions min-w-0 items-center gap-2.5">
        <label htmlFor="models-dir" className="text-sm text-muted">{t("panel.modelsDirectory")}</label>
        <input
          id="models-dir"
          value={normalizeDisplayPath(dir)}
          readOnly
          className="app-input min-w-0"
          placeholder="models"
        />
        <div className="models-folder-buttons">
        <button type="button" data-icon="folder" onClick={() => void browse()} disabled={modelUpdates.busy || scanning || folderAction !== 'idle'} className="app-button app-button--secondary shrink-0">{folderAction === 'saving' ? copy.saving : folderAction === 'choosing' ? t('status.working') : t("panel.browse")}</button>
        </div>
      </div>
      </div>

      {!compact && serverRunning && <div className="mt-4 app-card" >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="app-eyebrow">{isServerRunning(store.status.state) ? copy.running : store.status.state === 'starting' ? copy.starting : copy.stopping}</div>
            <TuningOptionMetadata fieldKey="raw-server:--model" />
            {liveModel && <div className="app-text-wrap text-base font-semibold ui-color-ink" title={normalizeDisplayPath(liveModel)}>{<ModelName model={models?.find((model) => model.path === liveModel)?.name ?? liveModel} />}</div>}
            {/* Memory and slot status of the running model is what this card is for, so it starts expanded. */}
            <details className="models-runtime-details mt-1" open>
            <summary>{t("section.diagnostics")}</summary>
            <div className="models-runtime-details-content">
            <div className="models-status-line" title={memoryLine}>
              {memoryLine ?? "—"}
            </div>
            <div className="models-status-line mt-1" title={lifecycleLine}>
              {lifecycle ? <>{lifecycleLine}{lifecycle.auto_unload_due ? ` · ${t("ui.autoUnloadDue")}` : ""}</> : "—"}
            </div>
            </div>
            </details>
          </div>
          <div className="models-header-actions flex min-w-0 w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto lg:justify-end" data-testid="models-header-actions">
            {serverRunning && <button type="button" onClick={() => void api.unloadModel().then(() => notify(t("ui.unloadedOk"))).catch((error) => notify(`${t("ui.unloadFailed")}: ${error instanceof Error ? error.message : String(error)}`))} disabled={store.busy} className="app-button app-button--secondary app-button--sm">{t("ui.unloadModel")}</button>}
          </div>
        </div>
      </div>}

        {!compact && (store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <FeedbackBanner tone="error" title={t("ui.serverFailedTitle", { state: copy[store.status.state] })} className="mt-3 max-h-48 overflow-auto">
            <pre className="whitespace-pre-wrap break-words">{normalizeDisplayText(store.status.error)}</pre>
          </FeedbackBanner>
        )}

      <div className="models-list-toolbar">
        <div className="models-list-heading"><h2>{t("panel.models")}</h2>{models && <span className="models-list-count">{visible.length}</span>}</div>
        <input ref={modelFilterInput} value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("panel.modelFilterPlaceholder")} aria-label={t("panel.searchModels")} className="app-input models-list-filter" />
        <CustomSelect ariaLabel={providerCopy[locale].engine} value={providerFilter} onChange={value => setProviderFilter(value)} options={[{ value: 'all', label: providerCopy[locale].all }, ...api.registeredProviderIds().map(provider => ({ value: provider, label: api.providerDisplayName(provider) }))]} />
        <label className="models-list-toggle" ><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} /> {t("panel.visionModels")}</label>
        {scanning ? <button type="button" onClick={cancelScan} className="app-button app-button--secondary app-button--sm">{t("panel.cancelScan")}</button> : <button type="button" data-icon="refresh" onClick={() => setScanRequest((current) => current + 1)} disabled={modelUpdates.busy || folderAction !== 'idle'} className="app-button app-button--secondary app-button--sm">{scanError ? t("panel.retry") : t("panel.rescan")}</button>}
        <button type="button" data-icon="refresh" onClick={modelUpdates.refresh} disabled={!active || !updateCatalog || scanning || modelUpdates.checking || modelUpdates.busy || folderAction !== 'idle'} className="app-button app-button--secondary app-button--sm">{modelUpdates.checking ? updatesCopy.checking : updatesCopy.check}</button>
      </div>
      <p className="mb-2 text-xs ui-color-muted">{updatesCopy.incremental}</p>

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? t("panel.confirmAction")}
        description={pendingConfirm?.description ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? t("common.confirm")}
        confirmIcon={pendingConfirm?.confirmIcon}
        onConfirm={() => pendingConfirm?.onConfirm()}
        onCancel={() => setPendingConfirm(null)}
      />

      <div className="models-model-list min-w-0" data-testid="models-list" role={visible.length > 0 ? "list" : "region"} aria-label={t("panel.ariaGgufModels")} aria-busy={scanning}>
        {scanning && <div className="p-6 text-center text-sm ui-color-muted" role="status">{t("panel.scanning")}</div>}
        {!scanning && models === null && !scanError && <div className="p-6 text-center text-sm ui-color-faint"  role="status">{t("ui.modelsLoading")}</div>}
        {!scanning && models !== null && !scanError && visible.length === 0 && (
          models.length === 0 ? <EmptyState title={t("panel.noModels")} description={t("ui.modelsEmptyBody", { dir: dir ? normalizeDisplayPath(dir) : t("ui.modelsEmptyFolder") })}
          ><div className="app-empty-actions">
            {onDiscoverModels && <button type="button" className="app-button app-button--primary min-w-0 max-w-full" onClick={onDiscoverModels}>{modelActions(locale).find}</button>}
            <button type="button" className="app-button app-button--secondary min-w-0 max-w-full" onClick={() => void browse()} disabled={modelUpdates.busy || folderAction !== 'idle'}>{t("panel.chooseFolder")}</button>
          </div></EmptyState>
            : onlyHiddenVision ? <EmptyState title={t("ui.modelsVisionHidden")} description={hasModelFilters ? matchingSupportingFilesCopy[locale] : t("ui.modelsVisionHiddenBody")}
              action={{ label: t("ui.modelsShowVision"), onClick: () => { setShowVision(true); modelFilterInput.current?.focus(); } }} />
              : <EmptyState title={t("ui.modelsNoMatches")} description={t("ui.modelsNoMatchesBody")}
                action={{ label: t("ui.modelsClearFilters"), onClick: clearModelFilters }} />
        )}
        {visible.map((model) => {
          const displayName = normalizeDisplayText(model.name);
          const incomplete = !!model.shards?.missing.length;
          const running = isModelLoaded(model);
          const actionLabel = onSelectModel ? copy.setupAction : running ? t("ui.rowRunning") : serverRunning ? t("ui.rowRestartSwitch") : t("ui.rowStart");
          const updateStatus = modelUpdates.statuses[model.path];
          const canUpdate = !!updateStatus?.supported && !updateStatus.error && updateStatus.update_available && !!updateStatus.latest_revision;
          return (
            <div
              key={model.path}
              role="listitem"
              className={`models-model-row app-list-row min-w-0${running ? ' is-loaded' : ''}`}

            >
              <button
                type="button"
                aria-label={onSelectModel ? `${copy.setupAction}: ${displayName}` : t("ui.selectModelNamed", { name: displayName })}
                title={normalizeDisplayPath(model.path)}
                // Opening a card only reads: it hands the model to the settings
                // dialog, which is where starting and stopping are decided. Gating
                // it on the server made every card dead for the length of a VRAM
                // load, while the header opened the same dialog throughout.
                disabled={incomplete || modelUpdates.busy}
                onClick={() => void selectModel(model)}
                className="models-model-name app-list-row__action flex-col items-start"

              >
                <span className="models-model-title app-text-wrap" ><ModelIcon model={model.name} />{displayName}</span><ModelBadges mode="compact" model={model.name} artifact={model.artifact} {...(model.artifact?.format === 'gguf' || !model.artifact ? { localPath: model.path } : {})} />
                {model.shards && <span className={`block app-text-wrap text-xs ${incomplete ? "ui-color-danger" : "ui-color-muted"}`}>{incomplete ? t("ui.modelShardsMissing", { count: model.shards.missing.length, total: model.shards.total }) : t("ui.modelShards", { count: model.shards.total })}</span>}
              </button>
              <span className="models-model-size" >{model.artifact?.format === 'unknown' ? '—' : formatMebibytes(model.size_mb)}</span>
              <div className="models-model-actions">
                {model.is_vision && <Badge>{t("ui.visionTag")}</Badge>}
                {running && <StatusBadge label={copy.running} tone="success" />}
                {onSelectModel && <button type="button" data-icon="settings" onClick={() => void selectModel(model)} disabled={incomplete || modelUpdates.busy} aria-label={`${modelActions(locale).settings}: ${displayName}`} className="app-button app-button--secondary app-button--sm">{modelActions(locale).settings}</button>}
                {model.is_vision && <button type="button" onClick={() => { if (cfg?.mmproj !== model.path) void setProjector(model); }} disabled={modelUpdates.busy || incomplete || cfg?.mmproj === model.path || store.busy || !projectorChangeAllowed(store.status.state)} title={!projectorChangeAllowed(store.status.state) ? t("ui.stopBeforeProjector") : undefined} aria-label={`${cfg?.mmproj === model.path ? t("ui.rowProjectorActive") : t("ui.rowUseProjector")}: ${displayName}`} className="app-button app-button--secondary app-button--sm shrink-0"><StableLabel value={cfg?.mmproj === model.path ? t("ui.rowProjectorActive") : t("ui.rowUseProjector")} labels={[t("ui.rowProjectorActive"), t("ui.rowUseProjector")]} /></button>}
                {!onSelectModel && <button type="button" onClick={() => { if (!running) void selectAndStart(model); }} disabled={modelUpdates.busy || incomplete || running || store.busy || (!modelSettings && runtimeGap)} title={!modelSettings && runtimeGap ? runSetupGapMessage('runtime', locale) : undefined} aria-label={`${actionLabel}: ${displayName}`} className="app-button app-button--primary app-button--sm shrink-0"><StableLabel value={actionLabel} labels={[t("ui.rowRunning"), t("ui.rowRestartSwitch"), t("ui.rowStart")]} /></button>}
              </div>
              <div className="models-model-path">
                <code>{normalizeDisplayPath(model.path)}</code>
                {updateStatus?.supported && updateStatus.error ? <FeedbackBanner tone="error" className="relative z-[2]" title={updatesCopy.lookupFailed} action={{ label: t('panel.retry'), onClick: modelUpdates.refresh }}>{normalizeDisplayText(updateStatus.error)}</FeedbackBanner>
                  : updateStatus?.supported ? <p className="text-xs ui-color-muted">{updateStatus.update_available ? `${updatesCopy.available} · ${updatesCopy.download}: ${formatBytes(updateStatus.download_bytes)} · ${updatesCopy.reuse}: ${formatBytes(updateStatus.reused_bytes)}` : updatesCopy.current}</p>
                    : updateStatus ? <p className="text-xs ui-color-muted">{updatesCopy.unsupported}{updateStatus.error ? `: ${normalizeDisplayText(updateStatus.error)}` : ''}</p> : null}
              </div>
              <div className="models-file-actions">
                {canUpdate && <button type="button" data-icon="refresh" onClick={() => void modelUpdates.update(model.path)} disabled={updateBlocked || modelUpdates.busy || incomplete || scanning} title={!sessionsReady ? updatesCopy.sessionsPending : updateBlocked ? updatesCopy.stopFirst : updatesCopy.incremental} aria-label={`${updatesCopy.update}: ${displayName}`} className="app-button app-button--secondary app-button--sm shrink-0">{updatesCopy.update}</button>}
                {modelUpdates.updating === model.path && <span role="status" className="text-xs ui-color-muted">{updatesCopy.updating}</span>}
                  <button type="button" data-icon="copy" onClick={() => void copyPath(model.path)} aria-label={`${t("panel.copyPath")}: ${displayName}`} className="app-button app-button--ghost app-button--sm">{t("panel.copyPath")}</button>
                  <button type="button" data-icon="delete" onClick={() => void removeModel(model)} disabled={modelUpdates.busy || running || store.busy || serverRunning} title={(running || serverRunning) ? t("ui.stopBeforeDelete") : undefined} aria-label={`${t("panel.delete")}: ${displayName}`} className="app-button app-button--ghost app-button--danger app-button--sm">{t("panel.delete")}</button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
