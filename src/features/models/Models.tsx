import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { invalidateModelCatalog, MODEL_CATALOG_CHANGED } from '../model-settings/useModelCatalog';
import { projectorChangeAllowed } from "../chat/visionState";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { useI18n } from "../../shared/i18n/i18n";
import { isLifecycleCancellation, isServerBusy, isServerRunning } from "../../shared/lib/serverLifecycle";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import TuningOptionMetadata from '../tuning/TuningOptionMetadata';
import { executionText } from '../../shared/i18n/executionI18n';
import { forgetExecution } from './modelExecutionState';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { startModelScan } from '../../shared/runtime/modelScan';


export default function ModelsPanel({ store, focus = "library", onSelectModel, onModels, compact = false, active = true }: { store: AppStore; focus?: "library" | "lora"; onSelectModel?: (model: api.GgufModel) => Promise<void>; onModels?: (models: api.GgufModel[]) => void; compact?: boolean; active?: boolean }) {
  const { t, locale } = useI18n();
  const copy = executionText[locale];

  const cfg = store.cfg;
  const [models, setModels] = useState<api.GgufModel[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanTruncated, setScanTruncated] = useState(false);
  const [modelQuery, setModelQuery] = useState("");
  const [dir, setDir] = useState(cfg?.models_dir ?? "");
  const [folderSaved, setFolderSaved] = useState(false);
  const [scanRequest, setScanRequest] = useState(0);
  const [showVision, setShowVision] = useState(false);
  const [flash, notify, dismissFlash] = useFlashMessage();
  const [adapterScale, setAdapterScale] = useState("1");
  const [serverAdapters, setServerAdapters] = useState<api.ServerLoraAdapter[]>([]);
  const [serverAdapterScales, setServerAdapterScales] = useState<Record<number, string>>({});
  const [adapterBusy, setAdapterBusy] = useState(false);
  const [pendingConfirm, setPendingConfirm] = useState<{ title: string; description: string; confirmLabel: string; onConfirm: () => void } | null>(null);
  const scanTimer = useRef<number | null>(null);
  const scanGeneration = useRef(0);
  const pendingScan = useRef<ReturnType<typeof startModelScan> | null>(null);
  const requestedScanDirRef = useRef("");
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);

  useSessionPolling({
    active: active && focus === 'library' && api.isNativeRuntimeAvailable(),
    onData: setSessions,
  });

  const scan = useCallback(async () => {
    pendingScan.current?.cancel();
    pendingScan.current = null;
    const generation = nextScanGeneration(scanGeneration.current);
    scanGeneration.current = generation;
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
      const job = startModelScan(dir);
      pendingScan.current = job;
      const result = await job.result;
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setModels(result.models);
      onModels?.(result.models);
      setScanTruncated(result.truncated);
    } catch (error) {
      if (!isCurrentScan(generation, scanGeneration.current)) return;
      setScanError(error instanceof Error ? error.message : String(error));
    } finally {
      if (isCurrentScan(generation, scanGeneration.current)) {
        pendingScan.current = null;
        setScanning(false);
      }
    }
  }, [dir, t, onModels]);

  const cancelScan = useCallback(() => {
    scanGeneration.current = nextScanGeneration(scanGeneration.current);
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
    const nextDir = cfg?.models_dir?.trim() ?? "";
    if (!nextDir || requestedScanDirRef.current === nextDir) return;
    requestedScanDirRef.current = nextDir;
    if (nextDir !== dir) setDir(nextDir);
    setScanRequest((current) => current + 1);
  }, [cfg?.models_dir, dir]);

  useEffect(() => {
    if (!active || scanRequest <= 0) return;
    if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    scanTimer.current = window.setTimeout(() => void scan(), 0);
    return () => {
      if (scanTimer.current !== null) window.clearTimeout(scanTimer.current);
    };
  }, [active, scanRequest, scan]);

  const normalizedQuery = modelQuery.trim().toLowerCase();
  const visible = (models ?? []).filter((model) => {
    if (!showVision && model.is_vision) return false;
    if (!normalizedQuery) return true;
    return `${model.name} ${normalizeDisplayPath(model.path)}`.toLowerCase().includes(normalizedQuery);
  });
  const liveModel = store.status.model ?? "";
  const serverRunning = isServerBusy(store.status.state);
  const loadedModels = new Set(sessions.filter(session => session.id !== 'default' && isServerRunning(session.state)).map(session => session.model));
  if (isServerRunning(store.status.state) && store.status.model) loadedModels.add(store.status.model);

  const refreshServerAdapters = useCallback(async () => {
    if (!isServerRunning(store.status.state) || !store.status.url || !store.status.api_key) {
      setServerAdapters([]);
      return;
    }
    setAdapterBusy(true);
    try {
      const loaded = await api.listServerLoraAdapters(store.status.url, store.status.api_key);
      setServerAdapters(loaded);
      setServerAdapterScales(Object.fromEntries(loaded.map((adapter) => [adapter.id, String(adapter.scale)])));
    } catch (error) {
      setServerAdapters([]);
      notify(`${t("ui.loraHotSwapUnavailable")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setAdapterBusy(false);
    }
  }, [t, notify, store.status.api_key, store.status.state, store.status.url]);

  useEffect(() => {
    if (focus === 'lora') void refreshServerAdapters();
  }, [focus, refreshServerAdapters]);

  const addAdapter = async () => {
    try {
      const path = await api.pickLoraAdapter();
      if (!path) return;
      const scale = Number.parseFloat(adapterScale);
      if (!Number.isFinite(scale) || scale < 0 || scale > 4) {
        notify(t("ui.loraScaleRange"));
        return;
      }
      const next = [...(cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path), { path, scale, enabled: scale > 0 }];
      await store.updateConfig({ lora_adapters: next });
      notify(isServerRunning(store.status.state) ? t("ui.loraSavedRestart") : t("ui.loraSaved"));
    } catch (error) {
      notify(`${t("ui.loraSelectionFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const removeAdapter = async (path: string) => {
    try {
      await store.updateConfig({ lora_adapters: (cfg?.lora_adapters ?? []).filter((adapter) => adapter.path !== path) });
      notify(t("ui.loraRemoved"));
    } catch (error) {
      notify(`${t("ui.loraUpdateFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const applyServerAdapters = async () => {
    if (!store.status.url || !store.status.api_key) return;
    try {
      await api.setServerLoraAdapters(store.status.url, store.status.api_key, serverAdapters.map((adapter) => ({ id: adapter.id, scale: Math.max(0, Math.min(4, Number.parseFloat(serverAdapterScales[adapter.id] ?? String(adapter.scale)) || 0)) })));
      await refreshServerAdapters();
      notify(t("ui.loraScalesApplied"));
    } catch (error) {
      notify(`${t("ui.loraHotSwapFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectModel = async (model: api.GgufModel) => {
    if (model.shards?.missing.length) return;
    try {
      if (onSelectModel) { await onSelectModel(model); return; }
      await store.updateConfig({ active_model: model.path });
      // 모델 선택은 저장/서버 시작 알림을 표시하지 않는다.
    } catch (error) {
      notify(`${t("panel.saveFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setProjector = async (model: api.GgufModel) => {
    if (model.shards?.missing.length) return;
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
    try {
      const chosen = await api.pickModelsDir();
      if (!chosen) return;
      setDir(chosen.trim());
      await store.updateConfig({ models_dir: chosen });
      setFolderSaved(true);
      requestedScanDirRef.current = chosen.trim();
      setScanRequest((current) => current + 1);
    } catch (error) {
      notify(`${t("panel.browseFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const performSelectAndStart = async (model: api.GgufModel) => {
    const switching = serverRunning && liveModel !== model.path;
    try {
      if (switching) await store.stop();
      const next = await store.updateConfig({ active_model: model.path });
      await store.start(next);
      notify(switching ? `${t("panel.restartServer")}: ${model.name}` : `${t("panel.serverStarted")}: ${model.name}`);
    } catch (error) {
      notify(isLifecycleCancellation(error) ? t("ui.taskCancelled") : `${t("panel.startFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const selectAndStart = async (model: api.GgufModel) => {
    if (model.shards?.missing.length) return;
    const switching = serverRunning && liveModel !== model.path;
    if (switching && shouldConfirmDestructive()) {
      setPendingConfirm({
        title: t("panel.restartSwitchQuestion"),
        description: t("ui.switchModelBody", { name: normalizeDisplayText(model.name) }),
        confirmLabel: t("panel.restartSwitch"),
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
    if (serverRunning || loadedModels.has(model.path) || model.shards?.files.some(path => loadedModels.has(path))) {
      notify(t("ui.stopBeforeDelete"));
      return;
    }
    const remove = async () => {
      setPendingConfirm(null);
      try {
        await api.deleteModel(model.path, model.shards?.files);
        forgetExecution(model.path);
        if (cfg?.active_model === model.path) await store.updateConfig({ active_model: '' });
        notify(t("ui.deletedModelNamed", { name: model.name }));
      } catch (error) {
        notify(`${t("ui.deleteFailed")}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        invalidateModelCatalog();
      }
    };
    if (!shouldConfirmDestructive()) { void remove(); return; }
    setPendingConfirm({
      title: t("ui.deleteModelTitle"),
      description: model.shards ? t("ui.deleteSplitModelBody", { name: normalizeDisplayText(model.name), count: model.shards.files.length }) : t("ui.deleteModelBody", { name: normalizeDisplayText(model.name) }),
      confirmLabel: t("ui.deleteModelAction"),
      onConfirm: () => void remove(),
    });
  };

  return (
    <div className={`app-page-scroll models-panel relative flex h-full min-h-0 min-w-0 flex-col${compact ? ' models-panel--compact' : ''}`} data-testid="models-scroll-region">
      {focus === "lora" && <div className="mb-4"><div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted">{t("panel.models")}</div><h2 className="mt-1 text-xl font-semibold tracking-tight text-ink">{t("panel.loraAdapters")}</h2><p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted">{t("ui.loraDescription")}</p></div>}

      {/* Rendered outside the library-only fragment so LoRA actions report too. */}
      <PanelFeedback>
        {focus !== "lora" && !scanning && scanError && <FeedbackBanner tone="error">{scanError}</FeedbackBanner>}
        {flash && <FeedbackBanner tone="info" onDismiss={dismissFlash}>{flash}</FeedbackBanner>}
        {focus !== "lora" && folderSaved && (
          <FeedbackBanner tone="info" onDismiss={() => setFolderSaved(false)}>
            <div className="flex items-center justify-between gap-2">
              <span>{t("panel.modelsSaved")}</span>
              <span className="app-status-badge app-status-badge--success">{t("panel.saved")}</span>
            </div>
          </FeedbackBanner>
        )}
        {focus !== "lora" && scanTruncated && <FeedbackBanner tone="warning">{t("ui.modelsScanTruncated")}</FeedbackBanner>}
      </PanelFeedback>

      {focus !== "lora" && <>
      <div className="models-folder">
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
        <button type="button" onClick={() => void browse()} disabled={scanning} className="app-button app-button--secondary shrink-0">{t("panel.browse")}</button>
        </div>
      </div>
      </div>

      {!compact && serverRunning && <div className="mt-4 app-card" >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="app-eyebrow">{isServerRunning(store.status.state) ? copy.running : store.status.state === 'starting' ? copy.starting : copy.stopping}</div>
            <TuningOptionMetadata fieldKey="raw-server:--model" />
            {liveModel && <div className="app-text-wrap text-[15px] font-semibold ui-color-ink" title={normalizeDisplayPath(liveModel)}>{modelDisplayName(models?.find((model) => model.path === liveModel)?.name ?? liveModel)}</div>}
            <div className="mt-1 break-words text-xs ui-color-muted">{store.status.url ?? '—'}</div>
            <details className="models-runtime-details mt-1">
            <summary>{t("section.diagnostics")}</summary>
            <div className="models-runtime-details-content">
            <div className="models-status-line" title={store.status.memory ? t("ui.modelsMemoryLine", { total: store.status.memory.total_mb.toLocaleString(), model: store.status.memory.model_mb.toLocaleString(), kv: store.status.memory.kv_mb.toLocaleString(), source: store.status.memory.source }) : undefined}>
              {store.status.memory ? t("ui.modelsMemoryLine", { total: store.status.memory.total_mb.toLocaleString(), model: store.status.memory.model_mb.toLocaleString(), kv: store.status.memory.kv_mb.toLocaleString(), source: store.status.memory.source }) : "—"}
            </div>
            <div className="models-status-line mt-1" title={store.status.lifecycle ? t("ui.modelsSlotsLine", { parallel: store.status.lifecycle.parallel || "auto", sleep: store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`, idle: store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0, requests: store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0 }) : undefined}>
              {store.status.lifecycle ? <>{t("ui.modelsSlotsLine", { parallel: store.status.lifecycle.parallel || "auto", sleep: store.status.lifecycle.sleep_idle_seconds < 0 ? "off" : `${store.status.lifecycle.sleep_idle_seconds}s`, idle: store.status.lifecycle.idle_seconds ?? store.status.idle_seconds ?? 0, requests: store.status.lifecycle.active_requests ?? store.status.active_requests ?? 0 })}{store.status.lifecycle.auto_unload_due ? ` · ${t("ui.autoUnloadDue")}` : ""}</> : "—"}
            </div>
            </div>
            </details>
          </div>
          <div className="models-header-actions flex min-w-0 w-full flex-wrap items-center gap-2 lg:ml-auto lg:w-auto lg:justify-end" data-testid="models-header-actions">
            {serverRunning && <button type="button" onClick={() => void api.unloadModel().then(() => notify(t("ui.unloadedOk"))).catch((error) => notify(`${t("ui.unloadFailed")}: ${error instanceof Error ? error.message : String(error)}`))} disabled={store.busy} className="app-button app-button--secondary app-button--sm">{t("ui.unloadModel")}</button>}
          </div>
        </div>
        {(store.status.state === "failed" || store.status.state === "crashed") && store.status.error && (
          <div className="mt-3 max-h-48 overflow-auto rounded-lg border p-3 text-xs leading-relaxed ui-border-color-error-border ui-background-error-bg ui-color-error-ink"  role="alert">
            <div className="mb-1 font-semibold">{t("ui.serverFailedTitle", { state: store.status.state })}</div>
            <pre className="whitespace-pre-wrap break-words">{normalizeDisplayText(store.status.error)}</pre>
          </div>
        )}
      </div>}

      </>}

      {focus !== "library" && <section className="mt-4 app-card"  aria-labelledby="lora-heading">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 id="lora-heading" className="app-section-title">{t("panel.loraAdapters")}</h2>
            <p className="mt-1 text-xs ui-color-muted" >{t("ui.loraSectionHint")}</p>
            <TuningOptionMetadata fieldKey="raw-server:--lora" />
            <TuningOptionMetadata fieldKey="raw-server:--lora-scaled" />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-xs ui-color-muted"  htmlFor="lora-scale">{t("ui.loraScale")}</label>
            <input id="lora-scale" value={adapterScale} onChange={(event) => setAdapterScale(event.target.value)} inputMode="decimal" className="app-input w-16 h-7 text-xs" />
            <button type="button" onClick={() => void addAdapter()} disabled={store.busy} className="app-button app-button--primary app-button--sm">{t("ui.loraAdd")}</button>
          </div>
        </div>
        {(cfg?.lora_adapters ?? []).length > 0 ? <div className="mt-3 space-y-2">{(cfg?.lora_adapters ?? []).map((adapter) => { const displayPath = normalizeDisplayPath(adapter.path); return <div key={adapter.path} className="flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 ui-border-color-border ui-background-surface-muted" ><div className="min-w-0 flex-1"><div className="app-text-wrap text-xs font-medium ui-color-ink"  title={displayPath}>{displayPath.split(/[\\/]/).pop()}</div><div className="app-text-wrap text-xs ui-color-faint"  title={displayPath}>{displayPath}</div></div><span className="text-xs tabular-nums ui-color-muted" >{t("ui.loraStartupScale", { scale: adapter.scale })}</span><button type="button" onClick={() => void removeAdapter(adapter.path)} disabled={store.busy} className="app-button app-button--ghost app-button--sm text-xs">{t("panel.remove")}</button></div>; })}</div> : <div className="mt-3 text-xs ui-color-faint" >{t("ui.loraNoStartup")}</div>}
        {serverRunning && <div className="mt-3 border-t pt-3 ui-border-color-border" ><div className="flex flex-wrap items-center justify-between gap-2"><span className="text-xs font-medium ui-color-ink" >{t("ui.loraServerAdapters")}</span><div className="flex gap-2"><button type="button" onClick={() => void refreshServerAdapters()} disabled={adapterBusy} className="app-button app-button--secondary app-button--sm"><StableLabel value={adapterBusy ? t("ui.reading") : t("ui.refresh")} labels={[t("ui.reading"), t("ui.refresh")]} /></button><button type="button" onClick={() => void applyServerAdapters()} disabled={adapterBusy || serverAdapters.length === 0} className="app-button app-button--primary app-button--sm">{t("ui.loraApplyScales")}</button></div></div>{serverAdapters.length > 0 ? <div className="mt-2 space-y-2">{serverAdapters.map((adapter) => { const displayPath = normalizeDisplayPath(adapter.path); return <label key={adapter.id} className="flex items-center gap-2 text-xs ui-color-muted" ><span className="min-w-0 flex-1 app-text-wrap" title={displayPath}>{displayPath.split(/[\\/]/).pop()}</span><input value={serverAdapterScales[adapter.id] ?? String(adapter.scale)} onChange={(event) => setServerAdapterScales((current) => ({ ...current, [adapter.id]: event.target.value }))} inputMode="decimal" className="app-input w-16 h-7 text-xs" aria-label={t("ui.loraScaleFor", { name: displayPath.split(/[\\/]/).pop() ?? displayPath })} /></label>; })}</div> : <div className="mt-2 text-xs ui-color-faint" >{t("ui.loraNoServerAdapters")}</div>}</div>}
      </section>}

      {focus !== "lora" && <div className="mt-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-2.5"><h2 className="text-sm font-semibold ui-color-ink" >{t("panel.models")} {models ? `(${visible.length})` : ""}</h2><input value={modelQuery} onChange={(event) => setModelQuery(event.target.value)} placeholder={t("panel.modelFilterPlaceholder")} aria-label={t("panel.searchModels")} className="app-input min-w-0 max-w-xs flex-1 h-7 text-xs" /></div>
        <label className="flex items-center gap-2 text-xs ui-color-muted" ><input type="checkbox" checked={showVision} onChange={(event) => setShowVision(event.target.checked)} className="ui-accent-color-accent-solid"  /> {t("panel.visionModels")}</label>
        {scanning ? <button type="button" onClick={cancelScan} className="app-button app-button--secondary app-button--sm">{t("panel.cancelScan")}</button> : <button type="button" onClick={() => setScanRequest((current) => current + 1)} className="app-button app-button--secondary app-button--sm">{scanError ? t("panel.retry") : t("panel.rescan")}</button>}
      </div>}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={pendingConfirm?.title ?? t("panel.confirmAction")}
        description={pendingConfirm?.description ?? ""}
        confirmLabel={pendingConfirm?.confirmLabel ?? t("common.confirm")}
        onConfirm={() => pendingConfirm?.onConfirm()}
        onCancel={() => setPendingConfirm(null)}
      />

      {focus !== "lora" && <div className="models-model-list mt-2.5 min-w-0" data-testid="models-list" role={visible.length > 0 ? "list" : "region"} aria-label={t("panel.ariaGgufModels")} aria-busy={scanning}>
        {scanning && <div className="p-6 text-center text-sm ui-color-muted" role="status">{t("panel.scanning")}</div>}
        {!scanning && models === null && !scanError && <div className="p-6 text-center text-sm ui-color-faint"  role="status">{t("ui.modelsLoading")}</div>}
        {!scanning && models !== null && !scanError && visible.length === 0 && (
          <div className="app-empty-state">
            <h3>{t("panel.noModels")}</h3>
            <p>{t("ui.modelsEmptyBody", { dir: dir ? normalizeDisplayPath(dir) : t("ui.modelsEmptyFolder") })}</p>
            {!!dir.trim() && <div className="app-empty-actions">
              <button type="button" className="app-button app-button--primary" onClick={() => void browse()}>{t("panel.chooseFolder")}</button>
            </div>}
          </div>
        )}
        {visible.map((model) => {
          const displayName = normalizeDisplayText(model.name);
          const incomplete = !!model.shards?.missing.length;
          const running = loadedModels.has(model.path) || !!model.shards?.files.some(path => loadedModels.has(path));
          const actionLabel = onSelectModel ? copy.setupAction : running ? t("ui.rowRunning") : serverRunning ? t("ui.rowRestartSwitch") : t("ui.rowStart");
          return (
            <div
              key={model.path}
              role="listitem"
              className={`models-model-row min-w-0${running ? ' is-loaded' : ''}`}

            >
              <button
                type="button"
                aria-label={onSelectModel ? `${copy.setupAction}: ${displayName}` : t("ui.selectModelNamed", { name: displayName })}
                title={normalizeDisplayPath(model.path)}
                // Opening a card only reads: it hands the model to the settings
                // dialog, which is where starting and stopping are decided. Gating
                // it on the server made every card dead for the length of a VRAM
                // load, while the header opened the same dialog throughout.
                disabled={incomplete}
                onClick={() => void selectModel(model)}
                className="models-model-name min-w-0 flex-1 rounded-lg px-3 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)]"

              >
                <span className="block app-text-wrap text-sm font-medium ui-color-ink" >{displayName}</span>
                {model.shards && <span className={`block app-text-wrap text-xs ${incomplete ? "ui-color-danger" : "ui-color-muted"}`}>{incomplete ? t("ui.modelShardsMissing", { count: model.shards.missing.length, total: model.shards.total }) : t("ui.modelShards", { count: model.shards.total })}</span>}
              </button>
              <div className="models-model-actions flex min-w-0 flex-nowrap items-center justify-end gap-1.5 overflow-x-auto px-1">
                <span className="shrink-0 text-xs tabular-nums ui-color-faint" >{model.size_mb.toFixed(0)} MB</span>
                {model.is_vision && <span className="rounded-full border px-1.5 py-0.5 text-xs font-medium ui-border-color-border ui-background-surface-muted ui-color-muted" >{t("ui.visionTag")}</span>}
                {running && <span className="app-status-badge app-status-badge--success">{copy.running}</span>}
                {model.is_vision && <button type="button" onClick={() => { if (cfg?.mmproj !== model.path) void setProjector(model); }} disabled={incomplete || cfg?.mmproj === model.path || store.busy || !projectorChangeAllowed(store.status.state)} title={!projectorChangeAllowed(store.status.state) ? t("ui.stopBeforeProjector") : undefined} aria-label={`${cfg?.mmproj === model.path ? t("ui.rowProjectorActive") : t("ui.rowUseProjector")}: ${displayName}`} className="app-button app-button--secondary app-button--sm shrink-0"><StableLabel value={cfg?.mmproj === model.path ? t("ui.rowProjectorActive") : t("ui.rowUseProjector")} labels={[t("ui.rowProjectorActive"), t("ui.rowUseProjector")]} /></button>}
                {!onSelectModel && <button type="button" onClick={() => { if (!running) void selectAndStart(model); }} disabled={incomplete || running || store.busy} aria-label={`${actionLabel}: ${displayName}`} className="app-button app-button--primary app-button--sm shrink-0"><StableLabel value={actionLabel} labels={[t("ui.rowRunning"), t("ui.rowRestartSwitch"), t("ui.rowStart")]} /></button>}
              </div>
              <div className="models-file-actions">
                  <code>{normalizeDisplayPath(model.path)}</code>
                  <button type="button" onClick={() => void copyPath(model.path)} aria-label={`${t("panel.copyPath")}: ${displayName}`} className="app-button app-button--ghost app-button--sm">{t("panel.copyPath")}</button>
                  <button type="button" onClick={() => void removeModel(model)} disabled={running || store.busy || serverRunning} title={serverRunning ? t("ui.stopBeforeDelete") : undefined} aria-label={`${t("panel.delete")}: ${displayName}`} className="app-button app-button--ghost app-button--sm ui-color-danger">{t("panel.delete")}</button>
              </div>
            </div>
          );
        })}
      </div>}
    </div>
  );
}
