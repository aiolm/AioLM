import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as api from '../../shared/api/index';
import { providerOf } from '../../shared/api/providers';
import type { AppStore } from '../../shared/state/store';
import { finishTask, registerTask, updateTask, useTasks } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { isServerRunning } from '../../shared/lib/serverLifecycle';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';
import { readPerformanceHistory, summarizePerformanceRows, summarizeServingPoints } from './performanceRecords';
import { exportBenchmarkResults, type BenchmarkExportFormat } from './benchmarkExport';
import { performanceMarkdown } from './performanceMarkdown';
import { deleteBenchmarkHistoryRecord, initializeBenchmarkHistory, loadAllBenchmarkHistory, loadBenchmarkHistoryPage, rememberBenchmarkResult } from './benchmarkRepository';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { publicModelSource } from '../../shared/contracts/benchmark/publicBenchmark';
import { benchmarkCopy } from './benchmarkCopy';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { executionChanges, executionConfig } from '../../shared/config/executionSettings';
import { materializeProfileApplication, profileTargetKey, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { appliedProfile, profileLibrary } from '../model-settings/profileEditor';
import { applyProfile } from '../model-settings/profileWorkspaceState';
import { modelActions } from '../../shared/i18n/modelActions';
import { withoutCancelledTrials } from './benchmarkCancellation';
import { runSetupGaps } from '../../shared/runtime/runReadiness';
import { useInstalledRuntimes } from '../../shared/runtime/installedRuntimes';
import { useBenchmarkProfileImport } from './BenchmarkExplorerActions';
import { benchmarkExplorerCopy } from './benchmarkExplorerCopy';
import { useModelNames } from '../../shared/ui/ModelName';
import { TASK_ID } from './performanceBenchConfig';
import { usePerformanceConditions } from './usePerformanceConditions';

type Copy = ReturnType<typeof benchmarkCopy>;

function benchmarkTarget(current: api.AppConfig, saved?: ProfileApplication | null) {
  const application = saved ?? appliedProfile(current);
  const base = application ? { ...executionConfig(current, application.settings), active_model: application.model } : current;
  const resolved = resolveProfileForExecution(base, profileLibrary(current), application);
  const config = applyProfile(base, resolved.profile);
  const next = materializeProfileApplication(config, resolved.application.system_prompt, resolved.profile);
  config.settings_profiles = { ...resolved.library, applied: { ...resolved.library.applied, [profileTargetKey(config.active_model)]: next } };
  return { config, application: next };
}

function progressLabel(phase: api.PerformanceBenchmarkProgress["phase"] | undefined, copy: Copy): string {
  switch (phase) {
    case "warmup": return copy.starting;
    case "single": return copy.measuringSingle;
    case "batch": return copy.measuringBatch;
    case "cleanup": return copy.cleanup;
    default: return copy.starting;
  }
}

export function usePerformanceBench({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { locale } = useI18n();
  const setupFormId = useId();
  const copy = benchmarkCopy(locale);
  const explorerCopy = benchmarkExplorerCopy(locale);
  const profileImport = useBenchmarkProfileImport(store);
  const modelCopy = modelActions(locale);
  const modelSettings = useModelSettings();
  const [targetApplication, setTargetApplication] = useState<ProfileApplication | null>(() => store.cfg ? benchmarkTarget(store.cfg).application : null);
  const installedRuntimes = useInstalledRuntimes(providerOf(targetApplication?.settings ?? store.cfg ?? {}) === 'llama.cpp');
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsError, setSessionsError] = useState(false);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [stoppingSessions, setStoppingSessions] = useState(false);
  const [phase, setPhase] = useState<"idle" | "running" | "cancelling">("idle");
  const [progress, setProgress] = useState<api.PerformanceBenchmarkProgress | null>(null);
  const [rows, setRows] = useState<api.PerformanceBenchmarkRow[]>([]);
  const [result, setResult] = useState<api.PerformanceBenchmarkResult | null>(null);
  const [record, setRecord] = useState<PerformanceBenchmarkRecord | null>(null);
  const [history, setHistory] = useState<PerformanceBenchmarkRecord[]>(() => isNativeRuntimeAvailable() ? [] : readPerformanceHistory());
  const [historyOffset, setHistoryOffset] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState(false);
  const [historyWarnings, setHistoryWarnings] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportFormat, setExportFormat] = useState<BenchmarkExportFormat>('xlsx');
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [sharingRevision, setSharingRevision] = useState(0);
  const [sharingBusy, setSharingBusy] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<PerformanceBenchmarkRecord | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState(false);
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  const [selectedHistory, setSelectedHistory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [runTarget, setRunTarget] = useState<ReturnType<typeof benchmarkTarget> | null>(null);
  const rowsRef = useRef<api.PerformanceBenchmarkRow[]>([]);
  const activeRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const historyRevisionRef = useRef(0);
  const deleteInFlight = useRef(false);
  const copyRequestRef = useRef(0);
  const copyPendingRef = useRef(false);
  const copyMountedRef = useRef(false);
  const resetCopied = () => { copyRequestRef.current += 1; setCopied(false); };
  const tasks = useTasks();
  const busy = phase !== "idle";
  const otherBenchmark = tasks.some((task) => task.kind === "benchmark" && task.id !== TASK_ID && (task.state === "running" || task.state === "cancelling"));
  const serverRunning = isServerRunning(store.status.state);
  const defaultTarget = useMemo(() => store.cfg ? benchmarkTarget(store.cfg) : null, [store.cfg]);
  const target = useMemo(() => store.cfg && targetApplication ? benchmarkTarget(store.cfg, targetApplication) : defaultTarget, [store.cfg, targetApplication, defaultTarget]);
  const targetConfig = target?.config ?? null;
  const { promptBytes, setPromptBytes, concurrencies, setConcurrencies, warmup, setWarmup,
    outputTokens, setOutputTokens, repetitions, setRepetitions, corpus, setCorpus,
    valid, total, admission, setAdmissionRevision, toggle } = usePerformanceConditions(targetConfig, active, busy);
  const model = targetConfig?.active_model ?? "";
  const targetDiffers = !!defaultTarget && !!target && (defaultTarget.application.profile_id !== target.application.profile_id
    || Object.keys(executionChanges(defaultTarget.config, target.config)).length > 0);
  const displayedTarget = busy && runTarget ? runTarget : target;
  const displayedModel = { model: displayedTarget?.config.active_model ?? '', backend: displayedTarget?.config.active_backend ?? '', build: displayedTarget?.config.active_build ?? '' };
  const blockingSessions = sessions.filter(session => session.id !== 'default' && ['running', 'starting', 'stopping'].includes(session.state));
  // A measurement launches its own server, so it needs the same setup a run
  // does. Naming what is missing beats a run button that is dead for reasons
  // the panel never states.
  const setupGaps = targetConfig
    ? runSetupGaps({ activeModel: model, activeProvider: targetConfig.active_provider, activeRuntime: targetConfig.active_runtime, activeBackend: targetConfig.active_backend, activeBuild: targetConfig.active_build })
    : [];
  const canRun = admission?.status === 'supported' && !!targetConfig && !setupGaps.length && valid && !busy && !exporting && !deleting && !serverRunning && !store.busy && !otherBenchmark && !sessionsError && (!modelSettings || sessionsReady) && !blockingSessions.length && !stoppingSessions;
  const selectedRecord = selectedHistory ? history.find((item) => item.id === selectedHistory) ?? null : record;
  const localImportUnavailable = selectedRecord?.schemaVersion === 2 && !selectedRecord.result.provenance;
  const copyTargetRef = useRef({ record: selectedRecord, locale });
  copyTargetRef.current = { record: selectedRecord, locale };
  const previousRecords = history.filter(item => item.id !== record?.id);
  const historyModelNames = useModelNames(previousRecords.map(item => item.schemaVersion === 1 ? item.model : ''));
  const exportAllDiffers = history.length > 0 && (history.length > 1 || history[0]?.id !== selectedRecord?.id);
  const visibleRows = selectedHistory && selectedRecord ? selectedRecord.result.rows : rows;
  const visibleResult = selectedHistory && selectedRecord ? selectedRecord.result : result;
  const provenance = selectedRecord?.result.provenance;
  const selectedGpus = provenance?.environment?.execution?.selected_gpus;
  const selectedGpuLabel = Array.isArray(selectedGpus) ? selectedGpus.map(gpu => typeof gpu?.name === 'string' ? gpu.name : '').filter(Boolean).join(' · ') : '';
  const modelHash = provenance?.model?.sha256;
  const legacyRecord = selectedRecord?.schemaVersion === 1 ? selectedRecord : null;
  const servingRecord = selectedRecord?.schemaVersion === 2 ? selectedRecord : null;
  const summary = useMemo(() => legacyRecord ? summarizePerformanceRows(legacyRecord.result.rows) : [], [legacyRecord]);
  const servingPoints = useMemo(() => summarizeServingPoints(servingRecord ? servingRecord.result.rows : rows), [servingRecord, rows]);
  const singleRows = summary.filter((row) => row.concurrency === 1);
  const batchRows = summary.filter((row) => row.concurrency > 1);
  const servingProvenance = servingRecord?.result.provenance;
  const modelSource = servingProvenance ? publicModelSource(servingProvenance.model) : undefined;

  useEffect(() => {
    copyMountedRef.current = true;
    return () => { copyMountedRef.current = false; copyRequestRef.current += 1; };
  }, []);

  useEffect(() => {
    if (!targetApplication && store.cfg) setTargetApplication(benchmarkTarget(store.cfg).application);
  }, [store.cfg, targetApplication]);
  const refreshSessions = useSessionPolling({ active: active && !!modelSettings, intervalMs: 2000,
    onData: value => { setSessions(value); setSessionsError(false); setSessionsReady(true); },
    onError: () => { setSessionsError(true); setSessionsReady(false); },
  });
  const loadHistory = async (more = false) => {
    if (historyLoading || deleteInFlight.current || (more && historyOffset === null)) return;
    const revision = ++historyRevisionRef.current;
    setHistoryLoading(true);
    try {
      const page = more ? await loadBenchmarkHistoryPage(historyOffset!) : await initializeBenchmarkHistory();
      if (revision !== historyRevisionRef.current) return;
      setHistory(previous => more ? [...new Map([...previous, ...page.records].map(item => [item.id, item])).values()] : page.records);
      setHistoryOffset(page.next_offset); setHistoryError(false);
      setHistoryWarnings(previous => (more && previous) || !!page.warnings?.length);
    } catch { if (revision === historyRevisionRef.current) setHistoryError(true); }
    finally { if (revision === historyRevisionRef.current) setHistoryLoading(false); }
  };
  useEffect(() => {
    if (!isNativeRuntimeAvailable()) return;
    let disposed = false;
    const revision = ++historyRevisionRef.current;
    setHistoryLoading(true);
    void initializeBenchmarkHistory().then(page => {
      if (!disposed && revision === historyRevisionRef.current) { setHistory(page.records); setHistoryOffset(page.next_offset); setHistoryError(false); setHistoryWarnings(!!page.warnings?.length); }
    }).catch(() => { if (!disposed && revision === historyRevisionRef.current) setHistoryError(true); })
      .finally(() => { if (!disposed && revision === historyRevisionRef.current) setHistoryLoading(false); });
    return () => { disposed = true; };
  }, []);
  const editModel = (section: string) => {
    const current = store.getConfig?.() ?? store.cfg;
    if (busy || !current) return;
    const selected = benchmarkTarget(current, targetApplication);
    modelSettings?.open({ target: { kind: 'benchmark', id: TASK_ID }, config: selected.config, application: selected.application, section,
      onApply: (cfg, application) => { setTargetApplication(benchmarkTarget(cfg, application).application); } });
  };
  const stopSessions = async () => {
    if (stoppingSessions) return;
    setStoppingSessions(true);
    try { for (const session of blockingSessions) await api.sessionStop(session.id); await refreshSessions(); }
    catch (cause) { setError(normalizeDisplayText(String(cause))); }
    finally { setStoppingSessions(false); }
  };

  useEffect(() => {
    let mounted = true;
    void api.deviceProfile().then((value) => { if (mounted) setDevice(value); }).catch(() => undefined);
    return () => { mounted = false; };
  }, []);

  const cancel = async () => {
    if (!activeRef.current || cancelRequestedRef.current) return;
    cancelRequestedRef.current = true;
    setPhase("cancelling");
    updateTask(TASK_ID, { state: "cancelling", phase: copy.cancelling });
    try { await api.benchCancel(); }
    catch (caught) {
      cancelRequestedRef.current = false;
      setPhase("running");
      setError(normalizeDisplayText(caught instanceof Error ? caught.message : String(caught)));
      updateTask(TASK_ID, { state: "running" });
    }
  };

  const run = async () => {
    if (!canRun || !store.cfg || activeRef.current) return;
    const snapshot = structuredClone(benchmarkTarget(store.getConfig?.() ?? store.cfg, targetApplication));
    const cfg = snapshot.config;
    const runId = `performance-${crypto.randomUUID()}`;
    const request: api.PerformanceBenchmarkRequest = { run_id: runId, method: { id: 'openai-chat-serving', version: 2 }, context_profile: corpus, prompt_bytes: [...promptBytes].sort((a, b) => a - b), max_output_tokens: outputTokens, concurrencies: [...concurrencies].sort((a, b) => a - b), repetitions, warmup, request_usage: true };
    const createdAt = Date.now();
    setRunTarget(snapshot);
    activeRef.current = true;
    cancelRequestedRef.current = false;
    rowsRef.current = [];
    setPhase("running"); setProgress(null); setRows([]); setResult(null); setRecord(null); setSelectedHistory(""); setError(null); resetCopied(); setStorageError(false); setExportNotice(null); setHistoryNotice(null);
    registerTask({ id: TASK_ID, kind: "benchmark", label: copy.title, phase: copy.starting, received: 0, total, interruptible: true, cancel });
    let unlisten: (() => void) | undefined;
    let finalResult: api.PerformanceBenchmarkResult;
    let executionReturned = false;
    try {
      unlisten = await api.onPerformanceBenchmarkProgress((event) => {
        if (event.run_id !== runId || !activeRef.current) return;
        setProgress(event);
        const row = event.row;
        if (row && !(cancelRequestedRef.current && row.error)) {
          const index = rowsRef.current.findIndex((item) => item.id === row.id);
          rowsRef.current = index < 0 ? [...rowsRef.current, row] : rowsRef.current.map((item, i) => i === index ? row : item);
          setRows(rowsRef.current);
        }
        updateTask(TASK_ID, { phase: cancelRequestedRef.current ? copy.cancelling : progressLabel(event.phase, copy), received: event.completed, total: event.total });
      });
      if (cancelRequestedRef.current) {
        finalResult = { run_id: runId, rows: [], status: "cancelled", args: [] };
      } else {
        finalResult = await api.runPerformanceBench(cfg, request);
        executionReturned = true;
        if (!finalResult.rows.length && rowsRef.current.length) finalResult = { ...finalResult, rows: rowsRef.current };
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      finalResult = { run_id: runId, rows: rowsRef.current, status: cancelRequestedRef.current ? "cancelled" : "failed", message, args: [] };
    } finally {
      unlisten?.();
      void store.refreshStatus();
    }
    finalResult = withoutCancelledTrials(finalResult);
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 2, id: runId, createdAt, model: cfg.active_model, request, result: finalResult };
    // A rejected admission is not a failed measurement. Genuine returned
    // failures (including zero-row failures after start) remain recordable.
    const unstarted = !executionReturned && !finalResult.rows.length;
    const emptyCancellation = finalResult.status === 'cancelled' && !finalResult.rows.length;
    const noRecord = emptyCancellation || unstarted;
    setRows(finalResult.rows); setResult(noRecord ? null : finalResult); setRecord(noRecord ? null : saved);
    historyRevisionRef.current++;
    setHistoryLoading(false);
    try {
      const page = noRecord ? await loadBenchmarkHistoryPage() : await rememberBenchmarkResult(saved);
      setHistory(page.records); setHistoryOffset(page.next_offset);
    } catch { if (noRecord) setHistoryError(true); else setStorageError(true); }
    activeRef.current = false;
    setPhase("idle");
    if (finalResult.status === "failed") setError(finalResult.message ?? copy.failed);
    finishTask(TASK_ID, finalResult.status === "cancelled" ? "cancelled" : finalResult.status === "failed" || finalResult.status === "partial" ? "failed" : "completed", finalResult.message ?? undefined);
  };

  const advancedSummary = warmup ? copy.warmupShort : copy.noneSelected;
  const statusLabel = visibleResult ? ({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[visibleResult.status]) : null;
  const progressMessage = phase === "cancelling" ? copy.cancelling : progressLabel(progress?.phase, copy);
  const copyResults = async () => {
    if (!selectedRecord || copyPendingRef.current) return;
    const selected = selectedRecord;
    const request = ++copyRequestRef.current;
    const current = () => copyMountedRef.current && request === copyRequestRef.current
      && copyTargetRef.current.record === selected && copyTargetRef.current.locale === locale;
    copyPendingRef.current = true;
    setCopying(true);
    try {
      await navigator.clipboard.writeText(performanceMarkdown(selected, locale));
      if (current()) setCopied(true);
    } catch (caught) { if (current()) setError(caught instanceof Error ? caught.message : String(caught)); }
    finally { copyPendingRef.current = false; if (copyMountedRef.current) setCopying(false); }
  };
  const exportResults = async (all: boolean) => {
    if (exporting || busy || deleteInFlight.current) return;
    if (!all && !selectedRecord) return;
    setExporting(true); setExportNotice(null); setError(null);
    try {
      const records = all ? await loadAllBenchmarkHistory() : [selectedRecord!];
      const outcome = await exportBenchmarkResults(records, all ? 'all' : 'selected', exportFormat, locale);
      if (outcome !== 'cancelled') setExportNotice(outcome === 'saved' ? copy.exportSaved : copy.exportStarted);
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : '';
      setError(detail ? `${copy.exportError} ${detail}` : copy.exportError);
    }
    finally { setExporting(false); }
  };

  const deleteSelectedHistory = async () => {
    if (!pendingDelete || deleteInFlight.current || busy || otherBenchmark || exporting || sharingBusy || historyLoading) return;
    const id = pendingDelete.id;
    deleteInFlight.current = true;
    setDeleting(true); setDeleteError(false);
    try {
      await deleteBenchmarkHistoryRecord(id);
      historyRevisionRef.current++;
      const remaining = history.filter(item => item.id !== id);
      const current = record?.id === id ? null : record;
      const selectRemaining = (items: PerformanceBenchmarkRecord[]) => setSelectedHistory(items[0]?.id === current?.id ? '' : items[0]?.id ?? '');
      setHistory(remaining);
      // Keep the next page reachable even if refreshing after deletion fails.
      setHistoryOffset(offset => offset === null ? null : Math.max(0, offset - (history.length - remaining.length)));
      selectRemaining(remaining);
      if (record?.id === id) {
        setRecord(null); setResult(null); setRows([]); setProgress(null);
        rowsRef.current = [];
        setStorageError(false);
      }
      resetCopied(); setError(null); setExportNotice(null);
      setPendingDelete(null); setHistoryNotice(copy.deleteSuccess);
      try {
        const page = await loadBenchmarkHistoryPage();
        setHistory(page.records); setHistoryOffset(page.next_offset);
        setHistoryError(false); setHistoryWarnings(!!page.warnings?.length);
        selectRemaining(page.records);
      } catch { setHistoryError(true); }
    } catch { setDeleteError(true); }
    finally { deleteInFlight.current = false; setDeleting(false); }
  };
  return {
    store, active, setupFormId, copy, explorerCopy, profileImport,
    modelCopy, modelSettings, installedRuntimes, sessionsError, stoppingSessions,
    promptBytes, setPromptBytes, concurrencies, setConcurrencies, warmup, setWarmup,
    outputTokens, setOutputTokens, repetitions, setRepetitions, corpus, setCorpus,
    phase, progress, rows, record, history,
    historyOffset, historyLoading, historyError, historyWarnings, exporting, exportFormat,
    setExportFormat, exportNotice, setExportNotice, sharingRevision, setSharingRevision, sharingBusy,
    setSharingBusy, pendingDelete, setPendingDelete, deleting, deleteError, setDeleteError,
    historyNotice, setHistoryNotice, selectedHistory, setSelectedHistory, error, setError,
    storageError, copied, copying, device, setAdmissionRevision, resetCopied,
    busy, otherBenchmark, valid, serverRunning,
    targetDiffers, displayedTarget, displayedModel, blockingSessions, setupGaps, admission,
    canRun, total, selectedRecord, localImportUnavailable, previousRecords, historyModelNames,
    exportAllDiffers, visibleRows, visibleResult, provenance, selectedGpuLabel, modelHash,
    legacyRecord, servingRecord, servingPoints, singleRows, batchRows,
    servingProvenance, modelSource, refreshSessions, loadHistory, editModel, stopSessions,
    cancel, run, toggle, advancedSummary, statusLabel, progressMessage,
    copyResults, exportResults, deleteSelectedHistory,
    importDefaultTarget: () => { const current = store.getConfig?.() ?? store.cfg; if (current) setTargetApplication(benchmarkTarget(current).application); },
  };
}
