import { useId } from 'react';
import type { AppConfig, DeviceReport, InstalledRuntime } from '../../shared/api/types';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import type { ProfileApplication } from '../../shared/config/settingsProfiles';
import { usesRuntimeDefault } from '../../shared/config/tuningDefaults';
import { settingDefaultInfo } from '../../shared/config/defaultValueDisplay';
import { useI18n } from '../../shared/i18n/i18n';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { formatBytes, formatCpuCores, formatMebibytes } from '../../shared/lib/units';
import { runtimeVersionLabel } from '../../shared/runtime/installedRuntimes';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { useServerOptions } from '../tuning/useServerOptions';
import { benchmarkEnvironmentCopy } from './benchmarkEnvironmentCopy';

export function BenchmarkEnvironment({ config, application, device, runtimes, active, busy }: {
  config: AppConfig; application: ProfileApplication; device: DeviceReport | null;
  runtimes: readonly InstalledRuntime[]; active: boolean; busy: boolean;
}) {
  const { locale } = useI18n();
  const id = useId();
  const copy = benchmarkEnvironmentCopy[locale];
  const runtime = useServerOptions(config.active_backend, config.active_build,
    active && !busy && !!config.active_backend && !!config.active_build && isNativeRuntimeAvailable());
  const profile = config.settings_profiles?.entries.find(entry => entry.id === application.profile_id);
  const profileName = profile ? profileDisplayName(profile, locale) : application.profile_name || copy.unknown;
  const value = (key: 'ngl' | 'threads' | 'batch_size' | 'ubatch_size' | 'cache_type_k' | 'cache_type_v' | 'flash_attn') => {
    // These dedicated controls are app-managed; launch filters their raw aliases.
    if (usesRuntimeDefault(config, key)) {
      const info = settingDefaultInfo(key, runtime.options, runtime.verified, locale, { selected: true });
      return <span title={info.description}>{info.value} <small>{info.badge}</small></span>;
    }
    const selected = config[key];
    if (selected === undefined || selected === '') return copy.unknown;
    if ((key === 'threads' && selected === 0) || selected === 'auto') return copy.automatic;
    if (key === 'ngl' && selected === -1) return copy.allLayers;
    return normalizeDisplayText(String(selected));
  };
  const ngl = usesRuntimeDefault(config, 'ngl') ? undefined : config.ngl;
  const speculative = !usesRuntimeDefault(config, 'spec_type') && !!config.spec_type?.trim() && config.spec_type !== 'none';
  const cpuOnly = config.active_backend === 'cpu' || (ngl === 0 && !config.mmproj?.trim() && !speculative);
  const reported = runtime.capabilities?.backend === config.active_backend
    ? runtimeGpuDevices(config.active_backend, runtime.capabilities.devices) : [];
  const configuredIds = config.gpu?.gpu_ids ?? [];
  const mainId = config.gpu?.main_gpu || configuredIds[0];
  const ids = config.gpu?.split_mode === 'single' ? (mainId ? [mainId] : []) : configuredIds;
  // The explicit draft device field wins over the structured GPU placement at launch.
  const draftDevice = speculative ? config.spec_draft_device?.trim() : '';
  const draftCpu = draftDevice === 'none';
  const draftIds = !speculative || draftCpu ? [] : draftDevice
    ? draftDevice.split(',').map(name => `runtime:${config.active_backend}:${name.trim()}`)
    : config.gpu?.draft_gpu_id ? [config.gpu.draft_gpu_id] : [];
  const selectedIds = [...new Set([...ids, ...draftIds])];
  const devices = selectedIds.map((id, index) => {
    const gpu = id.startsWith('runtime:') ? reported.find(item => item.stable_id === id)
      : device?.profile.gpus.find(item => item.stable_id === id);
    // Runtime device descriptions may include both total and free memory. Only
    // the reported total belongs in a specification; never infer an OS adapter.
    const capacity = id.startsWith('runtime:') ? gpu?.name.match(/^(.*) \((\d+) MiB(?:,.*)?\)$/) : null;
    const memory = gpu?.vram_mb ?? (capacity ? Number(capacity[2]) : undefined);
    const name = gpu ? normalizeDisplayText(capacity?.[1] ?? gpu.name) : `${id.startsWith(`runtime:${config.active_backend}:`) ? id.split(':').at(-1) : `GPU ${index + 1}`} · ${runtime.loading && !busy ? copy.loading : copy.missingGpu}`;
    const role = [ids.includes(id) && selectedIds.length > 1 && id === mainId ? copy.main : '', draftIds.includes(id) ? copy.draft : ''].filter(Boolean).join(' / ');
    return <span key={id}>{name}{memory && Number.isFinite(memory) ? ` · ${formatMebibytes(memory)} VRAM` : ''}{role && <small> · {role}</small>}</span>;
  });
  const cpu = device?.profile.cpu;
  const ram = device?.system_memory_bytes;
  // The profile and its launch options lead; the machine they run on supports them.
  return <section className="performance-environment" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="performance-column-title">{copy.title}</h3>
    <dl className="performance-environment-overview">
      <div><dt>{copy.profile}</dt><dd>{normalizeDisplayText(profileName)}</dd></div>
      <div><dt>{copy.runtime}</dt><dd>{config.active_backend ? `${config.active_backend} · ${runtimeVersionLabel(runtimes, config.active_backend, config.active_build)}` : copy.unknown}</dd></div>
    </dl>
    <h4 id={`${id}-settings`} className="sr-only">{copy.settings}</h4>
    <dl className="performance-environment-settings" aria-labelledby={`${id}-settings`}>
      <div><dt>{copy.gpuLayers}</dt><dd>{value('ngl')}</dd></div>
      <div><dt>{copy.threads}</dt><dd>{value('threads')}</dd></div>
      <div><dt>{copy.batch}</dt><dd>{value('batch_size')} / {value('ubatch_size')}</dd></div>
      <div><dt>{copy.cache}</dt><dd>{value('cache_type_k')} / {value('cache_type_v')}</dd></div>
      <div><dt>{copy.flash}</dt><dd>{value('flash_attn')}</dd></div>
    </dl>
    <h4 id={`${id}-hardware`} className="sr-only">{copy.hardware}</h4>
    <dl className="performance-environment-hardware" aria-labelledby={`${id}-hardware`}>
      <div><dt>{copy.gpu}</dt><dd className="performance-environment-devices">{cpuOnly ? copy.cpuOnly : <>{!ids.length && <span>{copy.automaticGpu}</span>}{devices}{draftCpu && <span>{copy.cpuOnly} · {copy.draft}</span>}</>}</dd></div>
      <div><dt>{copy.system}</dt><dd>{cpu ? <>{normalizeDisplayText(cpu.name)}<small>{formatCpuCores(cpu)}{typeof ram === 'number' && ram > 0 ? ` · ${formatBytes(ram)} RAM` : ''}</small></> : copy.unknown}</dd></div>
    </dl>
  </section>;
}
