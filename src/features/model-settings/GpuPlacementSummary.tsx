import type { GpuDevice } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { profileFieldLabel } from './profileControlCopy';
import { valueRenderer } from './SettingsChangeList';

const FIELDS = ['gpu_ids', 'main_gpu', 'split_mode', 'tensor_split', 'draft_gpu_id'];
const DEVICE_FIELDS = new Set(['gpu_ids', 'main_gpu', 'draft_gpu_id']);

/**
 * A readable name for a stored device id. A device the runtime reports shows
 * its reported name; an id it does not report is never given a guessed name,
 * only a runtime id is shortened to its runtime index (`Vulkan0`).
 */
export function gpuDisplayName(id: string, devices: readonly GpuDevice[]): string {
  const index = devices.findIndex(device => device.stable_id === id);
  if (index >= 0) {
    const name = normalizeDisplayText(devices[index].name);
    return id.startsWith('runtime:') ? name : `GPU ${index} · ${name}`;
  }
  return id.match(/^runtime:[^:]+:(.+)$/)?.[1] ?? id;
}

/**
 * GPU placement as one row per field. Stored ids are long stable ids that read
 * as one unbroken sentence when joined, so each device is shown by name on its
 * own line with the full id kept in its tooltip.
 */
export default function GpuPlacementSummary({ placement, devices }: { placement: Record<string, unknown>; devices: readonly GpuDevice[] }) {
  const { locale } = useI18n();
  const render = valueRenderer(locale);
  const keys = [...FIELDS.filter(key => key in placement), ...Object.keys(placement).filter(key => !FIELDS.includes(key))];
  return <dl className="settings-profile-gpu">{keys.map(key => {
    const value = placement[key];
    const ids = Array.isArray(value) ? value : [value];
    const named = DEVICE_FIELDS.has(key) && ids.length > 0 && ids.every(id => typeof id === 'string' && id !== '');
    return <div key={key}>
      <dt>{profileFieldLabel(key, locale)}</dt>
      <dd>{named ? (ids as string[]).map((id, index) => <span key={index} title={id}>{gpuDisplayName(id, devices)}</span>) : render(value)}</dd>
    </div>;
  })}</dl>;
}
