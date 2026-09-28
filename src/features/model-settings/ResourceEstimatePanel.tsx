import { useId, useState } from 'react';
import type { AppConfig } from '../../shared/api';
import type { ServerOption } from '../../shared/config/serverOptions';
import { useI18n } from '../../shared/i18n/i18n';
import { formatBytes } from '../../shared/lib/units';
import { resourceEstimateCopy } from './resourceEstimateCopy';
import { useResourceEstimate } from './useResourceEstimate';
import './resource-estimate.css';

export default function ResourceEstimatePanel({ cfg, options, verified, runtimeDevices, open, invalid, benchmark = false }: {
  cfg: AppConfig; options: readonly ServerOption[]; verified: boolean; runtimeDevices?: readonly string[]; open: boolean; invalid: boolean; benchmark?: boolean;
}) {
  const { locale } = useI18n();
  const copy = resourceEstimateCopy[locale];
  const id = useId();
  // Details unmount while a new draft is calculated; keep the reader's choice across edits.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const selected = !!cfg.active_model.trim() && !!cfg.active_backend;
  const { estimate, loading, error, retry } = useResourceEstimate(cfg, options, verified, open && selected && !invalid, runtimeDevices);
  const status = invalid ? copy.invalid : !selected ? copy.select : error ? copy.error : loading ? copy.loading : copy.estimated;
  const placeholder = loading ? '…' : '—';
  // Zero is a valid estimate (everything fits in VRAM); only null is unavailable.
  const bytes = (value: number | null) => value === null ? copy.unknown : formatBytes(value);
  const vram = estimate ? bytes(estimate.vram_bytes) : placeholder;
  const ram = estimate ? bytes(estimate.ram_offload_bytes) : placeholder;
  const ssd = estimate ? bytes(estimate.ssd_offload_bytes) : placeholder;
  // Explicit lazy weights can sit on SSD with ample RAM, so only a capacity-overflow
  // note warns about exceeded memory; nonzero SSD alone is not that warning.
  const warning = !estimate ? null : estimate.notes.includes('disk_offload') ? copy.exceedsMemory
    : estimate.notes.includes('placement_adjustment') ? copy.exceedsVram : null;
  const requested = estimate?.required_vram_bytes ?? null;
  return <section className="resource-estimate" aria-labelledby={`${id}-title`}>
    <div className="resource-estimate-summary">
      <span id={`${id}-title`} className="resource-estimate-title">{copy.title}</span>
      <dl aria-busy={loading}>
        <div><dt>{copy.vram}</dt><dd data-testid="resource-vram">{vram}</dd></div>
        <div><dt>{copy.ramOffload}</dt><dd data-testid="resource-ram">{ram}</dd></div>
        {/* resource-disk is kept as the SSD Offload selector; stored file sizes appear only in the details. */}
        <div><dt>{copy.ssdOffload}</dt><dd data-testid="resource-disk">{ssd}</dd></div>
      </dl>
    </div>
    <div className="resource-estimate-status">
      {/* A finished estimate shows its details toggle on this line; the status is still announced. */}
      <span role="status" aria-live="polite" aria-atomic="true" className={estimate ? 'sr-only' : undefined}>{status}</span>
      {error && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={retry}>{copy.retry}</button>}
      {estimate && <details className="resource-estimate-details" open={detailsOpen}>
        <summary onClick={event => { event.preventDefault(); setDetailsOpen(value => !value); }}>{copy.details}{warning ? <span className="text-warning"> · {warning}</span> : null}</summary>
        <dl>
          {requested !== null && requested !== estimate.vram_bytes && <div><dt>{copy.requiredVram}</dt><dd>{formatBytes(requested)}</dd></div>}
          {!!estimate.vram_capacity_bytes && <div><dt>{copy.vramCapacity}</dt><dd>{formatBytes(estimate.vram_capacity_bytes)}</dd></div>}
          {estimate.ram_capacity_bytes !== null && <div><dt>{copy.capacity}</dt><dd>{formatBytes(estimate.ram_capacity_bytes)}</dd></div>}
          <div><dt>{copy.hostMemory}</dt><dd>{bytes(estimate.host_memory_bytes)}</dd></div>
          <div><dt>{copy.kv}</dt><dd>{bytes(estimate.kv_bytes)}</dd></div>
        </dl>
        <p>{copy.scope}</p>
        <p>{copy.capacityHint}</p>
        <ul>{estimate.notes.filter(note => note in copy.notes).map(note => <li key={note}>{copy.notes[note as keyof typeof copy.notes]}</li>)}</ul>
        <dl className="resource-estimate-files">
          <div><dt>{copy.storedFiles}{estimate.disk_complete ? null : <span className="sr-only">, {copy.incomplete}</span>}</dt><dd data-testid="resource-files">{estimate.disk_complete ? '' : '≥ '}{formatBytes(estimate.disk_bytes)}</dd></div>
          <div><dt>{copy.modelFiles}</dt><dd>{formatBytes(estimate.model_bytes)}</dd></div>
          <div><dt>{copy.auxiliaryFiles}</dt><dd>{formatBytes(estimate.auxiliary_bytes)}</dd></div>
        </dl>
        <p>{copy.filesHint}</p>
        {benchmark && <p>{copy.benchmark}</p>}
      </details>}
    </div>
  </section>;
}
