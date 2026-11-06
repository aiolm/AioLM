import BenchmarkTableScroll from './BenchmarkTableScroll';
import { formatRuntimeVersionLabel, summarizeServingPoints, type LegacyPublicBenchmarkSubmission, type RecordedSetting, type ServingBenchmarkPoint, type ServingMetricStat, type PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';
import { summarizePublicBenchmarkRows } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import type { benchmarkCopy } from './benchmarkCopy.ts';
import { formatBytes, formatCpuCores, formatMebibytes } from '../../shared/lib/units.ts';

type Copy = ReturnType<typeof benchmarkCopy>;

const numberLabel = (value: number | null | undefined, unavailable: string, digits = 1): string =>
  value == null || !Number.isFinite(value) ? unavailable : value.toFixed(digits);

/**
 * Human-readable rendering of the exact public snapshot. Every value comes
 * from the snapshot; local paths, raw hashes/IDs and JSON are never shown.
 */
function LegacyPublicBenchmarkSummary({ snapshot, copy }: { snapshot: LegacyPublicBenchmarkSubmission; copy: Copy }) {
  const unknown = copy.shareUnidentified;
  const unavailable = copy.unavailable;
  const metadata = snapshot.model.metadata;
  const modelName = metadata?.name ?? null;
  const modelExtra = [metadata?.architecture, metadata?.size_label, metadata?.quantization].filter((part): part is string => !!part);
  const hardware = snapshot.environment;
  const cpu = hardware?.cpu ?? null;
  const installedGpus = hardware?.installed_gpus ?? [];
  const selectedGpus = hardware?.execution.selected_gpus ?? [];
  const executionMode = hardware?.execution.mode ?? 'unknown';
  const gpuLabel = (gpu: (typeof installedGpus)[number]) => `${gpu.name ?? unknown}${gpu.vram_mb == null ? '' : ` · ${formatMebibytes(gpu.vram_mb)} VRAM`}`;
  const executionLabel = executionMode === 'cpu'
    ? 'CPU'
    : selectedGpus.length > 0
      ? selectedGpus.map(gpuLabel).join(' / ')
      : executionMode === 'automatic'
        ? copy.shareAutomatic
        : unknown;
  const settings = snapshot.execution.settings;
  const summaries = summarizePublicBenchmarkRows(snapshot.measurements.rows);
  const hasBatch = summaries.some((row) => row.concurrency > 1);

  return (
    <div className="performance-share-summary" aria-label={copy.publicPreview}>
      <section aria-label={copy.shareModel}>
        <h4>{copy.shareModel}</h4>
        <dl>
          <div><dt>{copy.shareModelName}</dt><dd>{modelName ?? unknown}{modelExtra.length > 0 ? ` · ${modelExtra.join(' · ')}` : ''}</dd></div>
          <div><dt>{copy.shareModelSize}</dt><dd>{typeof snapshot.model.size_bytes === 'number' ? formatBytes(snapshot.model.size_bytes) : unknown}</dd></div>
        </dl>
        <h4>{copy.shareRuntime}</h4>
        <dl>
          <div><dt>{copy.shareBackend}</dt><dd>{snapshot.runtime.backend ?? unknown}</dd></div>
          <div><dt>{copy.runtimeVersion}</dt><dd>{formatRuntimeVersionLabel(snapshot.runtime) ?? unknown}</dd></div>
          <div><dt>{copy.shareAppVersion}</dt><dd>{snapshot.app_version ?? unknown}</dd></div>
        </dl>
      </section>
      <section aria-label={copy.shareHardware}>
        <h4>{copy.shareHardware}</h4>
        {hardware ? (
          <dl>
            <div><dt>{copy.shareOs}</dt><dd>{[hardware.os, hardware.arch].filter(Boolean).join(' · ') || unknown}</dd></div>
            <div><dt>{copy.processor}</dt><dd>{cpu?.name ?? unknown}{cpu ? ` · ${formatCpuCores(cpu)}` : ''}</dd></div>
            <div><dt>{copy.systemMemory}</dt><dd>{hardware.system_memory_bytes == null ? unknown : formatBytes(hardware.system_memory_bytes)}</dd></div>
            <div><dt>{copy.executionDevice}</dt><dd>{executionLabel}</dd></div>
            {installedGpus.length > 0 && (
              <div><dt>{copy.shareInstalledGpus}</dt><dd>{installedGpus.map(gpuLabel).join(' / ')}</dd></div>
            )}
          </dl>
        ) : (
          <p>{unknown}</p>
        )}
      </section>
      <section className="performance-share-settings" aria-label={copy.shareSettings}>
        <h4>{copy.shareSettings}</h4>
        <dl>
          <div><dt>{copy.corpus}</dt><dd>{copy[snapshot.workload.corpus]}</dd></div>
          <div><dt>{copy.promptLengths}</dt><dd>{snapshot.workload.prompt_lengths.map((value) => value.toLocaleString()).join(' / ')}</dd></div>
          <div><dt>{copy.generation}</dt><dd>{snapshot.workload.generation_length.toLocaleString()}</dd></div>
          <div><dt>{copy.batchSizes}</dt><dd>{[1, ...snapshot.workload.batch_sizes].map((value) => `${value}×`).join(' / ')}</dd></div>
          <div><dt>{copy.repetitions}</dt><dd>{snapshot.workload.repetitions}</dd></div>
          <div><dt>{copy.warmup}</dt><dd>{snapshot.workload.warmup ? copy.enabled : copy.disabled}</dd></div>
          <div><dt>{copy.contextSize}</dt><dd>{snapshot.execution.context_size.toLocaleString()}</dd></div>
          <div><dt>{copy.parallel}</dt><dd>{snapshot.execution.parallel}</dd></div>
          {settings && (
            <>
              {settings.gpu_layers != null && <div><dt>{copy.shareGpuLayers}</dt><dd>{settings.gpu_layers}</dd></div>}
              {settings.threads != null && <div><dt>{copy.shareThreads}</dt><dd>{settings.threads}</dd></div>}
            </>
          )}
        </dl>
      </section>
      <section className="performance-share-results performance-results" aria-label={copy.shareResults}>
        <h4>{copy.shareResults}</h4>
        <p>{copy.shareStatus}: {copy[snapshot.measurements.status] ?? snapshot.measurements.status}</p>
        {summaries.length > 0 && (
          <BenchmarkTableScroll label={copy.shareResults} copy={copy}>
            <table>
              <thead><tr>
                <th scope="col">{copy.test}</th>
                {hasBatch && <th scope="col">{copy.concurrency}</th>}
                <th scope="col">{copy.repeat}</th>
                <th scope="col">{copy.ttft} <small>{copy.milliseconds}</small></th>
                <th scope="col">{copy.tpot} <small>{copy.milliseconds}</small></th>
                <th scope="col" className="performance-phase-heading" title={copy.ppHint}>{copy.pp} <small>{copy.tokens}</small></th>
                <th scope="col" className="performance-phase-heading" title={copy.tgHint}>{copy.tg} <small>{copy.tokens}</small></th>
                <th scope="col">{copy.throughput} <small>{copy.tokens}</small></th>
              </tr></thead>
              <tbody>{summaries.map((row) => (
                <tr key={`${row.prompt_tokens}|${row.generation_length}|${row.concurrency}|${row.timing_source}`}>
                  <th scope="row">{row.prompt_tokens.toLocaleString()} / {row.generation_length.toLocaleString()}</th>
                  {hasBatch && <td>{row.concurrency}×</td>}
                  <td>{row.samples}</td>
                  <td>{numberLabel(row.ttft_ms, unavailable)}</td>
                  <td>{numberLabel(row.tpot_ms, unavailable, 2)}</td>
                  <td>{numberLabel(row.pp_tps, unavailable)}</td>
                  <td>{numberLabel(row.tg_tps, unavailable)}</td>
                  <td>{numberLabel(row.total_tps, unavailable)}</td>
                </tr>
              ))}</tbody>
            </table>
          </BenchmarkTableScroll>
        )}
      </section>
      <p>{copy.publicUnknown}</p>
    </div>
  );
}

function MetricCell({ stat, copy, memory = false }: { stat: ServingMetricStat | null; copy: Copy; memory?: boolean }) {
  if (!stat) return <td>{copy.unavailable}</td>;
  const value = (n: number) => memory ? formatBytes(n) : numberLabel(n, copy.unavailable);
  return <td>{value(stat.median)}<small>{value(stat.min)} – {value(stat.max)} · n={stat.samples}</small></td>;
}

/** Shared serving-point renderer: statistics are never averaged again by the UI. */
export function ServingResultTable({ points, copy, label = copy.servingResults, fixedOutput = false }: { points: readonly ServingBenchmarkPoint[]; copy: Copy; label?: string; fixedOutput?: boolean }) {
  if (!points.length) return null;
  const metrics = [
    ...(fixedOutput ? [['reported_tokens_per_second', copy.fixedTokenRate, copy.tokens] as const] : []),
    ['first_output_ms', copy.firstOutput, copy.milliseconds],
    ['first_content_ms', copy.firstContent, copy.milliseconds],
    ['first_reasoning_ms', copy.firstReasoning, copy.milliseconds],
    ['e2e_ms', copy.e2e, copy.milliseconds],
    ['output_bytes_per_second', copy.outputRate, copy.bytesPerSecond],
    ...(!fixedOutput ? [['reported_tokens_per_second', copy.reportedRate, copy.tokens] as const] : []),
    ['content_bytes', copy.contentBytes, copy.bytes],
    ['reasoning_bytes', copy.reasoningBytes, copy.bytes],
    ['output_bytes', copy.outputBytes, copy.bytes],
    ['reported_prompt_tokens', copy.reportedPrompt, ''],
    ['reported_completion_tokens', copy.reportedCompletion, ''],
    ['reported_cached_tokens', copy.reportedCached, ''],
    ['peak_memory_bytes', copy.memory, ''],
  ] as const;
  return <section className="app-card app-card--flush performance-card performance-results" aria-label={label}>
    <div className="performance-card-heading"><h3>{label}</h3></div>
    <p className="performance-hint">{copy.medianHint}</p>
    <BenchmarkTableScroll label={label} copy={copy}><table>
      <caption className="sr-only">{label}</caption>
      <thead><tr><th scope="col">{fixedOutput ? copy.fixedServingTest : copy.servingTest}</th><th scope="col">{copy.concurrency}</th><th scope="col">{copy.repeat}</th>
        {metrics.map(([key, label, unit]) => <th scope="col" key={key}>{label}{unit && <small>{unit}</small>}</th>)}
      </tr></thead>
      <tbody>{points.map(point => <tr key={`${point.input_bytes}/${point.concurrency}/${point.max_output_tokens}`}>
        <th scope="row">{point.input_bytes.toLocaleString()} / {point.max_output_tokens.toLocaleString()}</th>
        <td>{point.concurrency}×</td><td>{point.samples}</td>
        {metrics.map(([key]) => <MetricCell key={key} stat={point[key]} copy={copy} memory={key === 'peak_memory_bytes'} />)}
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
  if (snapshot.schema_version !== 3) return <><p>{copy.legacy}</p><LegacyPublicBenchmarkSummary snapshot={snapshot} copy={copy} /></>;
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
      <div><dt>{copy.inputBytes}</dt><dd>{snapshot.workload.inputs.map(input => input.bytes.toLocaleString()).join(' / ')}</dd></div>
      {snapshot.workload.inputs.map(input => <div key={input.bytes}><dt>{copy.inputHash} · {input.bytes}</dt><dd>{input.sha256}</dd></div>)}
      <div><dt>{snapshot.method.version === 2 ? copy.outputTokens : copy.outputCap}</dt><dd>{snapshot.workload.max_output_tokens}</dd></div>
      <div><dt>{copy.concurrency}</dt><dd>{snapshot.workload.concurrencies.map(value => `${value}×`).join(' / ')}</dd></div>
      <div><dt>{copy.repetitions}</dt><dd>{snapshot.workload.repetitions}</dd></div>
      <div><dt>{copy.warmup}</dt><dd>{snapshot.workload.warmup ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.requestUsage}</dt><dd>{snapshot.workload.request_usage ? copy.enabled : copy.disabled}</dd></div>
      <div><dt>{copy.cachePolicy}</dt><dd>{copy.asConfigured}</dd></div>
    </dl><RecordedSettings settings={snapshot.execution.settings} copy={copy} /></section>
    <section className="performance-share-results performance-results" aria-label={copy.shareResults}>
      <h4>{copy.shareResults}</h4><p>{copy.shareStatus}: {copy[snapshot.measurements.status]}</p>
      <ServingResultTable points={summarizeServingPoints(snapshot.measurements.rows)} copy={copy} label={copy.shareResults} fixedOutput={snapshot.method.version === 2} />
    </section><p>{copy.emptyOutputHint}</p><p>{copy.publicUnknown}</p>
  </div>;
}
