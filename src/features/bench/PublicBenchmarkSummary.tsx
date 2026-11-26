import BenchmarkTableScroll from './BenchmarkTableScroll';
import { SERVING_METRIC_KEYS, summarizeServingPoints, type RecordedSetting, type ServingBenchmarkPoint, type ServingMetricKey, type ServingMetricStat, type PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';
import type { benchmarkCopy } from './benchmarkCopy.ts';
import { formatBytes, formatCpuCores, formatMebibytes } from '../../shared/lib/units.ts';
import { formatInputSize } from './performanceBenchConfig.ts';

type Copy = ReturnType<typeof benchmarkCopy>;

const numberLabel = (value: number | null | undefined, unavailable: string, digits = 1): string =>
  value == null || !Number.isFinite(value) ? unavailable : value.toFixed(digits);


function MetricCell({ stat, copy, memory = false }: { stat: ServingMetricStat | null; copy: Copy; memory?: boolean }) {
  if (!stat) return <td>{copy.unavailable}</td>;
  return <td>{memory ? formatBytes(stat.median) : numberLabel(stat.median, copy.unavailable)}</td>;
}

/** Shared serving-point renderer: statistics are never averaged again by the UI. */
export function ServingResultTable({ points, copy, label = copy.servingResults }: { points: readonly ServingBenchmarkPoint[]; copy: Copy; label?: string }) {
  if (!points.length) return null;
  const metrics: Record<ServingMetricKey, readonly [string, string, string, string]> = {
    first_output_ms: [copy.tableFirstOutput, copy.tableFirstOutputSub, copy.milliseconds, copy.firstOutput],
    prefill_tokens_per_second: [copy.tablePrefillRate, copy.tablePrefillRateSub, copy.tokens, copy.prefillRate],
    decode_tokens_per_second: [copy.tableDecodeRate, copy.tableDecodeRateSub, copy.tokens, copy.decodeRate],
    tpot_ms: [copy.tableTpot, copy.tableTpotSub, copy.milliseconds, copy.tpot],
    reported_tokens_per_second: [copy.tableReportedRate, copy.tableReportedRateSub, copy.tokens, copy.reportedRate],
    output_bytes_per_second: [copy.tableOutputRate, '', copy.bytesPerSecond, copy.outputRate],
    e2e_ms: [copy.tableE2e, copy.tableE2eSub, copy.milliseconds, copy.e2e],
    peak_memory_bytes: [copy.tableMemory, '', copy.bytes, copy.memory],
  };
  return <section className="app-card app-card--flush performance-card performance-results" aria-label={label}>
    <div className="performance-card-heading"><h3>{label}</h3></div>
    <p className="performance-hint">{copy.medianHint}</p>
    <BenchmarkTableScroll label={label} copy={copy}><table>
      <caption className="sr-only">{label}</caption>
      <thead><tr>
        <th scope="col" title={copy.inputBytes}>{copy.tableInput}<small>{copy.bytes}</small></th>
        <th scope="col" title={copy.concurrency}>{copy.tableConcurrency}</th>
        <th scope="col" title={copy.repeat}>{copy.tableSamples}</th>
        {SERVING_METRIC_KEYS.map(key => {
          const [heading, sub, unit, full] = metrics[key];
          return <th scope="col" key={key} title={full}>{heading}{sub && <span className="performance-th-sub">{sub}</span>}<small>{unit}</small></th>;
        })}
      </tr></thead>
      <tbody>{points.map(point => <tr key={`${point.input_bytes}/${point.concurrency}/${point.max_output_tokens}`}>
        <th scope="row">{formatInputSize(point.input_bytes)}</th>
        <td>{point.concurrency}×</td><td>{point.samples}</td>
        {SERVING_METRIC_KEYS.map(key => <MetricCell key={key} stat={point[key]} copy={copy} memory={key === 'peak_memory_bytes'} />)}
      </tr>)}</tbody>
    </table></BenchmarkTableScroll>
  </section>;
}

export function RecordedSettings({ settings, copy }: { settings: readonly RecordedSetting[]; copy: Copy }) {
  return settings.length ? <dl className="performance-run-config">{settings.map(setting => <div key={JSON.stringify([setting.target, setting.scope, setting.name])}>
    <dt>{setting.target === 'launch' ? copy.launchTarget : copy.requestTarget} · {[...setting.scope, setting.name].join(' / ')}</dt>
    <dd>{setting.value === null ? copy.unavailable : Array.isArray(setting.value) ? setting.value.join(', ') : String(setting.value)}
      {setting.unit && ` ${setting.unit}`}{setting.role && <small>{setting.role}</small>}</dd>
  </div>)}</dl> : <p>{copy.noRecordedSettings}</p>;
}

export function PublicBenchmarkSummary({ snapshot, copy }: { snapshot: PublicBenchmarkSubmission; copy: Copy }) {
  const unknown = copy.shareUnidentified;
  const hardware = snapshot.environment;
  return <div className="performance-share-summary" aria-label={copy.publicPreview}>
    <section aria-label={copy.shareModel}><h4>{copy.shareModel}</h4><dl>
      <div><dt>{copy.shareModelName}</dt><dd>{[snapshot.model.metadata?.name, snapshot.model.metadata?.architecture, snapshot.model.metadata?.size_label, snapshot.model.metadata?.quantization].filter(Boolean).join(' · ') || unknown}</dd></div>
      <div><dt>{copy.modelFormat}</dt><dd>{snapshot.model.format}</dd></div>
      <div><dt>{copy.modelStatus}</dt><dd>{snapshot.model.status}</dd></div>
      <div><dt>{copy.modelHash}</dt><dd>{snapshot.model.sha256 ?? unknown}</dd></div>
      <div><dt>{copy.shareModelSize}</dt><dd>{snapshot.model.size_bytes === null ? unknown : formatBytes(snapshot.model.size_bytes)}</dd></div>
      <div><dt>{copy.modelSource}</dt><dd>{snapshot.model.source?.repository ?? unknown}</dd></div>
      <div><dt>{copy.modelRevision}</dt><dd>{snapshot.model.source?.revision ?? unknown}</dd></div>
    </dl><p>{copy.sourceHint}</p></section>
    <section aria-label={copy.shareRuntime}><h4>{copy.shareRuntime}</h4><dl>
      <div><dt>{copy.runtimeName}</dt><dd>{snapshot.runtime.name ?? unknown}</dd></div>
      <div><dt>{copy.runtimeVersion}</dt><dd>{snapshot.runtime.version ?? unknown}</dd></div>
      <div><dt>{copy.shareBackend}</dt><dd>{snapshot.runtime.backend ?? unknown}</dd></div>
      <div><dt>{copy.runtimeBuild}</dt><dd>{snapshot.runtime.build ?? unknown}</dd></div>
      <div><dt>{copy.runtimeVariant}</dt><dd>{snapshot.runtime.variant ?? unknown}</dd></div>
      <div><dt>{copy.runtimePlugin}</dt><dd>{snapshot.runtime.plugin_version ?? unknown}</dd></div>
      <div><dt>{copy.shareAppVersion}</dt><dd>{snapshot.app_version ?? unknown}</dd></div>
      <div><dt>{copy.topology}</dt><dd>{snapshot.execution.topology}</dd></div>
      <div><dt>{copy.memoryScope}</dt><dd>{snapshot.execution.memory_scope}</dd></div>
    </dl><p>{copy.servingMemoryHint}</p></section>
    <section aria-label={copy.shareHardware}><h4>{copy.shareHardware}</h4><p>{copy.hostScope}</p>{hardware ? <dl>
      <div><dt>{copy.shareOs}</dt><dd>{[hardware.os, hardware.arch].filter(Boolean).join(' · ') || unknown}</dd></div>
      <div><dt>{copy.processor}</dt><dd>{hardware.cpu.name ?? unknown} · {formatCpuCores(hardware.cpu)}</dd></div>
      <div><dt>{copy.systemMemory}</dt><dd>{hardware.system_memory_bytes == null ? unknown : formatBytes(hardware.system_memory_bytes)}</dd></div>
      <div><dt>{copy.executionDevice}</dt><dd>{hardware.execution.mode === 'cpu' ? 'CPU' : hardware.execution.selected_gpus.map(gpu => `${gpu.name ?? unknown}${gpu.vram_mb == null ? '' : ` · ${formatMebibytes(gpu.vram_mb)} VRAM`}`).join(' / ') || unknown}</dd></div>
      <div><dt>{copy.shareInstalledGpus}</dt><dd>{hardware.installed_gpus.map(gpu => `${gpu.name ?? unknown}${gpu.vram_mb == null ? '' : ` · ${formatMebibytes(gpu.vram_mb)} VRAM`}`).join(' / ') || unknown}</dd></div>
    </dl> : <p>{unknown}</p>}</section>
    <section className="performance-share-settings" aria-label={copy.shareSettings}><h4>{copy.shareSettings}</h4><dl>
      <div><dt>{copy.method}</dt><dd>{snapshot.method.id}@{snapshot.method.version}</dd></div>
      <div><dt>{copy.corpus}</dt><dd>{copy[snapshot.workload.corpus]}</dd></div>
      <div><dt>{copy.inputBytes}</dt><dd>{snapshot.workload.inputs.map(input => formatInputSize(input.bytes)).join(' / ')}</dd></div>
      {snapshot.workload.inputs.map(input => <div key={input.bytes}><dt>{copy.inputHash} · {input.bytes}</dt><dd>{input.sha256}</dd></div>)}
      <div><dt>{copy.outputCap}</dt><dd>{snapshot.workload.max_output_tokens}</dd></div>
      <div><dt>{copy.concurrency}</dt><dd>{snapshot.workload.concurrencies.map(value => `${value}×`).join(' / ')}</dd></div>
      <div><dt>{copy.repetitions}</dt><dd>{snapshot.workload.repetitions}</dd></div>
      <div><dt>{copy.warmup}</dt><dd>{snapshot.workload.warmup ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.requestUsage}</dt><dd>{snapshot.workload.request_usage ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.cachePolicy}</dt><dd>{copy.coldPrompt}</dd></div>
      <div><dt>{copy.promptNonce}</dt><dd>{snapshot.workload.prompt_nonce}</dd></div>
    </dl><RecordedSettings settings={snapshot.execution.settings} copy={copy} /></section>
    <section className="performance-share-results performance-results" aria-label={copy.shareResults}>
      <h4>{copy.shareResults}</h4><p>{copy.shareStatus}: {copy[snapshot.measurements.status]}</p>
      <ServingResultTable points={summarizeServingPoints(snapshot.measurements.rows)} copy={copy} label={copy.shareResults} />
    </section><p>{copy.emptyOutputHint}</p><p>{copy.publicUnknown}</p>
  </div>;
}
