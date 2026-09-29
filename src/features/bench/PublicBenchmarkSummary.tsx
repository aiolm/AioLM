import { summarizePublicBenchmarkRows } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import type { PublicBenchmarkSubmission } from '../../shared/contracts/benchmark/publicBenchmark.ts';
import type { benchmarkCopy } from './benchmarkCopy.ts';
import { formatBytes, formatCpuCores, formatMebibytes } from '../../shared/lib/units.ts';

type Copy = ReturnType<typeof benchmarkCopy>;

const numberLabel = (value: number | null | undefined, unavailable: string, digits = 1): string =>
  value == null || !Number.isFinite(value) ? unavailable : value.toFixed(digits);

/**
 * Human-readable rendering of the exact public snapshot. Every value comes
 * from the snapshot; local paths, raw hashes/IDs and JSON are never shown.
 */
export function PublicBenchmarkSummary({ snapshot, copy }: { snapshot: PublicBenchmarkSubmission; copy: Copy }) {
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
          <div><dt>{copy.runtimeVersion}</dt><dd>{snapshot.runtime.version ?? unknown}</dd></div>
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
          <div className="performance-table-scroll" role="region" aria-label={copy.shareResults} tabIndex={0}>
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
          </div>
        )}
      </section>
      <p>{copy.publicUnknown}</p>
    </div>
  );
}
