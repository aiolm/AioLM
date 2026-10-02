import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import Badge from '../../shared/ui/Badge';
import EmptyState from '../../shared/ui/EmptyState';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import ProgressBar from '../../shared/ui/ProgressBar';
import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { finishTask, registerTask, updateTask, useTasks } from "../../shared/state/taskRegistry";
import { useI18n } from "../../shared/i18n/i18n";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { readPerformanceHistory, summarizePerformanceRows, type PerformanceBenchmarkRecord } from "./performanceRecords";
import { exportBenchmarkResults, type BenchmarkExportFormat } from './benchmarkExport';
import { performanceMarkdown } from './performanceMarkdown';
import { deleteBenchmarkHistoryRecord, initializeBenchmarkHistory, loadAllBenchmarkHistory, loadBenchmarkHistoryPage, rememberBenchmarkResult } from './benchmarkRepository';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { BenchmarkOwnedList } from './BenchmarkOwnedList';
import { BenchmarkEnvironment } from './BenchmarkEnvironment';
import { benchmarkCopy } from "./benchmarkCopy";
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { executionChanges, executionConfig } from '../../shared/config/executionSettings';
import { materializeProfileApplication, profileTargetKey, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { appliedProfile, profileLibrary } from '../model-settings/profileEditor';
import { applyProfile } from '../model-settings/profileWorkspaceState';
import { modelActions } from '../../shared/i18n/modelActions';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { withoutCancelledTrials } from './benchmarkCancellation';
import { formatRecordedRuntimeVersion } from '../../shared/runtime/runtimeUtils';
import { runSetupGapMessage, runSetupGaps } from '../../shared/runtime/runReadiness';
import { executionText } from '../../shared/i18n/executionI18n';
import { runtimeVersionLabel, useInstalledRuntimes } from '../../shared/runtime/installedRuntimes';
import { formatBytes, formatCpuCores } from '../../shared/lib/units';

const PROMPT_LENGTHS = [1024, 4096, 8192, 16384, 32768, 65536, 131072, 200000];
const BATCH_SIZES = [2, 4, 8];
const CORPORA = ["code_python", "code_mixed", "novel_ko", "novel_en", "novel_ja"] as const;
const TASK_ID = "performance-benchmark-active";
type Copy = ReturnType<typeof benchmarkCopy>;
type Summary = ReturnType<typeof summarizePerformanceRows>[number];

function benchmarkTarget(current: api.AppConfig, saved?: ProfileApplication | null) {
  const application = saved ?? appliedProfile(current);
  const base = application ? { ...executionConfig(current, application.settings), active_model: application.model } : current;
  const resolved = resolveProfileForExecution(base, profileLibrary(current), application);
  const config = applyProfile(base, resolved.profile, true);
  const next = materializeProfileApplication(config, resolved.application.system_prompt, resolved.profile);
  config.settings_profiles = { ...resolved.library, applied: { ...resolved.library.applied, [profileTargetKey(config.active_model)]: next } };
  return { config, application: next };
}

function numberLabel(value: number | null | undefined, copy: Copy, digits = 1): string {
  return value == null || !Number.isFinite(value) ? copy.unavailable : value.toFixed(digits);
}

const startsOption = (token: string | undefined) => token !== undefined && /^--?[a-zA-Z]/.test(token);

/** One line per launch argument: an option keeps the value it was given. */
function argumentLines(args: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const option = JSON.stringify(normalizeDisplayText(args[index]));
    // A following token that does not begin another option is this option's value.
    if (startsOption(args[index]) && args[index + 1] !== undefined && !startsOption(args[index + 1])) {
      lines.push(`${option} ${JSON.stringify(normalizeDisplayText(args[index + 1]))}`);
      index += 1;
    } else {
      lines.push(option);
    }
  }
  return lines;
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

function ResultTable({ rows, batch, copy }: { rows: Summary[]; batch: boolean; copy: Copy }) {
  if (!rows.length) return null;
  return <section className="app-card app-card--flush performance-card performance-results" aria-labelledby={batch ? "perf-batch-title" : "perf-single-title"}>
    <div className="performance-card-heading"><h3 id={batch ? "perf-batch-title" : "perf-single-title"}>{batch ? copy.batch : copy.single}</h3><Badge>{rows.length}</Badge></div>
    <div className="performance-table-scroll" role="region" aria-label={batch ? copy.batch : copy.single} tabIndex={0}>
      <table>
        <caption className="sr-only">{batch ? copy.batch : copy.single}</caption>
        <thead><tr>
          <th scope="col">{copy.test}</th>{batch && <th scope="col">{copy.concurrency}</th>}<th scope="col">{copy.repeat}</th>
          <th scope="col">{copy.ttft}<small>{copy.milliseconds}</small></th><th scope="col">{copy.tpot}<small>{copy.milliseconds}</small></th>
          <th scope="col" className="performance-phase-heading" title={copy.ppHint}>{copy.pp}<small>{copy.tokens}</small></th><th scope="col" className="performance-phase-heading" title={copy.tgHint}>{copy.tg}<small>{copy.tokens}</small></th>
          {batch && <th scope="col">{copy.speedup}</th>}<th scope="col">{copy.e2e}<small>{copy.seconds}</small></th><th scope="col" title={copy.throughputHint}>{copy.throughput}<small>{copy.tokens}</small></th><th scope="col" title={copy.memoryHint}>{copy.memory}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <th scope="row">{row.prompt_tokens.toLocaleString()} / {row.generation_length.toLocaleString()}{row.error && <span className="performance-row-error">{normalizeDisplayText(row.error)}</span>}</th>
          {batch && <td>{row.concurrency}×</td>}<td>{row.samples}</td>
          <td>{numberLabel(row.ttft_ms, copy)}</td><td>{numberLabel(row.tpot_ms, copy, 2)}</td><td>{numberLabel(row.pp_tps, copy)}</td>
          <td className="performance-metric-primary">{numberLabel(row.tg_tps, copy)}{row.samples > 1 && row.tg_stddev != null && <small>± {numberLabel(row.tg_stddev, copy)}</small>}</td>
          {batch && <td>{row.speedup == null ? copy.unavailable : `${row.speedup.toFixed(2)}×`}</td>}
          <td>{row.error ? copy.unavailable : numberLabel(row.e2e_ms / 1000, copy, 2)}</td><td>{numberLabel(row.total_tps, copy)}</td><td>{row.peak_memory_bytes == null ? copy.unavailable : formatBytes(row.peak_memory_bytes)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export default function PerformanceBench({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { locale } = useI18n();
  const copy = benchmarkCopy(locale);
  const modelCopy = modelActions(locale);
  const runCopy = executionText[locale];
  const installedRuntimes = useInstalledRuntimes();
  const modelSettings = useModelSettings();
  const [targetApplication, setTargetApplication] = useState<ProfileApplication | null>(() => store.cfg ? benchmarkTarget(store.cfg).application : null);
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsError, setSessionsError] = useState(false);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [stoppingSessions, setStoppingSessions] = useState(false);
  const [promptLengths, setPromptLengths] = useState([4096, 16384]);
  const [batchSizes, setBatchSizes] = useState([2, 4]);
  const [generation, setGeneration] = useState("128");
  const [repetitions, setRepetitions] = useState("1");
  const [corpus, setCorpus] = useState<(typeof CORPORA)[number]>("code_python");
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
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [runTarget, setRunTarget] = useState<ReturnType<typeof benchmarkTarget> | null>(null);
  const rowsRef = useRef<api.PerformanceBenchmarkRow[]>([]);
  const activeRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const historyRevisionRef = useRef(0);
  const deleteInFlight = useRef(false);
  const tasks = useTasks();
  const busy = phase !== "idle";
  const otherBenchmark = tasks.some((task) => task.kind === "benchmark" && task.id !== TASK_ID && (task.state === "running" || task.state === "cancelling"));
  const generationNumber = Number(generation);
  const repetitionsNumber = Number(repetitions);
  const validGeneration = Number.isInteger(generationNumber) && generationNumber >= 1 && generationNumber <= 4096;
  const validRepetitions = Number.isInteger(repetitionsNumber) && repetitionsNumber >= 1 && repetitionsNumber <= 10;
  const valid = promptLengths.length > 0 && validGeneration && validRepetitions;
  const serverRunning = isServerRunning(store.status.state);
  const defaultTarget = useMemo(() => store.cfg ? benchmarkTarget(store.cfg) : null, [store.cfg]);
  const target = useMemo(() => store.cfg && targetApplication ? benchmarkTarget(store.cfg, targetApplication) : defaultTarget, [store.cfg, targetApplication, defaultTarget]);
  const targetConfig = target?.config ?? null;
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
    ? runSetupGaps({ activeModel: model, activeBackend: targetConfig.active_backend, activeBuild: targetConfig.active_build })
    : [];
  const canRun = !!targetConfig && !setupGaps.length && valid && !busy && !exporting && !deleting && !serverRunning && !store.busy && !otherBenchmark && !sessionsError && (!modelSettings || sessionsReady) && !blockingSessions.length && !stoppingSessions;
  const total = promptLengths.length * (batchSizes.length + 1) * (validRepetitions ? repetitionsNumber : 0);
  const selectedRecord = selectedHistory ? history.find((item) => item.id === selectedHistory) ?? null : record;
  const previousRecords = history.filter(item => item.id !== record?.id);
  const exportAllDiffers = history.length > 0 && (history.length > 1 || history[0].id !== selectedRecord?.id);
  const visibleRows = selectedHistory && selectedRecord ? selectedRecord.result.rows : rows;
  const visibleResult = selectedHistory && selectedRecord ? selectedRecord.result : result;
  const provenance = selectedRecord?.result.provenance;
  const selectedGpus = provenance?.environment?.execution?.selected_gpus;
  const selectedGpuLabel = Array.isArray(selectedGpus) ? selectedGpus.map(gpu => typeof gpu?.name === 'string' ? gpu.name : '').filter(Boolean).join(' · ') : '';
  const modelHash = provenance?.model?.sha256;
  const summary = useMemo(() => summarizePerformanceRows(visibleRows), [visibleRows]);
  const singleRows = summary.filter((row) => row.concurrency === 1);
  const batchRows = summary.filter((row) => row.concurrency > 1);

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
    const request: api.PerformanceBenchmarkRequest = { run_id: runId, context_profile: corpus, prompt_lengths: [...promptLengths].sort((a, b) => a - b), generation_length: generationNumber, batch_sizes: [...batchSizes].sort((a, b) => a - b), repetitions: repetitionsNumber, warmup: true };
    const createdAt = Date.now();
    setRunTarget(snapshot);
    activeRef.current = true;
    cancelRequestedRef.current = false;
    rowsRef.current = [];
    setPhase("running"); setProgress(null); setRows([]); setResult(null); setRecord(null); setSelectedHistory(""); setError(null); setCopied(false); setStorageError(false); setExportNotice(null); setHistoryNotice(null);
    registerTask({ id: TASK_ID, kind: "benchmark", label: copy.title, phase: copy.starting, received: 0, total, interruptible: true, cancel });
    let unlisten: (() => void) | undefined;
    let finalResult: api.PerformanceBenchmarkResult;
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
        finalResult = { run_id: runId, rows: [], status: "cancelled", args: [], runtime_version: "", context_size: 0, parallel: 0 };
      } else {
        finalResult = await api.runPerformanceBench(cfg, request);
        if (!finalResult.rows.length && rowsRef.current.length) finalResult = { ...finalResult, rows: rowsRef.current };
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      finalResult = { run_id: runId, rows: rowsRef.current, status: cancelRequestedRef.current ? "cancelled" : "failed", message, args: [], runtime_version: "", context_size: 0, parallel: 0 };
    } finally {
      unlisten?.();
      void store.refreshStatus();
    }
    finalResult = withoutCancelledTrials(finalResult);
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 1, id: runId, createdAt, model: cfg.active_model, backend: cfg.active_backend, build: cfg.active_build, request, result: finalResult };
    const emptyCancellation = finalResult.status === 'cancelled' && !finalResult.rows.length;
    setRows(finalResult.rows); setResult(emptyCancellation ? null : finalResult); setRecord(emptyCancellation ? null : saved);
    historyRevisionRef.current++;
    setHistoryLoading(false);
    try {
      const page = emptyCancellation ? await loadBenchmarkHistoryPage() : await rememberBenchmarkResult(saved);
      setHistory(page.records); setHistoryOffset(page.next_offset);
    } catch { if (emptyCancellation) setHistoryError(true); else setStorageError(true); }
    activeRef.current = false;
    setPhase("idle");
    if (finalResult.status === "failed") setError(finalResult.message ?? copy.failed);
    finishTask(TASK_ID, finalResult.status === "cancelled" ? "cancelled" : finalResult.status === "failed" || finalResult.status === "partial" ? "failed" : "completed", finalResult.message ?? undefined);
  };

  const toggle = (value: number, current: number[], update: (values: number[]) => void) => update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const statusLabel = visibleResult ? ({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[visibleResult.status]) : null;
  const progressMessage = phase === "cancelling" ? copy.cancelling : progressLabel(progress?.phase, copy);
  const copyResults = async () => {
    if (!selectedRecord) return;
    try { await navigator.clipboard.writeText(performanceMarkdown(selectedRecord, locale)); setCopied(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
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
      setCopied(false); setError(null); setExportNotice(null);
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

  const modelLabel = displayedModel.model ? modelDisplayName(displayedModel.model) : copy.noModel;
  return <div className="app-page-scroll performance-page">
    <header className="app-page-header performance-heading"><div><h2 className="app-page-title">{copy.title}</h2><p className="app-page-description">{copy.description}</p></div></header>
    <form className="app-card app-card--flush performance-card performance-setup" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <div className="performance-target">
        <div className="performance-target-identity"><span className="performance-target-label">{copy.model}</span>
          <strong className="performance-target-name" title={normalizeDisplayPath(displayedModel.model)}><ModelIcon model={displayedModel.model} /><span>{modelLabel}</span></strong>
        </div>
        {modelSettings && <div className="performance-target-actions">
          <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} data-icon="settings" onClick={() => editModel('model')}>{modelCopy.settings}</button>
          {targetDiffers && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy} onClick={() => { const current = store.getConfig?.() ?? store.cfg; if (current) setTargetApplication(benchmarkTarget(current).application); }}>{modelCopy.importDefault}</button>}
        </div>}
        <ModelBadges model={displayedModel.model} localPath={displayedModel.model} />
      </div>
      <div className="performance-setup-body">
        <div className="performance-setup-environment">
          {displayedTarget && <BenchmarkEnvironment config={displayedTarget.config} application={displayedTarget.application} device={device} runtimes={installedRuntimes} active={active} busy={busy || otherBenchmark} />}
        </div>
        <div className="performance-conditions"><fieldset disabled={busy} className="performance-fields">
          <legend className="performance-column-title">{copy.conditions}</legend>
          <div className="performance-input-grid">
            <label className="performance-field"><span>{copy.corpus}</span><CustomSelect ariaLabel={copy.corpus} value={corpus} disabled={busy} onChange={setCorpus} options={CORPORA.map(key => ({ value: key, label: copy[key] }))} /></label>
            <label className="performance-field"><span>{copy.generation}</span><input className="app-input" type="number" min={1} max={4096} step={1} value={generation} aria-invalid={!validGeneration} aria-describedby="performance-validation" onChange={(event) => setGeneration(event.target.value)} /></label>
            <label className="performance-field"><span>{copy.repetitions}</span><input className="app-input" type="number" min={1} max={10} step={1} value={repetitions} aria-invalid={!validRepetitions} aria-describedby="performance-validation" onChange={(event) => setRepetitions(event.target.value)} /></label>
          </div>
          <fieldset className="performance-choice-group"><legend>{copy.promptLengths}</legend><div className="performance-chips">{PROMPT_LENGTHS.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={promptLengths.includes(value)} onChange={() => toggle(value, promptLengths, setPromptLengths)} /><span>{value === 200000 ? "200K" : `${value / 1024}K`}</span></label>)}</div></fieldset>
          <fieldset className="performance-choice-group"><legend>{copy.batchSizes}</legend><div className="performance-chips"><span className="performance-baseline-chip">1×</span>{BATCH_SIZES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={batchSizes.includes(value)} onChange={() => toggle(value, batchSizes, setBatchSizes)} /><span>{value}×</span></label>)}</div></fieldset>
          <p className="performance-hint">{copy.batchHint} {copy.workloadNote}</p>
        </fieldset></div>
      </div>
      <div className="performance-run-bar">
        <div className="performance-run-status">
          {busy
            ? <section className="performance-progress" aria-label={copy.running}><div role="status" aria-live="polite"><strong>{progressMessage}</strong><span>{progress?.completed ?? 0} / {progress?.total ?? total}</span></div><ProgressBar label={copy.totalTests} value={(progress?.completed ?? 0) / Math.max(1, progress?.total ?? total) * 100} /></section>
            : <p className="performance-run-summary">{copy.totalTests}: <strong>{total}</strong></p>}
          <p id="performance-validation" className={valid ? "sr-only" : "performance-validation"}>{copy.validation}</p>
        </div>
        {busy ? <LocalTaskCancelButton taskId={TASK_ID} pending={phase === "cancelling"} className="app-button app-button--danger" disabled={phase === "cancelling"} onClick={() => void cancel()}>{phase === "cancelling" ? copy.cancelling : copy.cancel}</LocalTaskCancelButton> : <button type="submit" className="app-button app-button--primary" disabled={!canRun}>{copy.run}</button>}
      </div>
    </form>
    {setupGaps.length > 0 && !busy && <FeedbackBanner tone="warning" className="performance-notice"
      action={modelSettings ? { label: setupGaps.includes('runtime') ? runCopy.needRuntimeAction : runCopy.needModelAction, onClick: () => editModel(setupGaps.includes('runtime') ? 'runtime' : 'model') } : undefined}>
      {setupGaps.map(gap => runSetupGapMessage(gap, locale)).join(' ')}
    </FeedbackBanner>}
    {serverRunning && !busy && <FeedbackBanner tone="warning" className="performance-notice" action={{ label: copy.stopServer, disabled: store.busy, onClick: () => void store.stop().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))) }}>{copy.stopHint}</FeedbackBanner>}
    {blockingSessions.length > 0 && !busy && <FeedbackBanner tone="warning" className="performance-notice" action={{ label: modelCopy.stopSessions, disabled: stoppingSessions, onClick: () => void stopSessions() }}>{`${modelCopy.sessionsHint} ${blockingSessions.map(session => normalizeDisplayText(session.name || session.id)).join(', ')}`}</FeedbackBanner>}
    {sessionsError && <FeedbackBanner tone="error" className="performance-notice" action={{ label: modelCopy.retry, onClick: () => void refreshSessions().catch(() => undefined) }}>{modelCopy.sessionsError}</FeedbackBanner>}
    {otherBenchmark && <FeedbackBanner tone="warning" className="performance-notice">{copy.activeElsewhere}</FeedbackBanner>}
    {error && <FeedbackBanner tone="error" className="performance-notice performance-error">{normalizeDisplayText(error)}</FeedbackBanner>}
    {storageError && !selectedHistory && <FeedbackBanner tone="warning" className="performance-notice">{copy.storageError}</FeedbackBanner>}
    {historyError && <FeedbackBanner tone="error" className="performance-notice" action={{ label: modelCopy.retry, disabled: busy || historyLoading || deleting, onClick: () => void loadHistory() }}>{copy.historyError}</FeedbackBanner>}
    {historyWarnings && <FeedbackBanner tone="warning" className="performance-notice">{copy.historyWarning}</FeedbackBanner>}
    {(history.length > 0 || record) && <p className="performance-hint">{copy.localHistoryHint}</p>}
    {(history.length > 0 || rows.length > 0 || record) && <div className="performance-history-bar">
      {previousRecords.length > 0 ? <label><span>{copy.history}</span><CustomSelect ariaLabel={copy.history} value={selectedHistory} disabled={busy || exporting || deleting}
        onChange={value => { setSelectedHistory(value); setCopied(false); setError(null); setExportNotice(null); setHistoryNotice(null); }}
        options={[{ value: '', label: copy.current }, ...previousRecords.map(item => ({ value: item.id,
          label: `${new Date(item.createdAt).toLocaleString()} · ${modelDisplayName(item.model)} · ${({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed })[item.result.status]}`,
          icon: <ModelIcon model={item.model} /> }))]} /></label> : <span>{copy.current}</span>}
      <div>{selectedRecord && <>
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={deleting} data-icon="copy" onClick={() => void copyResults()}>{copied ? copy.copied : copy.copy}</button>
      </>}<CustomSelect className="performance-export-format" ariaLabel={copy.exportFormat} value={exportFormat} disabled={busy || exporting || deleting}
        onChange={value => { setExportFormat(value); setExportNotice(null); }} options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }]} />
      {selectedRecord && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || exporting || deleting} data-icon="download" onClick={() => void exportResults(false)}>{copy.exportFile}</button>}
      {(exportAllDiffers || historyOffset !== null) && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || exporting || deleting} data-icon="download" onClick={() => void exportResults(true)}>{copy.exportAllCsv}</button>}
      {selectedRecord && <button type="button" className="app-button app-button--danger app-button--sm" disabled={busy || otherBenchmark || exporting || historyLoading || deleting || sharingBusy} data-icon="delete" onClick={() => { setDeleteError(false); setHistoryNotice(null); setPendingDelete(selectedRecord); }}>{deleting ? copy.deleting : copy.deleteHistory}</button>}</div>
    </div>}
    {exportNotice && <FeedbackBanner tone="success" className="performance-notice">{exportNotice}</FeedbackBanner>}
    {historyNotice && <FeedbackBanner tone="success" className="performance-notice">{historyNotice}</FeedbackBanner>}
    {historyOffset !== null && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || historyLoading || deleting} data-icon="refresh" onClick={() => void loadHistory(true)}>{copy.loadMore}</button>}
    {historyLoading && <p role="status">{copy.historyLoading}</p>}
    {selectedRecord && <div className="performance-result-context"><strong><ModelIcon model={selectedRecord.model} />{modelDisplayName(selectedRecord.model)}<ModelBadges model={selectedRecord.model} /></strong><span>{statusLabel} · {selectedRecord.backend} · {formatRecordedRuntimeVersion(selectedRecord.result.runtime_version, runtimeVersionLabel(installedRuntimes, selectedRecord.backend, selectedRecord.build))} · {copy[selectedRecord.request.context_profile]}</span><span>{selectedRecord.localState === 'cached' ? copy.localCached : copy.localRecovery}</span>{visibleResult?.message && <p>{normalizeDisplayText(visibleResult.message)}</p>}</div>}
    <ResultTable rows={singleRows} batch={false} copy={copy} /><ResultTable rows={batchRows} batch copy={copy} />
    {selectedRecord && <PublicBenchmarkReview key={selectedRecord.id} record={selectedRecord} busy={busy || otherBenchmark || deleting || !!pendingDelete} copy={copy} onWorkingChange={setSharingBusy} onPublished={() => setSharingRevision(value => value + 1)} />}
    <BenchmarkOwnedList busy={busy || otherBenchmark} copy={copy} revision={sharingRevision} />
    {!visibleRows.length && !visibleResult && !busy && !error && <EmptyState title={copy.emptyTitle} description={copy.empty} />}
    {selectedRecord && <details className="app-card app-card--flush performance-card performance-details" open><summary>{copy.details}</summary><dl className="performance-run-config">
      <div><dt>{copy.corpus}</dt><dd>{copy[selectedRecord.request.context_profile]}</dd></div>
      <div><dt>{copy.promptLengths}</dt><dd>{selectedRecord.request.prompt_lengths.map((value) => value.toLocaleString()).join(" / ")}</dd></div>
      <div><dt>{copy.generation}</dt><dd>{selectedRecord.request.generation_length.toLocaleString()}</dd></div>
      <div><dt>{copy.batchSizes}</dt><dd>{[1, ...selectedRecord.request.batch_sizes].map((value) => `${value}×`).join(" / ")}</dd></div>
      <div><dt>{copy.repetitions}</dt><dd>{selectedRecord.request.repetitions}</dd></div>
      <div><dt>{copy.warmup}</dt><dd>{selectedRecord.request.warmup ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.contextSize}</dt><dd>{selectedRecord.result.context_size > 0 ? selectedRecord.result.context_size.toLocaleString() : copy.unavailable}</dd></div>
      <div><dt>{copy.parallel}</dt><dd>{selectedRecord.result.parallel > 0 ? selectedRecord.result.parallel : copy.unavailable}</dd></div>
      <div><dt>{copy.runtimeVersion}</dt><dd>{formatRecordedRuntimeVersion(selectedRecord.result.runtime_version, copy.unavailable)}</dd></div>
      <div><dt>{copy.executionDevice}</dt><dd>{provenance?.environment?.execution?.mode === 'cpu' ? 'CPU' : selectedGpuLabel || copy.unavailable}</dd></div>
      <div><dt>{copy.processor}</dt><dd>{provenance?.environment?.cpu ? `${normalizeDisplayText(provenance.environment.cpu.name)} · ${formatCpuCores(provenance.environment.cpu)}` : copy.unavailable}</dd></div>
      <div><dt>{copy.systemMemory}</dt><dd>{typeof provenance?.environment?.system_memory_bytes === 'number' ? formatBytes(provenance.environment.system_memory_bytes) : copy.unavailable}</dd></div>
      <div><dt>{copy.modelHash}</dt><dd>{typeof modelHash === 'string' ? modelHash : copy.unavailable}</dd></div>
    </dl></details>}
    {visibleResult && visibleResult.args.length > 0 && <details className="app-card app-card--flush performance-card performance-details" open><summary>{copy.effectiveArgs}</summary><code>{argumentLines(visibleResult.args).join("\n")}</code></details>}
    <details className="app-card app-card--flush performance-card performance-details" open><summary>{copy.metrics}</summary><dl className="performance-metric-guide">
      <div><dt>{copy.ttft}</dt><dd>{copy.ttftHint}</dd></div>
      <div><dt>{copy.tpot}</dt><dd>{copy.tpotHint}</dd></div>
      <div><dt>{copy.pp}</dt><dd>{copy.ppHint}</dd></div>
      <div><dt>{copy.tg}</dt><dd>{copy.tgHint}</dd></div>
      <div><dt>{copy.throughput}</dt><dd>{copy.throughputHint}</dd></div>
      <div><dt>{copy.memory}</dt><dd>{copy.memoryHint}</dd></div>
      <div><dt>{copy.speedup}</dt><dd>{copy.speedupHint}</dd></div>
    </dl><p>{copy.metricsHint}</p></details>
    <ConfirmDialog open={!!pendingDelete} title={copy.deleteTitle} confirmLabel={copy.deleteHistory} busy={deleting}
      confirmDisabled={busy || otherBenchmark || exporting || sharingBusy || historyLoading}
      description={<>{pendingDelete && <p><strong>{modelDisplayName(pendingDelete.model)}</strong> · {new Date(pendingDelete.createdAt).toLocaleString()}</p>}<p>{copy.deleteHint}</p>{deleteError && <FeedbackBanner tone="error">{copy.deleteError}</FeedbackBanner>}</>}
      onConfirm={() => void deleteSelectedHistory()} onCancel={() => { if (!deleting) setPendingDelete(null); }} />
  </div>;
}
