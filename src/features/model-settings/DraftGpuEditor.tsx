import { useId, useState } from 'react';
import type { DeviceReport, GpuPlacement, SplitMode } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { cloneGpuPlacement, gpuDeviceLabel, missingGpuIds, toggleGpuSelection } from '../../shared/runtime/sessionUtils';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { modelSettingsCopy } from './modelSettingsCopy';
import { modelSettingsHelp } from './modelSettingsHelp';

export default function DraftGpuEditor({ placement, device, disabled, onChange, onInvalid }: {
  placement?: GpuPlacement; device: DeviceReport | null; disabled: boolean;
  onChange: (gpu: GpuPlacement) => void; onInvalid: (key: string, invalid: boolean) => void;
}) {
  const { t, locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const help = modelSettingsHelp[locale];
  const id = useId();
  const gpu = cloneGpuPlacement(placement);
  const devices = (device?.profile.gpus ?? []).filter((item): item is typeof item & { stable_id: string } => !!item.stable_id);
  const [weights, setWeights] = useState<string | null>(null);
  const options = [{ value: '', label: copy.automatic }, ...devices.map((item, index) => ({ value: item.stable_id, label: gpuDeviceLabel(item, index) }))];
  const patch = (value: Partial<GpuPlacement>) => onChange({ ...gpu, ...value });
  return <section className="model-settings-fields" aria-label={copy.gpu}>
    <div className="model-settings-section-heading"><h3>{copy.gpu}</h3><button type="button" className="app-button app-button--ghost app-button--sm" disabled={disabled}
      onClick={() => { setWeights(null); onInvalid('gpu_tensor_split', false); onChange(cloneGpuPlacement(undefined)); }}>{copy.automatic}</button></div>
    {missingGpuIds(gpu, devices).length > 0 && <p className="text-warning" role="status">{t('ui.gpuMissingWarning')}</p>}
    {devices.length === 0 && <p className="app-section-hint">{t('ui.gpuNoDetected')}</p>}
    <p id={`${id}-devices-hint`} className="app-section-hint">{help.gpuDevices}</p>
    <div className="model-settings-gpus">{devices.map((item, index) => <label key={item.stable_id} className="model-settings-gpu">
      <input type="checkbox" aria-describedby={`${id}-devices-hint`} checked={gpu.gpu_ids.includes(item.stable_id)} disabled={disabled} onChange={() => { setWeights(null); onInvalid('gpu_tensor_split', false); onChange(toggleGpuSelection(gpu, item.stable_id, devices)); }} />
      <span>{normalizeDisplayText(gpuDeviceLabel(item, index))}{item.vram_mb ? <small>{item.vram_mb.toLocaleString()} MiB</small> : null}</span>
    </label>)}</div>
    <div className="model-settings-grid">
      <div><label>{t('ui.gpuMain')}<CustomSelect ariaLabel={t('ui.gpuMain')} ariaDescribedBy={`${id}-main-hint`} value={gpu.main_gpu ?? ''} options={options.filter(option => !option.value || gpu.gpu_ids.includes(option.value))} onChange={value => patch({ main_gpu: value || null })} disabled={disabled} /></label><p id={`${id}-main-hint`} className="app-section-hint">{help.gpuMain}</p></div>
      <div><label>{t('ui.gpuDraft')}<CustomSelect ariaLabel={t('ui.gpuDraft')} ariaDescribedBy={`${id}-draft-hint`} value={gpu.draft_gpu_id ?? ''} options={options} onChange={value => patch({ draft_gpu_id: value || null })} disabled={disabled} /></label><p id={`${id}-draft-hint`} className="app-section-hint">{help.gpuDraft}</p></div>
      <div><label>{t('ui.gpuSplitMode')}<CustomSelect ariaLabel={t('ui.gpuSplitMode')} ariaDescribedBy={`${id}-split-hint`} value={gpu.split_mode} options={['none', 'single', 'layer', 'row', 'tensor'].map(value => ({ value, label: value === 'none' ? copy.automatic : value }))} onChange={value => patch({ split_mode: value as SplitMode })} disabled={disabled} /></label><p id={`${id}-split-hint`} className="app-section-hint">{help.gpuSplitMode}</p></div>
      <div><label>{copy.tensorSplit}<input className="app-input" aria-describedby={`${id}-weights-hint`} value={weights ?? gpu.tensor_split.join(', ')} disabled={disabled || gpu.gpu_ids.length < 2} onChange={event => {
        const raw = event.target.value; setWeights(raw);
        const values = raw.trim() ? raw.split(',').map(value => value.trim() ? Number(value.trim()) : NaN) : [];
        const valid = !values.length || (values.length === gpu.gpu_ids.length && values.every(value => Number.isFinite(value) && value >= 0) && values.some(value => value > 0));
        onInvalid('gpu_tensor_split', !valid); if (valid) patch({ tensor_split: values });
      }} /></label><p id={`${id}-weights-hint`} className="app-section-hint">{help.gpuTensorSplit}</p></div>
    </div>
  </section>;
}
