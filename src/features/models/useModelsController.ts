import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import * as api from "../../shared/api/index";
import { runtimeCatalogSnapshot, subscribeRuntimeCatalog } from '../../shared/api/providers';
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { executionText } from '../../shared/i18n/executionI18n';
import { useI18n } from "../../shared/i18n/i18n";
import { memorySourceText, statusDisplayCopy } from '../../shared/i18n/statusDisplayCopy';
import { modelPathIdentity, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { isLifecycleCancellation, isServerBusy, isServerRunning } from "../../shared/lib/serverLifecycle";
import { formatMebibytes } from '../../shared/lib/units';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { startModelScan } from '../../shared/runtime/modelScan';
import { runSetupGaps } from '../../shared/runtime/runReadiness';
import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';
import type { AppStore } from "../../shared/state/store";
import { getTaskSnapshot } from '../../shared/state/taskRegistry';
import { projectorChangeAllowed } from "../chat/visionState";
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { invalidateModelCatalog, MODEL_CATALOG_CHANGED } from '../model-settings/useModelCatalog';
import { forgetExecution } from './modelExecutionState';
import { modelUpdatesCopy } from './modelUpdatesCopy';
import { isCurrentScan, nextScanGeneration } from "./scanGeneration";
import { useModelUpdates, type ModelUpdateCatalog } from './useModelUpdates';

export type ModelsPanelProps = { store: AppStore; onSelectModel?: (model: api.GgufModel) => Promise<void>; onDiscoverModels?: () => void; onModels?: (models: api.GgufModel[]) => void; compact?: boolean; active?: boolean; sessions?: api.SessionStatus[]; sessionsReady?: boolean; children?: ReactNode };

export function useModelsController({ store, onSelectModel, onModels, active = true, sessions: providedSessions, sessionsReady: providedSessionsReady = false }: ModelsPanelProps) {
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
  const [dirDraft, setDirDraft] = useState<string | null>(null);
  const dir = dirDraft ?? cfg?.models_dir?.trim() ?? "";
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
    setScanRequest((current) => current + 1);
  }, [cfg?.models_dir, folderAction]);

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
  const matchingModels = (models ?? []).filter((model) => {
    if (providerFilter !== 'all' && !api.modelCompatibleForLibrary(model, providerFilter)) return false;
    if (!normalizedQuery) return true;
    return `${model.name} ${normalizeDisplayPath(model.path)}`.toLowerCase().includes(normalizedQuery);
  });
  const visible = showVision ? matchingModels : matchingModels.filter(model => !model.is_vision);
  const onlyHiddenVision = visible.length === 0 && !showVision && matchingModels.length > 0;
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
    setDirDraft(dir);
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
      setDirDraft(savedDir);
      requestedScanDirRef.current = savedDir;
      setScanRequest((current) => current + 1);
      setFolderSaved(true);
    } catch (error) {
      setFolderError(`${t(saving ? "panel.saveFailed" : "panel.browseFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      folderInFlight.current = false;
      setDirDraft(null);
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
  return { t, locale, copy, cfg, models, updateCatalog, scanning, scanError, scanTruncated, modelQuery, setModelQuery, modelFilterInput, providerFilter, setProviderFilter, dir, folderSaved, setFolderSaved, folderAction, folderError, setFolderError, setScanRequest, showVision, setShowVision, flash, notify, dismissFlash, pendingConfirm, setPendingConfirm, updatesCopy, sessionsReady, updateBlocked, modelUpdates, cancelScan, visible, onlyHiddenVision, hasModelFilters, clearModelFilters, liveModel, serverRunning, memoryLine, lifecycle, lifecycleLine, runtimeGap, isModelLoaded, selectModel, setProjector, browse, selectAndStart, copyPath, removeModel, modelSettings };
}
