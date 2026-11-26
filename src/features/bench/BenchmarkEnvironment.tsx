import { useEffect, useId, useRef, useState } from 'react';
import type { AppConfig, DeviceReport, InstalledRuntime } from '../../shared/api/types';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import type { CommandSyntax } from '../../shared/api/runtimeHelp';
import { errorMessage } from '../../shared/api/errors';
import type { ProfileApplication } from '../../shared/config/settingsProfiles';
import { usesRuntimeDefault } from '../../shared/config/tuningDefaults';
import { settingDefaultInfo } from '../../shared/config/defaultValueDisplay';
import { useI18n } from '../../shared/i18n/i18n';
import { modelActions } from '../../shared/i18n/modelActions';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { hostCommandLineSyntax } from '../../shared/lib/commandLine';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { formatBytes, formatCpuCores, formatMebibytes } from '../../shared/lib/units';
import { runtimeVersionLabel } from '../../shared/runtime/installedRuntimes';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { useServerOptions } from '../tuning/useServerOptions';
import { benchmarkEnvironmentCopy } from './benchmarkEnvironmentCopy';
import { providerOf, providerDisplayName, providerCommandPreview, type CommandPreview } from '../../shared/api/providers';
import { providerCopy } from '../../shared/i18n/providerCopy';
import CommandLineViewer, { type CommandLineKind } from '../../shared/ui/CommandLineViewer';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import { commandToolsCopy } from '../model-settings/commandToolsCopy';
import RuntimeProfileValues from '../model-settings/RuntimeProfileValues';
import { useProfileRuntimeSchema } from '../model-settings/useProfileRuntimeSchema';
import { maskPreview } from '../runtimes/optionPresentation';
import { sensitiveEntryTokenStrings } from '../runtimes/sensitiveEntryTokens';

export function BenchmarkEnvironment({ config, application, device, runtimes, active, busy, onRuntimeVerified }: {
  config: AppConfig; application: ProfileApplication; device: DeviceReport | null;
  runtimes: readonly InstalledRuntime[]; active: boolean; busy: boolean;
  onRuntimeVerified?: () => void;
}) {
  const { locale } = useI18n();
  const id = useId();
  const copy = benchmarkEnvironmentCopy[locale];
  const provider = providerOf(config);
  const llama = provider === 'llama.cpp';
  const nativeAvailable = isNativeRuntimeAvailable();
  const runtime = useServerOptions(config.active_backend, config.active_build,
    llama && active && !busy && !!config.active_backend && !!config.active_build && nativeAvailable);
  const schema = useProfileRuntimeSchema(config, !llama && active && !busy);
  const selectedRuntime = llama
    ? (config.active_backend && config.active_build ? `${config.active_build}-${config.active_backend}` : '')
    : (config.active_runtime ?? '');
  const runtimeNeeded = !selectedRuntime;
  const [previewOpen, setPreviewOpen] = useState(false);
  const [rawPreview, setRawPreview] = useState<CommandPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');
  const [previewRevision, setPreviewRevision] = useState(0);
  const [commandKind, setCommandKind] = useState<CommandLineKind>('engine');
  const [copySyntax, setCopySyntax] = useState<CommandSyntax>(hostCommandLineSyntax);
  const [multiline, setMultiline] = useState(true);
  const previewRequestRef = useRef(0);
  useEffect(() => {
    const request = ++previewRequestRef.current;
    if (!previewOpen || !active || !nativeAvailable || runtimeNeeded) {
      setRawPreview(null);
      setPreviewError('');
      setPreviewLoading(false);
      return;
    }
    setPreviewLoading(true);
    setPreviewError('');
    setRawPreview(null);
    void providerCommandPreview(config).then(result => {
      if (previewRequestRef.current !== request) return;
      setRawPreview(result);
      setPreviewError('');
    }).catch(cause => {
      if (previewRequestRef.current !== request) return;
      setRawPreview(null);
      setPreviewError(normalizeDisplayText(errorMessage(cause)));
    }).finally(() => {
      if (previewRequestRef.current === request) setPreviewLoading(false);
    });
    return () => { previewRequestRef.current += 1; };
  }, [previewOpen, active, nativeAvailable, runtimeNeeded, config, previewRevision]);
  const waitingForMaskSchema = !llama && schema.pending && !schema.error;
  const maskedPreview = rawPreview && !waitingForMaskSchema ? (() => {
    const view = schema.view;
    if (!view) return rawPreview;
    const providerValues = config.provider_options?.[provider] ?? {};
    const entrySecrets = sensitiveEntryTokenStrings(view);
    const mask = (argv: string[]) => maskPreview(argv, view.schema, providerValues, entrySecrets);
    return {
      ...rawPreview,
      argv: mask(rawPreview.argv),
      engine_argv: rawPreview.engine_argv && mask(rawPreview.engine_argv),
    };
  })() : null;
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
  // The profile and engine identity stay in view; launch options and the host
  // hardware they run on are one keyboard-reachable disclosure away.
  return <section className="performance-environment" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="performance-column-title">{copy.title}</h3>
    <dl className="performance-environment-overview">
      <div><dt>{copy.profile}</dt><dd>{normalizeDisplayText(profileName)}</dd></div>
      <div><dt>{providerCopy[locale].engine}</dt><dd>{providerDisplayName(provider)}</dd></div>
      <div><dt>{copy.runtime}</dt><dd>{llama ? config.active_backend ? `${config.active_backend} · ${runtimeVersionLabel(runtimes, config.active_backend, config.active_build)}` : copy.unknown : <RuntimeSelectionLabel config={config} />}</dd></div>
    </dl>
    <details className="performance-environment-disclosure">
      <summary>{copy.settings}</summary>
      <div className="performance-environment-disclosure-body">
        <p className="performance-hint">{copy.profileHint}</p>
        {llama ? <dl className="performance-environment-settings">
          <div><dt>{copy.context}</dt><dd>{usesRuntimeDefault(config, 'ctx_size') ? copy.automatic : config.ctx_size}</dd></div>
          <div><dt>{copy.parallel}</dt><dd>{usesRuntimeDefault(config, 'parallel') ? copy.automatic : config.parallel}</dd></div>
          <div><dt>{copy.gpuLayers}</dt><dd>{value('ngl')}</dd></div>
          <div><dt>{copy.threads}</dt><dd>{value('threads')}</dd></div>
          <div><dt>{copy.batch}</dt><dd>{value('batch_size')} / {value('ubatch_size')}</dd></div>
          <div><dt>{copy.cache}</dt><dd>{value('cache_type_k')} / {value('cache_type_v')}</dd></div>
          <div><dt>{copy.flash}</dt><dd>{value('flash_attn')}</dd></div>
        </dl> : <RuntimeProfileValues settings={config} provider={provider} schema={schema} config={config} disabled={!active || busy} mode="current" showRuntime={false} onRuntimeVerified={onRuntimeVerified} />}
      </div>
    </details>
    <details className="performance-environment-disclosure">
      <summary>{copy.hardware}</summary>
      <div className="performance-environment-disclosure-body">
        <p className="performance-hint">{copy.hostHint}</p>
        <dl className="performance-environment-hardware">
          <div><dt>{copy.gpu}</dt><dd className="performance-environment-devices">{!llama ? copy.automaticGpu : cpuOnly ? copy.cpuOnly : <>{!ids.length && <span>{copy.automaticGpu}</span>}{devices}{draftCpu && <span>{copy.cpuOnly} · {copy.draft}</span>}</>}</dd></div>
          <div><dt>{copy.system}</dt><dd>{cpu ? <>{normalizeDisplayText(cpu.name)}<small>{formatCpuCores(cpu)}{typeof ram === 'number' && ram > 0 ? ` · ${formatBytes(ram)} RAM` : ''}</small></> : copy.unknown}</dd></div>
        </dl>
      </div>
    </details>
    {nativeAvailable && (
      <details className="performance-environment-disclosure" open={previewOpen} onToggle={event => setPreviewOpen(event.currentTarget.open)}>
        <summary>{providerCopy[locale].preview}</summary>
        <div className="performance-environment-disclosure-body">
          {runtimeNeeded ? (
            <p className="app-section-hint">{providerCopy[locale].choose}</p>
          ) : (previewLoading || waitingForMaskSchema) && !maskedPreview ? (
            <p role="status" className="app-section-hint">{providerCopy[locale].loading}</p>
          ) : previewError ? (
            <FeedbackBanner
              tone="error"
              action={{
                label: modelActions(locale).retry,
                disabled: previewLoading || busy,
                onClick: () => setPreviewRevision(value => value + 1),
              }}
            >
              {previewError}
            </FeedbackBanner>
          ) : maskedPreview ? (
            <CommandLineViewer
              argv={maskedPreview.argv}
              engineArgv={maskedPreview.engine_argv}
              blocked={maskedPreview.launch_blocked}
              context="preview"
              framed={false}
              labels={commandToolsCopy[locale]}
              commandKind={commandKind}
              onCommandKindChange={setCommandKind}
              syntax={copySyntax}
              onSyntaxChange={setCopySyntax}
              multiline={multiline}
              onMultilineChange={setMultiline}
            />
          ) : null}
        </div>
      </details>
    )}
  </section>;
}
