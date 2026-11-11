import { runtimeCatalogSnapshot, subscribeRuntimeCatalog } from '../../shared/api/providers';
import ModelName from '../../shared/ui/ModelName';
import ModelBadges from '../../shared/ui/ModelBadges';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import ModelIcon from '../../shared/ui/ModelIcon';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { invalidateModelCatalog, MODEL_CATALOG_CHANGED } from '../model-settings/useModelCatalog';
import { projectorChangeAllowed } from "../chat/visionState";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import EmptyState from "../../shared/ui/EmptyState";
import Badge from "../../shared/ui/Badge";
import StatusBadge from "../../shared/ui/StatusBadge";
import { useI18n } from "../../shared/i18n/i18n";
import { isLifecycleCancellation, isServerBusy, isServerRunning } from "../../shared/lib/serverLifecycle";
import { modelPathIdentity, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import TuningOptionMetadata from '../tuning/TuningOptionMetadata';
import { executionText } from '../../shared/i18n/executionI18n';
import { forgetExecution } from './modelExecutionState';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { startModelScan } from '../../shared/runtime/modelScan';
import { memorySourceText, statusDisplayCopy } from '../../shared/i18n/statusDisplayCopy';
import { formatMebibytes } from '../../shared/lib/units';
import { runSetupGapMessage, runSetupGaps } from '../../shared/runtime/runReadiness';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { modelActions } from '../../shared/i18n/modelActions';
import { modelUpdatesCopy } from './modelUpdatesCopy';
import { useModelUpdates, type ModelUpdateCatalog } from './useModelUpdates';
import { formatBytes } from '../discover/discoverUtils';
import { getTaskSnapshot } from '../../shared/state/taskRegistry';
import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';


/** `sessions` comes from a parent that already holds the detailed session
 * subscription; without it the panel subscribes itself. `children` render the
 * parent's loaded-model controls between the page heading and the library. */
export default function ModelsPanel({ store, onSelectModel, onDiscoverModels, onModels, compact = false, active = true, sessions: providedSessions, sessionsReady: providedSessionsReady = false, children }: { store: AppStore; onSelectModel?: (model: api.GgufModel) => Promise<void>; onDiscoverModels?: () => void; onModels?: (models: api.GgufModel[]) => void; compact?: boolean; active?: boolean; sessions?: api.SessionStatus[]; sessionsReady?: boolean; children?: ReactNode }) {
  const { t, locale } = useI18n();
  useSyncExternalStore(subscribeRuntimeCatalog, runtimeCatalogSnapshot, runtimeCatalogSnapshot);
  const copy = executionText[locale];

  const cfg = store.cfg;
  const selectedProvider = api.providerOf(cfg ?? {});
  const selectedRuntime = cfg?.active_runtime ?? '';
  const [models, setModels] = useState<api.GgufModel[] | null>(null);
  const [updateCatalog, setUpdateCatalog] = useState<ModelUpdateCatalog | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const modelFilterInput = useRef<HTMLInputElement>(null);
  const [providerFilter, setProviderFilter] = useState<api.ProviderId | 'all'>('all');
  const [dir, setDir] = useState(cfg?.models_dir ?? "");
  const [folderSaved, setFolderSaved] = useState(false);
  const [folderAction, setFolderAction] = useState<'idle' | 'choosing' | 'saving'>('idle');
  const folderInFlight = useRef(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const [scanRequest, setScanRequest] = useState(0);
  const [showVision, setShowVision] = useState(false);
  const [flash, notify, dismissFlash] = useFlashMessage();
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; description: string; confirmLabel: string; confirmIcon?: string; onConfirm: () => void } | null>(null);
  const pendingDeletions = useRef(new Set<string>());
  const scanTimer = useRef<number | null>(null);
  const scanGeneration = useRef(0);
  const pendingScan = useRef<ReturnType<typeof startModelScan> | null>(null);
  const requestedScanDirRef = useRef("");
  const performedScanRef = useRef<{ request: number; scan: () => Promise<void> } | null>(null);
  const [ownSessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [ownSessionsReady, setOwnSessionsReady] = useState(false);
  const sessions = providedSessions ?? ownSessions;
  const modelSettings = useModelSettings();
  const updatesCopy = modelUpdatesCopy[locale];
  const sessionsReady = providedSessions ? providedSessionsReady : ownSessionsReady;
  const updateBlocked = store.busy || scanning || folderAction !== 'idle' || !sessionsReady || !['stopped', 'failed', 'crashed'].includes(store.status.state)
    || sessions.some(session => isServerBusy(session.state));
  const modelUpdates = useModelUpdates({ active, directory: dir, catalog: updateCatalog, blocked: updateBlocked });

  useEffect(() => {
    if (!active) setOwnSessionsReady(false);
  }, [active]);

  useSessionPolling({
    active: active && !providedSessions && api.isNativeRuntimeAvailable(),
    details: true,
    onData: data => { setSessions(data); setOwnSessionsReady(true); },
    onError: () => setOwnSessionsReady(false),
  });

  const scan = useCallback(async () => {
    pendingScan.current?.cancel();
    pendingScan.current = null;
    const generation = nextScanGeneration(scanGeneration.current);
    scanGeneration.current = generation;
    setUpdateCatalog(null);
    if (!dir.trim()) {
      setScanError(t("ui.modelsSetDirFirst"));
      setModels(null);
      setScanTruncated(false);
      setScanning(false);
      return;
    }
    setScanning(true);
    setScanError(null);
    try {
      const job = startModelScan(dir, selectedProvider !== 'llama.cpp' && selectedRuntime ? { provider: selectedProvider, runtime: selectedRuntime } : undefined);
      pendingScan.current = job;
      const result = await job.result;
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setModels(result.models);
      onModels?.(result.models);
      setScanTruncated(result.truncated);
      setUpdateCatalog({ directory: dir, paths: result.models.map(model => model.path) });
    } catch (error) {
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentScan(generation, scanGeneration.current)) {
        pendingScan.current = null;
        setScanning(false);
      }
    }
  }, [dir, t, onModels, selectedProvider, selectedRuntime]);

  const cancelScan = useCallback(() => {
    scanGeneration.current = nextScanGeneration(scanGeneration.current);
    setUpdateCatalog(null);
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    pendingScan.current?.cancel();
    pendingScan.current = null;
    setScanning(false);
    setScanError(null);
  }, []);

  useEffect(() => {
    if (!active) cancelScan();
    return () => {
      scanGeneration.current = nextScanGeneration(scanGeneration.current);
      pendingScan.current?.cancel();
      pendingScan.current = null;
    };
  }, [active, cancelScan]);

  useEffect(() => {
    const refresh = () => setScanRequest(value => value + 1);
    window.addEventListener(MODEL_CATALOG_CHANGED, refresh);
    return () => window.removeEventListener(MODEL_CATALOG_CHANGED, refresh);
  }, []);

  useEffect(() => {
    if (folderInFlight.current) return;
    const nextDir = cfg?.models_dir?.trim() ?? "";
    if (!nextDir || requestedScanDirRef.current === nextDir) return;
    requestedScanDirRef.current = nextDir;
    if (nextDir !== dir) setDir(nextDir);
    setScanRequest((current) => current + 1);
  }, [cfg?.models_dir, dir, folderAction]);

  useEffect(() => {
    if (!active) { performedScanRef.current = null; return; }
    if (scanRequest <= 0 || folderAction !== 'idle') return;
    // Releasing a picker/save guard resumes pending scans, not a completed scan.
    if (performedScanRef.current?.request === scanRequest && performedScanRef.current.scan === scan) return;
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => {
      performedScanRef.current = { request: scanRequest, scan };
      void scan();
    }, 0);
    return () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    };
  }, [active, scanRequest, scan, folderAction]);

  const normalizedQuery = modelQuery.trim().toLowerCase();
  const visible = (models ?? []).filter((model) => {
    if (providerFilter !== 'all' && !api.modelCompatibleForLibrary(model, providerFilter)) return false;
    if (!showVision && model.is_vision) return false;
    if (!normalizedQuery) return true;
    return `${model.name} ${normalizeDisplayPath(model.path)}`.toLowerCase().includes(normalizedQuery);
  });
  const onlyHiddenVision = visible.length === 0 && !showVision && models !== null && models.length > 0 && models.every(model => model.is_vision);
  const hasModelFilters = normalizedQuery.length > 0 || providerFilter !== 'all';
  const clearModelFilters = () => {
    setModelQuery('');
    setProviderFilter('all');
    modelFilterInput.current?.focus();
  };
  const liveModel = loadedModelPath(store.status);
  const serverRunning = isServerBusy(store.status.state);
  const statusCopy = statusDisplayCopy[locale];
  const memory = store.status.memory;
  const memoryLine = memory ? memory.source === 'unknown' ? statusCopy.memoryUnavailable
    : t('ui.modelsMemoryLine', { total: formatMebibytes(memory.total_mb), model: formatMebibytes(memory.model_mb), kv: formatMebibytes(memory.kv_mb), source: memorySourceText(memory.source, locale) }) : undefined;
  const lifecycle = store.status.lifecycle;
  const lifecycleLine = lifecycle ? t('ui.modelsSlotsLine', {
    parallel: lifecycle.parallel || statusCopy.automatic,
    sleep: lifecycle.sleep_idle_seconds < 0 ? statusCopy.off : `${lifecycle.sleep_idle_seconds} s`,
    idle: lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0,
    requests: lifecycle.active_requests ?? store.status.active_requests ?? 0,
  }) : undefined;
  // Starting a row applies its own model, so the only setup a row can be
  // missing is the runtime — and without one the launch fails in the backend.
  // Say so here and disable the rows rather than letting each click fail.
  const runtimeGap = !!cfg && runSetupGaps({ activeModel: cfg.active_model, activeProvider: cfg.active_provider, activeRuntime: cfg.active_runtime, activeBackend: cfg.active_backend, activeBuild: cfg.active_build }).includes('runtime');
  const loadedModels = new Set(sessions.filter(session => session.id !== 'default' && isServerRunning(session.state)).map(session => modelPathIdentity(loadedModelPath(session))));
  if (isServerRunning(store.status.state) && liveModel) loadedModels.add(modelPathIdentity(liveModel));
  const isModelLoaded = (model: api.GgufModel) => loadedModels.has(modelPathIdentity(model.path)) || !!model.shards?.files.some(path => loadedModels.has(modelPathIdentity(path)));

  const selectModel = async (model: api.GgufModel) => {
    if (modelUpdates.busy || model.shards?.missing.length) return;
    try {
      if (onSelectModel) { await onSelectModel(model); return; }
      await store.updateConfig({ active_model: model.path });
      // 모델 선택은 저장/서버 시작 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setProjector = async (model: api.GgufModel) => {
    if (modelUpdates.busy || model.shards?.missing.length) return;
    if (!projectorChangeAllowed(store.status.state)) {
      notify(t("ui.stopBeforeProjector"));
      return;
    }
    try {
      await store.updateConfig({ mmproj: model.path });
      // 프로젝터 선택도 선택 상태 변경이므로 성공 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const browse = async () => {
    if (modelUpdates.busy || folderInFlight.current) return;
    folderInFlight.current = true;
    setFolderAction('choosing');
    setFolderError(null);
    setFolderSaved(false);
    let saving = false;
    try {
      const chosen = await api.pickModelsDir();
      if (!chosen?.trim()) return;
      saving = true;
      setFolderAction('saving');
      const saved = await store.updateConfig({ models_dir: chosen });
      const savedDir = saved.models_dir.trim();
      setDir(savedDir);
      requestedScanDirRef.current = savedDir;
      setScanRequest((current) => current + 1);
      setFolderSaved(true);
    } catch (error) {
      setFolderError(`${t(saving ? "panel.saveFailed" : "panel.browseFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      folderInFlight.current = false;
      setFolderAction('idle');
    }
  };

  const performSelectAndStart = async (model: api.GgufModel) => {
    if (getTaskSnapshot().some(task => task.id === MODEL_DOWNLOAD_TASK_ID && (task.state === 'running' || task.state === 'cancelling'))) return;
    const switching = serverRunning && liveModel !== model.path;
    try {
      const next = await store.updateConfig({ active_model: model.path });
      // Backend preflight completes before replacing the running process.
      await store.start(next, switching);
      notify(switching ? `${t("panel.restartServer")}: ${model.name}` : `${t("panel.serverStarted")}: ${model.name}`);
    } catch (error) {
      notify(isLifecycleCancellation(error) ? t("ui.taskCancelled") : `${t("panel.startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectAndStart = async (model: api.GgufModel) => {
    if (modelUpdates.busy || model.shards?.missing.length) return;
    const switching = serverRunning && liveModel !== model.path;
    if (switching && shouldConfirmDestructive()) {
      setPendingConfirm({
        title: t("panel.restartSwitchQuestion"),
        description: t("ui.switchModelBody", { name: normalizeDisplayText(model.name) }),
        confirmLabel: t("panel.restartSwitch"),
        confirmIcon: "open",
        onConfirm: () => { setPendingConfirm(null); void performSelectAndStart(model); },
      });
      return;
    }
    await performSelectAndStart(model);
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(normalizeDisplayPath(path));
      notify(t("ui.modelPathCopied"));
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeModel = async (model: api.GgufModel) => {
    if (modelUpdates.busy || serverRunning || isModelLoaded(model)) {
      notify(t("ui.stopBeforeDelete"));
      return;
    }
    const remove = async () => {
      setPendingConfirm(null);
      if (getTaskSnapshot().some(task => task.id === MODEL_DOWNLOAD_TASK_ID && (task.state === 'running' || task.state === 'cancelling'))) return;
      if (pendingDeletions.current.has(model.path)) return;
      pendingDeletions.current.add(model.path);
      try {
        await api.deleteModel(model.path, model.shards?.files);
        forgetExecution(model.path);
        if (store.getConfig()?.active_model === model.path) {
          await store.updateConfig(current => current.active_model === model.path ? { active_model: '' } : {});
        }
        notify(t("ui.deletedModelNamed", { name: model.name }));
      } catch (error) {
        notify(`${t("ui.deleteFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        pendingDeletions.current.delete(model.path);
        invalidateModelCatalog();
      }
    };
    if (!shouldConfirmDestructive()) { void remove(); return; }
    setPendingConfirm({
      title: t("ui.deleteModelTitle"),
      description: model.shards ? t("ui.deleteSplitModelBody", { name: normalizeDisplayText(model.name), count: model.shards.files.length }) : t("ui.deleteModelBody", { name: normalizeDisplayText(model.name) }),
      confirmLabel: t("ui.deleteModelAction"),
      confirmIcon: "delete",
      onConfirm: () => void remove(),
    });
  };

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
        <CustomSelect ariaLabel={providerCopy[locale].engine} value={providerFilter} onChange={value => setProviderFilter(value as api.ProviderId | 'all')} options={[{ value: 'all', label: providerCopy[locale].all }, ...api.registeredProviderIds().map(provider => ({ value: provider, label: api.providerDisplayName(provider) }))]} />
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
            : onlyHiddenVision ? <EmptyState title={t("ui.modelsVisionHidden")} description={t("ui.modelsVisionHiddenBody")}
              action={{ label: t(hasModelFilters ? "ui.modelsClearAndShowVision" : "ui.modelsShowVision"), onClick: () => { clearModelFilters(); setShowVision(true); } }} />
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
