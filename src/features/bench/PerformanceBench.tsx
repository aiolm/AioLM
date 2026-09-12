import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { finishTask, registerTask, updateTask, useTasks } from "../../shared/state/taskRegistry";
import { useI18n } from "../../shared/i18n/i18n";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { performanceCsv, readPerformanceHistory, savePerformanceRecord, summarizePerformanceRows, type BenchmarkDevice, type PerformanceBenchmarkRecord } from "./performanceRecords";
import { benchmarkCopy } from "./benchmarkCopy";
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { executionConfig, executionSettings, type ExecutionSettings } from '../../shared/config/executionSettings';
import { modelActions } from '../../shared/i18n/modelActions';

const PROMPT_LENGTHS = [1024, 4096, 8192, 16384, 32768, 65536, 131072, 200000];
const BATCH_SIZES = [2, 4, 8];
const CORPORA = ["code_python", "code_mixed", "novel_ko", "novel_en", "novel_ja"] as const;
const TASK_ID = "performance-benchmark-active";
type Copy = ReturnType<typeof benchmarkCopy>;
type Summary = ReturnType<typeof summarizePerformanceRows>[number];

function deviceSnapshot(report: api.DeviceReport | null): BenchmarkDevice | undefined {
  if (!report) return undefined;
  const gpu = report.profile.gpus.find((item) => !item.integrated) ?? report.profile.gpus[0];
  return { fingerprint: report.profile.fingerprint, os: report.profile.os, arch: report.profile.arch, cpu: report.profile.cpu.name, cpuThreads: report.profile.cpu.logical_cores, gpu: gpu?.name, gpuVendor: gpu?.vendor, gpuVramMb: gpu?.vram_mb };
}

function downloadCsv(text: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", text], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "aiolm-benchmarks.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function numberLabel(value: number | null | undefined, copy: Copy, digits = 1): string {
  return value == null || !Number.isFinite(value) ? copy.unavailable : value.toFixed(digits);
}

function progressLabel(phase: api.PerformanceBenchmarkProgress["phase"] | undefined, copy: Copy): string {
  switch (phase) {
    case "warmup": return copy.warming;
    case "single": return copy.measuringSingle;
    case "batch": return copy.measuringBatch;
    case "cleanup": return copy.cleanup;
    default: return copy.starting;
  }
}

function ResultTable({ rows, batch, copy }: { rows: Summary[]; batch: boolean; copy: Copy }) {
  if (!rows.length) return null;
  return <section className="performance-card performance-results" aria-labelledby={batch ? "perf-batch-title" : "perf-single-title"}>
    <div className="performance-card-heading"><h3 id={batch ? "perf-batch-title" : "perf-single-title"}>{batch ? copy.batch : copy.single}</h3><span>{rows.length}</span></div>
    <div className="performance-table-scroll" role="region" aria-label={batch ? copy.batch : copy.single} tabIndex={0}>
      <table>
        <caption className="sr-only">{batch ? copy.batch : copy.single}</caption>
        <thead><tr>
          <th scope="col">{copy.test}</th>{batch && <th scope="col">{copy.concurrency}</th>}<th scope="col">{copy.repeat}</th>
          <th scope="col">{copy.ttft}<small>{copy.milliseconds}</small></th><th scope="col">{copy.tpot}<small>{copy.milliseconds}</small></th>
          <th scope="col" title={copy.ppHint}>{copy.pp}<small>{copy.tokens}</small></th><th scope="col">{copy.tg}<small>{copy.tokens}</small></th>
          {batch && <th scope="col">{copy.speedup}</th>}<th scope="col">{copy.e2e}<small>{copy.seconds}</small></th><th scope="col" title={copy.throughputHint}>{copy.throughput}<small>{copy.tokens}</small></th><th scope="col" title={copy.memoryHint}>{copy.memory}<small>MiB</small></th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <th scope="row">{row.prompt_tokens.toLocaleString()} / {row.generation_length.toLocaleString()}{row.error && <span className="performance-row-error">{normalizeDisplayText(row.error)}</span>}</th>
          {batch && <td>{row.concurrency}×</td>}<td>{row.samples}</td>
          <td>{numberLabel(row.ttft_ms, copy)}</td><td>{numberLabel(row.tpot_ms, copy, 2)}</td><td>{numberLabel(row.pp_tps, copy)}</td>
          <td className="performance-metric-primary">{numberLabel(row.tg_tps, copy)}{row.samples > 1 && row.tg_stddev != null && <small>± {numberLabel(row.tg_stddev, copy)}</small>}</td>
          {batch && <td>{row.speedup == null ? copy.unavailable : `${row.speedup.toFixed(2)}×`}</td>}
          <td>{row.error ? copy.unavailable : numberLabel(row.e2e_ms / 1000, copy, 2)}</td><td>{numberLabel(row.total_tps, copy)}</td><td>{numberLabel(row.peak_memory_bytes == null ? null : row.peak_memory_bytes / 1048576, copy)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </section>;
}

export default function PerformanceBench({ store }: { store: AppStore }) {
  const { locale } = useI18n();
  const copy = benchmarkCopy(locale);
  const modelCopy = modelActions(locale);
  const modelSettings = useModelSettings();
  const [targetSettings, setTargetSettings] = useState<ExecutionSettings | null>(() => store.cfg ? executionSettings(store.cfg) : null);
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsError, setSessionsError] = useState(false);
  const [sessionsReady, setSessionsReady] = useState(false);
  const [sessionRevision, setSessionRevision] = useState(0);
  const [stoppingSessions, setStoppingSessions] = useState(false);
  const [promptLengths, setPromptLengths] = useState([4096, 16384]);
  const [batchSizes, setBatchSizes] = useState([2, 4]);
  const [generation, setGeneration] = useState("128");
  const [repetitions, setRepetitions] = useState("1");
  const [corpus, setCorpus] = useState<(typeof CORPORA)[number]>("code_python");
  const [warmup, setWarmup] = useState(true);
  const [phase, setPhase] = useState<"idle" | "running" | "cancelling">("idle");
  const [progress, setProgress] = useState<api.PerformanceBenchmarkProgress | null>(null);
  const [rows, setRows] = useState<api.PerformanceBenchmarkRow[]>([]);
  const [result, setResult] = useState<api.PerformanceBenchmarkResult | null>(null);
  const [record, setRecord] = useState<PerformanceBenchmarkRecord | null>(null);
  const [history, setHistory] = useState(readPerformanceHistory);
  const [selectedHistory, setSelectedHistory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [runModel, setRunModel] = useState<{ model: string; backend: string; build: string } | null>(null);
  const rowsRef = useRef<api.PerformanceBenchmarkRow[]>([]);
  const activeRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const tasks = useTasks();
  const busy = phase !== "idle";
  const otherBenchmark = tasks.some((task) => task.kind === "benchmark" && task.id !== TASK_ID && (task.state === "running" || task.state === "cancelling"));
  const generationNumber = Number(generation);
  const repetitionsNumber = Number(repetitions);
  const validGeneration = Number.isInteger(generationNumber) && generationNumber >= 1 && generationNumber <= 4096;
  const validRepetitions = Number.isInteger(repetitionsNumber) && repetitionsNumber >= 1 && repetitionsNumber <= 10;
  const valid = promptLengths.length > 0 && validGeneration && validRepetitions;
  const serverRunning = isServerRunning(store.status.state);
  const targetConfig = store.cfg ? executionConfig(store.cfg, targetSettings ?? executionSettings(store.cfg)) : null;
  const model = targetConfig?.active_model ?? "";
  const displayedModel = busy && runModel ? runModel : { model, backend: targetConfig?.active_backend ?? "", build: targetConfig?.active_build ?? "" };
  const blockingSessions = sessions.filter(session => session.id !== 'default' && ['running', 'starting', 'stopping'].includes(session.state));
  const canRun = !!targetConfig && !!model && valid && !busy && !serverRunning && !store.busy && !otherBenchmark && !sessionsError && (!modelSettings || sessionsReady) && !blockingSessions.length && !stoppingSessions;
  const total = promptLengths.length * (batchSizes.length + 1) * (validRepetitions ? repetitionsNumber : 0);
  const selectedRecord = selectedHistory ? history.find((item) => item.id === selectedHistory) ?? null : record;
  const visibleRows = selectedHistory && selectedRecord ? selectedRecord.result.rows : rows;
  const visibleResult = selectedHistory && selectedRecord ? selectedRecord.result : result;
  const summary = useMemo(() => summarizePerformanceRows(visibleRows), [visibleRows]);
  const singleRows = summary.filter((row) => row.concurrency === 1);
  const batchRows = summary.filter((row) => row.concurrency > 1);

  useEffect(() => {
    if (!targetSettings && store.cfg) setTargetSettings(executionSettings(store.cfg));
  }, [store.cfg, targetSettings]);
  const hasSettings = !!modelSettings;
  useEffect(() => {
    if (!hasSettings) return;
    let disposed = false;
    const refresh = () => { void api.sessionList().then(value => { if (!disposed) { setSessions(api.normalizeSessionList(value)); setSessionsError(false); setSessionsReady(true); } }).catch(() => { if (!disposed) { setSessionsError(true); setSessionsReady(false); } }); };
    refresh(); const timer = window.setInterval(refresh, 2000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [hasSettings, sessionRevision]);
  const editModel = (section: string) => {
    if (busy || !targetConfig) return;
    modelSettings?.open({ target: { kind: 'benchmark', id: TASK_ID }, config: targetConfig, section, onApply: cfg => { setTargetSettings(executionSettings(cfg)); } });
  };
  const stopSessions = async () => {
    if (stoppingSessions) return;
    setStoppingSessions(true);
    try { for (const session of blockingSessions) await api.sessionStop(session.id); setSessionRevision(value => value + 1); }
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
    const cfg = structuredClone(targetConfig!);
    const runId = `performance-${crypto.randomUUID()}`;
    const request: api.PerformanceBenchmarkRequest = { run_id: runId, context_profile: corpus, prompt_lengths: [...promptLengths].sort((a, b) => a - b), generation_length: generationNumber, batch_sizes: [...batchSizes].sort((a, b) => a - b), repetitions: repetitionsNumber, warmup };
    const createdAt = Date.now();
    setRunModel({ model: cfg.active_model, backend: cfg.active_backend, build: cfg.active_build });
    activeRef.current = true;
    cancelRequestedRef.current = false;
    rowsRef.current = [];
    setPhase("running"); setProgress(null); setRows([]); setResult(null); setRecord(null); setSelectedHistory(""); setError(null); setCopied(false); setStorageError(false);
    registerTask({ id: TASK_ID, kind: "benchmark", label: copy.title, phase: copy.starting, received: 0, total, interruptible: true, cancel });
    let unlisten: (() => void) | undefined;
    let finalResult: api.PerformanceBenchmarkResult;
    try {
      unlisten = await api.onPerformanceBenchmarkProgress((event) => {
        if (event.run_id !== runId || !activeRef.current) return;
        setProgress(event);
        const row = event.row;
        if (row) {
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
      activeRef.current = false;
      setPhase("idle");
      void store.refreshStatus();
    }
    const saved: PerformanceBenchmarkRecord = { schemaVersion: 1, id: runId, createdAt, model: cfg.active_model, backend: cfg.active_backend, build: cfg.active_build, request, result: finalResult, device: deviceSnapshot(device) };
    setRows(finalResult.rows); setResult(finalResult); setRecord(saved);
    try { setHistory(savePerformanceRecord(saved)); }
    catch { setStorageError(true); }
    if (finalResult.status === "failed") setError(finalResult.message ?? copy.failed);
    finishTask(TASK_ID, finalResult.status === "cancelled" ? "cancelled" : finalResult.status === "failed" || finalResult.status === "partial" ? "failed" : "completed", finalResult.message ?? undefined);
  };

  const toggle = (value: number, current: number[], update: (values: number[]) => void) => update(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
  const statusLabel = visibleResult ? ({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed }[visibleResult.status]) : null;
  const progressMessage = phase === "cancelling" ? copy.cancelling : progressLabel(progress?.phase, copy);
  const copyResults = async () => {
    if (!selectedRecord) return;
    try { await navigator.clipboard.writeText(performanceCsv([selectedRecord])); setCopied(true); }
    catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };

  return <div className="app-page-scroll performance-page">
    <header className="performance-heading"><div><h2>{copy.title}</h2><p>{copy.description}</p></div>{device && <span className="performance-device">{device.profile.cpu.name}{device.profile.gpus[0] ? ` · ${device.profile.gpus[0].name}` : ""}</span>}</header>
    <form className="performance-card" onSubmit={(event) => { event.preventDefault(); void run(); }}>
      <div className="performance-card-heading"><h3>{copy.configuration}</h3><span>{copy.totalTests}: <strong>{total}</strong></span></div>
      <div className="performance-model"><span>{copy.model}</span><strong title={normalizeDisplayPath(displayedModel.model)}>{displayedModel.model ? modelDisplayName(displayedModel.model) : copy.noModel}</strong>{displayedModel.model && <small>{displayedModel.backend} · {displayedModel.build}</small>}{modelSettings && <div className="performance-model-actions"><button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={() => editModel('model')}>{modelCopy.choose}</button><button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={() => editModel('runtime')}>{modelCopy.settings}</button><button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || !store.cfg} onClick={() => { if (store.cfg) setTargetSettings(executionSettings(store.cfg)); }}>{modelCopy.importDefault}</button></div>}</div>
      <fieldset disabled={busy} className="performance-fields">
        <legend className="sr-only">{copy.configuration}</legend>
        <div className="performance-input-grid">
          <label className="performance-field"><span>{copy.corpus}</span><select className="app-input" value={corpus} onChange={(event) => setCorpus(event.target.value as typeof corpus)}>{CORPORA.map((key) => <option key={key} value={key}>{copy[key]}</option>)}</select></label>
          <label className="performance-field"><span>{copy.generation}</span><input className="app-input" type="number" min={1} max={4096} step={1} value={generation} aria-invalid={!validGeneration} aria-describedby="performance-validation" onChange={(event) => setGeneration(event.target.value)} /></label>
          <label className="performance-field"><span>{copy.repetitions}</span><input className="app-input" type="number" min={1} max={10} step={1} value={repetitions} aria-invalid={!validRepetitions} aria-describedby="performance-validation" onChange={(event) => setRepetitions(event.target.value)} /></label>
        </div>
        <fieldset className="performance-choice-group"><legend>{copy.promptLengths}</legend><div className="performance-chips">{PROMPT_LENGTHS.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={promptLengths.includes(value)} onChange={() => toggle(value, promptLengths, setPromptLengths)} /><span>{value === 200000 ? "200K" : `${value / 1024}K`}</span></label>)}</div></fieldset>
        <div className="performance-lower-fields"><fieldset className="performance-choice-group"><legend>{copy.batchSizes}</legend><div className="performance-chips"><span className="performance-baseline-chip">1×</span>{BATCH_SIZES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={batchSizes.includes(value)} onChange={() => toggle(value, batchSizes, setBatchSizes)} /><span>{value}×</span></label>)}</div></fieldset><label className="performance-warmup"><input type="checkbox" checked={warmup} onChange={(event) => setWarmup(event.target.checked)} /><span>{copy.warmup}<small>{copy.warmupHint}</small></span></label></div>
        <p className="performance-hint">{copy.batchHint}</p>
      </fieldset>
      <div className="performance-actions">{busy ? <button type="button" className="app-button app-button--danger app-button--md" disabled={phase === "cancelling"} onClick={() => void cancel()}>{phase === "cancelling" ? copy.cancelling : copy.cancel}</button> : <button type="submit" className="app-button app-button--primary app-button--md" disabled={!canRun}>{copy.run}</button>}<span>{busy ? progressMessage : statusLabel ?? copy.idle}</span></div>
      <p id="performance-validation" className={valid ? "sr-only" : "performance-validation"}>{copy.validation}</p>
    </form>
    {serverRunning && !busy && <div className="performance-notice" role="status"><p>{copy.stopHint}</p><button type="button" className="app-button app-button--secondary app-button--sm" disabled={store.busy} onClick={() => void store.stop().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))}>{copy.stopServer}</button></div>}
    {blockingSessions.length > 0 && !busy && <div className="performance-notice" role="status"><p>{modelCopy.sessionsHint} {blockingSessions.map(session => normalizeDisplayText(session.name || session.id)).join(', ')}</p><button type="button" className="app-button app-button--secondary app-button--sm" disabled={stoppingSessions} onClick={() => void stopSessions()}>{modelCopy.stopSessions}</button></div>}
    {sessionsError && <div className="performance-notice" role="alert">{modelCopy.sessionsError}<button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => setSessionRevision(value => value + 1)}>{modelCopy.retry}</button></div>}
    {otherBenchmark && <p className="performance-notice" role="status">{copy.activeElsewhere}</p>}
    {busy && <section className="performance-progress performance-card" aria-label={copy.running}><div role="status" aria-live="polite"><strong>{progressMessage}</strong><span>{progress?.completed ?? 0} / {progress?.total ?? total}</span></div><progress max={Math.max(1, progress?.total ?? total)} value={progress?.completed ?? 0} aria-label={copy.totalTests} /></section>}
    {error && <div className="performance-error" role="alert">{normalizeDisplayText(error)}</div>}
    {storageError && !selectedHistory && <div className="performance-notice" role="status">{copy.storageError}</div>}
    {(history.length > 0 || rows.length > 0 || record) && <div className="performance-history-bar">
      <label><span>{copy.history}</span><select className="app-input" value={selectedHistory} disabled={busy} onChange={(event) => { setSelectedHistory(event.target.value); setCopied(false); setError(null); }}>
        <option value="">{copy.current}</option>{history.map((item) => <option key={item.id} value={item.id}>{new Date(item.createdAt).toLocaleString()} · {modelDisplayName(item.model)} · {({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed })[item.result.status]}</option>)}
      </select></label>
      <div>{selectedRecord && <>
        <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => void copyResults()}>{copied ? copy.copied : copy.copy}</button>
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={() => downloadCsv(performanceCsv([selectedRecord]))}>{copy.exportCsv}</button>
      </>}{history.length > 0 && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} onClick={() => downloadCsv(performanceCsv(history))}>{copy.exportAllCsv}</button>}</div>
    </div>}
    {selectedRecord && <div className="performance-result-context"><strong>{modelDisplayName(selectedRecord.model)}</strong><span>{statusLabel} · {selectedRecord.backend} · {selectedRecord.build} · {copy[selectedRecord.request.context_profile]}</span>{visibleResult?.message && <p>{normalizeDisplayText(visibleResult.message)}</p>}</div>}
    <ResultTable rows={singleRows} batch={false} copy={copy} /><ResultTable rows={batchRows} batch copy={copy} />
    {!visibleRows.length && !visibleResult && !busy && !error && <div className="performance-empty">{copy.empty}</div>}
    {selectedRecord && <details className="performance-card performance-details"><summary>{copy.details}</summary><dl className="performance-run-config">
      <div><dt>{copy.corpus}</dt><dd>{copy[selectedRecord.request.context_profile]}</dd></div>
      <div><dt>{copy.promptLengths}</dt><dd>{selectedRecord.request.prompt_lengths.map((value) => value.toLocaleString()).join(" / ")}</dd></div>
      <div><dt>{copy.generation}</dt><dd>{selectedRecord.request.generation_length.toLocaleString()}</dd></div>
      <div><dt>{copy.batchSizes}</dt><dd>{[1, ...selectedRecord.request.batch_sizes].map((value) => `${value}×`).join(" / ")}</dd></div>
      <div><dt>{copy.repetitions}</dt><dd>{selectedRecord.request.repetitions}</dd></div>
      <div><dt>{copy.warmup}</dt><dd>{selectedRecord.request.warmup ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.contextSize}</dt><dd>{selectedRecord.result.context_size > 0 ? selectedRecord.result.context_size.toLocaleString() : copy.unavailable}</dd></div>
      <div><dt>{copy.parallel}</dt><dd>{selectedRecord.result.parallel > 0 ? selectedRecord.result.parallel : copy.unavailable}</dd></div>
      <div><dt>{copy.runtimeVersion}</dt><dd>{selectedRecord.result.runtime_version || copy.unavailable}</dd></div>
    </dl></details>}
    {visibleResult && visibleResult.args.length > 0 && <details className="performance-card performance-details"><summary>{copy.effectiveArgs}</summary><code>{visibleResult.args.map((arg) => JSON.stringify(normalizeDisplayText(arg))).join(" ")}</code></details>}
    <details className="performance-card performance-details"><summary>{copy.metrics}</summary><p>{copy.metricsHint}</p><p>{copy.ppHint}</p><p>{copy.throughputHint}</p><p>{copy.memoryHint}</p></details>
  </div>;
}
