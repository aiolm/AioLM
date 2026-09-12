import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { parseNumericInput } from "../../shared/config/tuningValidation";
import { useI18n } from "../../shared/i18n/i18n";
import { benchmarkCsv, benchmarkFingerprint, benchmarkMetrics, BENCHMARK_RECORD_SCHEMA, type BenchmarkDevice, type BenchmarkRecord } from "./benchmarkRecords";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { normalizeDisplayPath, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { finishTask, registerTask, updateTask } from "../../shared/state/taskRegistry";

const BENCH_HISTORY_KEY = "aiolm-benchmark-history.v1";

function readHistory(): BenchmarkRecord[] {
  try {
    const value = JSON.parse(localStorage.getItem(BENCH_HISTORY_KEY) ?? "[]") as unknown;
    // Records written before the versioned envelope lack the metric shape, so
    // they are dropped rather than rendered with undefined values.
    return Array.isArray(value)
      ? value.filter((item): item is BenchmarkRecord =>
          !!item && typeof item === "object" && (item as BenchmarkRecord).schemaVersion === BENCHMARK_RECORD_SCHEMA)
      : [];
  } catch { return []; }
}

function toBenchmarkDevice(report: api.DeviceReport | null): BenchmarkDevice | undefined {
  if (!report) return undefined;
  const gpu = report.profile.gpus.find((item) => !item.integrated) ?? report.profile.gpus[0];
  return {
    fingerprint: report.profile.fingerprint,
    os: report.profile.os,
    arch: report.profile.arch,
    cpu: report.profile.cpu.name,
    cpuThreads: report.profile.cpu.logical_cores,
    gpu: gpu?.name,
    gpuVendor: gpu?.vendor,
    gpuVramMb: gpu?.vram_mb,
  };
}

function downloadText(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = name; anchor.click(); URL.revokeObjectURL(url);
}

function benchmarkStatusLabel(status: api.BenchmarkRunState, t: ReturnType<typeof useI18n>["t"]): string {
  if (status === "cancelled") return t("ui.benchStateCancelled");
  if (status === "crashed" || status === "partial") return t("ui.benchStateCrashed");
  if (status === "failed") return t("ui.benchStateFailed");
  if (status === "running") return t("ui.benchStreaming");
  return t("ui.benchStateCompleted");
}

export default function BenchPanel({ store }: { store: AppStore }) {
  const { t } = useI18n();
  const cfg = store.cfg;
  const configuredIters = cfg?.iters;
  const [phase, setPhase] = useState<"idle" | "running" | "canceling">("idle");
  const [rows, setRows] = useState<api.BenchRow[]>([]);
  const [effectiveArgs, setEffectiveArgs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [itersDraft, setItersDraft] = useState(String(cfg?.iters ?? 5));
  const [itersDirty, setItersDirty] = useState(false);
  const [history, setHistory] = useState<BenchmarkRecord[]>(readHistory);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [runStatus, setRunStatus] = useState<api.BenchmarkRunState | null>(null);
  const rowsRef = useRef<api.BenchRow[]>([]);
  const runCfgRef = useRef<api.AppConfig | null>(null);
  const cancelRequestedRef = useRef(false);
  const runActiveRef = useRef(false);

  useEffect(() => {
    void api.deviceProfile().then(setDevice).catch(() => setDevice(null));
  }, []);

  useEffect(() => {
    if (configuredIters !== undefined && !itersDirty) setItersDraft(String(configuredIters));
  }, [configuredIters, itersDirty]);

  useEffect(() => {
    if (typeof api.onBenchmarkProgress !== "function") return undefined;
    let mounted = true;
    let unlisten: (() => void) | null = null;
    void api.onBenchmarkProgress((progress) => {
      if (!mounted || !runActiveRef.current) return;
      const duplicate = rowsRef.current.some((row) => row.test === progress.row.test && row.size === progress.row.size && row.batch === progress.row.batch && row.tps === progress.row.tps);
      if (!duplicate) {
        rowsRef.current = [...rowsRef.current, progress.row];
        setRows(rowsRef.current);
      }
      updateTask("benchmark-active", { phase: t("ui.benchStreaming"), received: rowsRef.current.length });
    }).then((nextUnlisten) => {
      if (mounted) unlisten = nextUnlisten;
      else nextUnlisten();
    }).catch(() => {
      // Browser preview and older desktop builds do not expose benchmark events.
    });
    return () => { mounted = false; unlisten?.(); };
  }, [t]);

  const serverRunning = isServerRunning(store.status.state);
  const model = cfg?.active_model ?? "";
  const displayModel = normalizeDisplayPath(model);
  const canRun = !!cfg && !!model && phase === "idle" && !serverRunning && !store.busy;

  const saveRecord = (runCfg: api.AppConfig, resultRows: api.BenchRow[], status: BenchmarkRecord["status"], message?: string | null) => {
    const record: BenchmarkRecord = {
      schemaVersion: BENCHMARK_RECORD_SCHEMA,
      id: `bench-${Date.now().toString(36)}`,
      device: toBenchmarkDevice(device),
      runtimeDefaults: [...(runCfg.runtime_defaults ?? [])],
      fingerprint: benchmarkFingerprint({ model: runCfg.active_model, backend: runCfg.active_backend, build: runCfg.active_build, ctx: runCfg.ctx_size, ngl: runCfg.ngl, threads: runCfg.threads, parallel: runCfg.parallel, iters: runCfg.iters, runtimeDefaults: runCfg.runtime_defaults }),
      createdAt: Date.now(), model: runCfg.active_model, backend: runCfg.active_backend, build: runCfg.active_build, ctx: runCfg.ctx_size, ngl: runCfg.ngl, threads: runCfg.threads, parallel: runCfg.parallel, iters: runCfg.iters,
      rows: benchmarkMetrics(resultRows), status, error: message ?? undefined,
    };
    // Persist before touching component state: the benchmark promise may
    // finish after its panel was unmounted by a section/tab change.
    const current = readHistory();
    const next = [record, ...current].slice(0, 20);
    try { localStorage.setItem(BENCH_HISTORY_KEY, JSON.stringify(next)); } catch { /* optional */ }
    setHistory(next);
  };

  const run = async () => {
    if (!cfg) return;
    setError(null);
    setInfo(null);
    setRows([]);
    setEffectiveArgs([]);
    rowsRef.current = [];
    cancelRequestedRef.current = false;
    setRunStatus("running");
    setPhase("running");
    const taskId = registerTask({ id: "benchmark-active", kind: "benchmark", label: t("panel.benchmark"), phase: t("ui.benchStreaming"), received: 0, interruptible: false, cancel: api.benchCancel });
    try {
      const parsed = parseNumericInput(itersDraft, 1);
      const iters = Math.min(100, Math.max(1, parsed ?? cfg.iters));
      setItersDraft(String(iters));
      setItersDirty(false);
      const runCfg = { ...cfg, iters };
      runCfgRef.current = runCfg;
      runActiveRef.current = true;
      const result = await api.runBench(runCfg);
      const resultRows = result.rows?.length ? result.rows : rowsRef.current;
      setRows(resultRows);
      rowsRef.current = resultRows;
      setEffectiveArgs(result.args ?? []);
      const resultStatus = result.status ?? "complete";
      const displayStatus: BenchmarkRecord["status"] = resultStatus === "partial" ? "partial" : resultStatus === "cancelled" ? "cancelled" : "complete";
      setRunStatus(resultStatus);
      if (result.message) setInfo(result.message);
      saveRecord(runCfg, resultRows, displayStatus, result.message);
      finishTask(taskId, displayStatus === "cancelled" ? "cancelled" : displayStatus === "partial" ? "crashed" : "completed", result.message ?? undefined);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      const cancelled = cancelRequestedRef.current || message.toLowerCase().includes("cancel");
      const displayStatus: BenchmarkRecord["status"] = cancelled ? "cancelled" : "crashed";
      setRunStatus(cancelled ? "cancelled" : "crashed");
      if (cancelled) setInfo(t("ui.benchCancelled"));
      else setError(message);
      if (runCfgRef.current) saveRecord(runCfgRef.current, rowsRef.current, displayStatus, message);
      finishTask(taskId, cancelled ? "cancelled" : "crashed", message);
    } finally {
      runActiveRef.current = false;
      setPhase("idle");
      void store.refreshStatus();
    }
  };

  const cancel = async () => {
    if (phase !== "running") return;
    cancelRequestedRef.current = true;
    setPhase("canceling");
    updateTask("benchmark-active", { state: "cancelling", phase: t("ui.benchCancelRequested") });
    setInfo(t("ui.benchCancelRequested"));
    try {
      await api.benchCancel();
    } catch (caught) {
      setInfo(`${t("ui.benchCancelFailed")}: ${caught instanceof Error ? caught.message : String(caught)}`);
      setPhase("running");
    }
  };

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col p-4">
      <div className="rounded-xl border p-4 ui-border-color-border ui-background-panel" >
        <div className="flex min-w-0 flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="bench-iters" className="text-xs ui-color-muted" >{t("panel.iterations")}</label>
            <input
              id="bench-iters"
              type="text"
              inputMode="numeric"
              value={itersDraft}
              disabled={phase !== "idle"}
              aria-describedby="bench-iters-hint"
              onChange={(event) => {
                setItersDraft(event.target.value);
                setItersDirty(true);
              }}
              onBlur={() => {
                const parsed = parseNumericInput(itersDraft, 1);
                const normalized = Math.min(100, Math.max(1, parsed ?? cfg?.iters ?? 5));
                setItersDraft(String(normalized));
                setItersDirty(false);
              }}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              className="app-input w-24 text-center"
            />
            <span id="bench-iters-hint" className="sr-only">1 - 100</span>
          </div>
          {phase === "running" || phase === "canceling" ? (
            <button
              type="button"
              onClick={() => void cancel()}
              disabled={phase === "canceling"}
              className="bench-run-button app-button app-button--danger app-button--md"
            >
              <StableLabel value={phase === "canceling" ? t("panel.canceling") : t("panel.cancelBenchmark")} labels={[t("panel.benchmark"), t("panel.canceling"), t("panel.cancelBenchmark")]} />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run()}
              disabled={!canRun}
              title={serverRunning ? t("panel.serverRunningBenchmark") : !model ? t("panel.noModelBenchmark") : undefined}
              className="bench-run-button app-button app-button--primary app-button--md"
            >
              <StableLabel value={t("panel.benchmark")} labels={[t("panel.benchmark"), t("panel.canceling"), t("panel.cancelBenchmark")]} />
            </button>
          )}
          <span className="bench-model-label min-w-0 break-words text-xs tabular-nums ui-color-faint" >
            {model ? displayModel : t("panel.noModelBenchmark")}
          </span>
        </div>
        <div className="bench-phase-slot mt-3">
          {phase !== "idle" && (
            <div className="flex items-center gap-2 text-xs font-medium ui-color-warning"  role="status" aria-live="polite">
              <span className="h-1.5 w-1.5 animate-pulse rounded-full ui-background-warning"  aria-hidden="true" />
              {phase === "canceling" ? t("common.wait") : t("status.working")}
            </div>
          )}
          {phase === "idle" && runStatus && <div className={["mt-2 text-xs font-medium", (runStatus === "complete" ? "ui-color-success" : (runStatus === "cancelled" ? "ui-color-warning" : "ui-color-danger"))].filter(Boolean).join(" ")}  role="status" aria-live="polite">{benchmarkStatusLabel(runStatus, t)}</div>}
        </div>
      </div>

      <PanelFeedback>
        {serverRunning && <div role="status">{t("panel.serverRunningBenchmark")}</div>}
        {info && <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed ui-border-color-warning-border ui-background-warning-bg ui-color-warning-ink"  role="status">{normalizeDisplayText(info)}</div>}
      </PanelFeedback>

      <div className="mt-4 min-h-0 flex-1 overflow-auto" tabIndex={0} role="region" aria-label={t("panel.benchmarkResults")}>
        {error && (
          <div className="rounded-lg border p-3 text-xs leading-relaxed ui-border-color-error-border ui-background-error-bg ui-color-error-ink"  role="alert">
            <div className="mb-1 font-semibold">{t("error.wrong")}</div>
            <pre className="whitespace-pre-wrap break-words">{normalizeDisplayText(error)}</pre>
          </div>
        )}

        {rows.length > 0 && (
          <div className="overflow-x-auto rounded-lg border ui-border-color-border" >
            <table className="w-full min-w-[34rem] table-fixed border-collapse text-sm">
              <caption className="sr-only">{t("panel.benchmarkResults")}</caption>
              <thead>
                <tr className="border-b text-left text-xs ui-border-color-border ui-color-faint" >
                  <th scope="col" className="w-[40%] px-4 py-2.5 font-medium">{t("ui.benchColumnTest")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 font-medium">{t("ui.benchColumnSize")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 font-medium">{t("ui.benchColumnBatch")}</th>
                  <th scope="col" className="w-[20%] px-4 py-2.5 text-right font-medium">{t("ui.benchColumnTps")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row, index) => (
                  <tr key={`${row.test}-${index}`} className="border-b last:border-0 ui-border-color-border" >
                    <td className="px-4 py-2.5 font-mono text-xs ui-color-ink" >{row.test}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums ui-color-muted" >{row.size}</td>
                    <td className="px-4 py-2.5 text-xs tabular-nums ui-color-muted" >{row.batch}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs font-semibold tabular-nums ui-color-success" >{row.tps.toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {rows.length === 0 && !error && phase === "idle" && !runStatus && (
          <div className="p-6 text-center text-xs ui-color-faint" >{t("panel.benchmarkEmpty")}</div>
        )}

        {effectiveArgs.length > 0 && <details className="mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel" >
          <summary className="cursor-pointer text-xs font-medium ui-color-ink" >{t("panel.effectiveArgs")}</summary>
          <code tabIndex={0} aria-label={t("panel.effectiveArgs")} className="mt-2.5 block max-h-48 overflow-auto whitespace-pre-wrap break-all rounded p-2.5 font-mono text-xs ui-background-mono-bg ui-color-mono-ink" >{effectiveArgs.map((arg) => JSON.stringify(normalizeDisplayText(arg))).join(" ")}</code>
        </details>}
        {history.length > 0 && <section className="mt-4 rounded-xl border p-4 ui-border-color-border ui-background-panel"  aria-labelledby="benchmark-history-heading">
          <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="benchmark-history-heading" className="app-section-title">{t("ui.benchHistory", { count: history.length })}</h2><button type="button" onClick={() => downloadText("aiolm-benchmarks.csv", benchmarkCsv(history), "text/csv") } className="app-button app-button--secondary app-button--sm">{t("ui.benchExportCsv")}</button></div>
          <div className="mt-2.5 space-y-1.5">{history.slice(0, 5).map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-2 text-xs tabular-nums ui-color-faint" ><span>{new Date(record.createdAt).toLocaleString()} · {normalizeDisplayPath(record.model).split(/[\\/]/).pop()} · {benchmarkStatusLabel(record.status === "partial" ? "crashed" : record.status ?? "complete", t)}</span><span>{record.rows.length > 0 ? record.rows.map((row) => `${row.test}: ${row.value.toFixed(1)} ${row.unit}`).join(" · ") : normalizeDisplayText(record.error ?? "—")}</span></div>)}</div>
        </section>}
      </div>
    </div>
  );
}
