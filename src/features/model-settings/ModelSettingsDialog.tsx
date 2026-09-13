import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api';
import { executionConfig, executionSettings, serverSettingsChanged, type ExecutionSettings } from '../../shared/config/executionSettings';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import { useI18n } from '../../shared/i18n/i18n';
import { executionText } from '../../shared/i18n/executionI18n';
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { CustomSelect, OverlayContainerContext } from '../../shared/ui/CustomSelect';
import { previewExecution } from '../models/modelExecutionState';
import { useServerOptions } from '../tuning/useServerOptions';
import DraftTuningEditor from './DraftTuningEditor';
import DraftGpuEditor from './DraftGpuEditor';
import DraftAdvancedEditor from './DraftAdvancedEditor';
import SettingsProfileControl from './SettingsProfileControl';
import { useProfileEditor } from './useProfileEditor';
import { appliedProfile, SettingsDeliveryError, type ProfileEditorResult, type ProfileCommitResult } from './profileEditor';
import { defaultSettingsProfileEntry, profileDeletionReason, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { resetProfileSettings } from './profileResetState';
import { profileStatusCopy } from './profileStatusCopy';
import { useModelCatalog } from './useModelCatalog';
import { modelSettingsCopy } from './modelSettingsCopy';
import { modelSettingsHelp } from './modelSettingsHelp';
import './model-settings.css';

export interface ModelSettingsDialogProps {
  open: boolean; initialConfig: api.AppConfig; targetLabel: string;
  mode: 'default' | 'session' | 'benchmark' | 'project'; initialSection?: string;
  onApply: (cfg: api.AppConfig, intent: 'save' | 'start', profiles: ProfileEditorResult) => Promise<void>;
  onProfileCommit: (cfg: api.AppConfig, edit: ProfileEditorResult, applyTarget: boolean) => Promise<ProfileCommitResult>;
  onReloadProfile: (modelPath: string) => Promise<ProfileCommitResult>;
  onClose: () => void; onManageRuntimes?: (draft?: api.AppConfig) => void;
  busy?: boolean; liveState?: string;
  liveConfig?: api.AppConfig;
  initialApplication?: ProfileApplication; liveApplication?: ProfileApplication; sessionId?: string;
  requireModelSelection?: boolean;
  executionNotice?: ReactNode; onCancelStart?: () => void;
}

const normalizeSection = (section = 'model') => ({ setup: 'runtime', gpu: 'runtime', lora: 'adapters', server: 'tuning', options: 'advanced', escape: 'advanced' }[section] ?? section);

/** A target-scoped editor. No configuration or model-profile writes happen on preview. */
export function ModelSettingsDialog({ open, initialConfig, targetLabel, mode, initialSection, onApply, onProfileCommit, onReloadProfile, onClose, onManageRuntimes,
  busy = false, liveState, liveConfig, initialApplication, liveApplication, sessionId = 'default', executionNotice, onCancelStart, requireModelSelection = false }: ModelSettingsDialogProps) {
  const { t, locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const help = modelSettingsHelp[locale];
  const profileCopy = profileStatusCopy[locale];
  const id = useId();
  const saved = useRef(structuredClone(initialConfig));
  const initial = useRef({ ...saved.current, ...(requireModelSelection ? { active_model: '' } : {}) });
  const [baseline, setBaseline] = useState(() => executionSettings(initial.current));
  const [settings, setSettings] = useState<ExecutionSettings>(() => executionSettings(initial.current));
  const cfg = executionConfig(initialConfig, settings);
  const latest = useRef(cfg); latest.current = cfg;
  const [section, setSection] = useState(normalizeSection(initialSection));
  const [query, setQuery] = useState('');
  const [pathDraft, setPathDraft] = useState(initial.current.active_model);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const applyLock = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [profileDirty, setProfileDirty] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [tuningRevision, setTuningRevision] = useState(0);
  const [resources, setResources] = useState<{ runtimes: api.InstalledRuntime[]; device: api.DeviceReport | null }>({ runtimes: [], device: null });
  const [resourceError, setResourceError] = useState('');
  const [resourceRevision, setResourceRevision] = useState(0);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const invoker = useRef<HTMLElement | null>(null);
  const runtime = useServerOptions(cfg.active_backend, cfg.active_build, open);
  const catalog = useModelCatalog(initialConfig.models_dir, open);
  const disabled = busy || applying;
  const benchmark = mode === 'benchmark';
  const profiles = useProfileEditor(initialConfig, cfg, initialApplication ?? appliedProfile(initialConfig, sessionId), benchmark, entry => profileDisplayName(entry, locale));
  const running = liveState === 'running' && (mode === 'default' || mode === 'session');
  const serverChanged = running && serverSettingsChanged(liveConfig ?? initial.current, cfg);
  const startText = running ? (liveConfig ?? initial.current).active_model === cfg.active_model ? copy.restart : copy.switchStart : copy.start;
  const stateText = liveState && ['stopped', 'starting', 'stopping', 'running', 'failed', 'crashed'].includes(liveState) ? executionText[locale][liveState as 'running'] : liveState;
  const valuesDirty = cfg.active_model !== initial.current.active_model || !settingsEqual(settings, executionSettings(initial.current));
  const dirty = valuesDirty || invalid.size > 0 || profileDirty || profiles.working || pathDraft !== cfg.active_model;
  const liveMatches = running && !!liveConfig && cfg.active_model === liveConfig.active_model && settingsEqual(settings, executionSettings(liveConfig)) && profiles.systemPrompt === (liveApplication?.system_prompt ?? '');
  const profileItems = profiles.available.map(entry => {
      const deletionReason = profileDeletionReason(profiles.library, entry.id);
      return { ...entry, name: profileDisplayName(entry, locale), deletable: !deletionReason, deletionReason };
    });
  const displayId = profiles.selected.id;
  const saveTarget = copy.saveTarget.replace('{name}', profileDisplayName(profiles.selected, locale));
  const working = profiles.working || invalid.size > 0;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const pathPending = pathDraft.trim() !== cfg.active_model;
  const currentConfig = useRef(initialConfig); currentConfig.current = initialConfig;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setResourceError('');
    void Promise.all([api.rtList(), api.deviceProfile()]).then(([runtimes, device]) => { if (active) setResources({ runtimes, device }); })
      .catch(cause => { if (active) setResourceError(String(cause)); });
    return () => { active = false; };
  }, [open, resourceRevision]);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open) {
      if (!element.open) { invoker.current = document.activeElement as HTMLElement | null; element.showModal(); }
      requestAnimationFrame(() => heading.current?.focus());
    } else if (element.open) { element.close(); invoker.current?.focus(); }
  }, [open]);
  useEffect(() => { const element = dialog.current; return () => { if (element?.open) element.close(); invoker.current?.focus(); }; }, []);
  useEffect(() => { if (pending) dialog.current?.querySelector<HTMLButtonElement>('.model-settings-footer .model-settings-confirm button')?.focus(); }, [pending]);
  const setFieldInvalid = useCallback((key: string, value: boolean) => { setInvalid(previous => {
    if (previous.has(key) === value) return previous;
    const next = new Set(previous); if (value) next.add(key); else next.delete(key); return next;
  }); }, []);
  const change = (patch: Partial<api.AppConfig>) => {
    if (disabled || applyLock.current) return;
    setSettings(previous => {
      const current = executionConfig(currentConfig.current, previous);
      return executionSettings({ ...current, ...withManualOverrides(current, patch) });
    });
    setError('');
  };
  const guarded = (action: () => void) => { if (disabled) return; if (dirtyRef.current) setPending(() => action); else action(); };
  const chooseModel = (path: string) => {
    if (!path.trim() || path === cfg.active_model) return;
    const load = () => {
      try {
        const restored = previewExecution(saved.current, path);
        const next = executionSettings({ ...initial.current, ...restored, active_model: path,
          mmproj: restored.mmproj ?? '', spec_draft_model: restored.spec_draft_model ?? '', lora_adapters: restored.lora_adapters ?? [],
          ...(mode === 'session' ? { gpu: initial.current.gpu } : {}) });
        const assigned = executionSettings(profiles.resetModel(executionConfig(initial.current, next), sessionId));
        setSettings(assigned); setBaseline(assigned); setPathDraft(path); setInvalid(new Set()); setProfileDirty(false); setEditorRevision(value => value + 1); setError('');
      } catch (cause) { setError(String(cause)); }
    };
    if (!settingsEqual(settings, baseline) || invalid.size || profileDirty || profiles.working) setPending(() => load); else load();
  };
  const accept = ({ config, application }: ProfileCommitResult) => {
    saved.current = structuredClone(config); initial.current = structuredClone(config);
    setSettings(executionSettings(config)); setBaseline(executionSettings(config)); setPathDraft(config.active_model);
    profiles.acceptSaved(config, application); setInvalid(new Set()); setProfileDirty(false); setEditorRevision(value => value + 1);
  };
  const acceptMetadata = ({ config, application }: ProfileCommitResult) => {
    saved.current = structuredClone(config); initial.current = structuredClone(config);
    setBaseline(executionSettings(config)); profiles.acceptMetadata(config, application);
  };
  const resetProfile = () => {
    if (disabled || applyLock.current) return false;
    const defaults = resetProfileSettings(cfg, benchmark);
    const changed = !settingsEqual(cfg, defaults) || (!benchmark && profiles.systemPrompt !== '') || invalid.size > 0 || pathPending;
    setSettings(executionSettings(defaults));
    if (!benchmark) profiles.setSystemPrompt('');
    setInvalid(new Set()); setPathDraft(cfg.active_model); setEditorRevision(value => value + 1); setError('');
    return changed;
  };
  const commitProfile = async (prepare: () => ReturnType<typeof profiles.prepareApply>, preserveDraft = false) => {
    if (disabled || applyLock.current) return;
    applyLock.current = true; setApplying(true); setError('');
    try {
      const next = prepare();
      const result = await onProfileCommit(next.config, next.edit, next.applyTarget);
      if (preserveDraft) acceptMetadata(result); else accept(result);
    } catch (cause) {
      if (cause instanceof SettingsDeliveryError) {
        const result = { config: cause.saved, application: cause.application };
        if (preserveDraft) acceptMetadata(result); else accept(result);
        setError(profileCopy.savedFailure + cause.message); return;
      }
      setError(String(cause));
      throw cause;
    } finally { applyLock.current = false; setApplying(false); }
  };
  const revertProfile = async () => {
    if (disabled || applyLock.current) return;
    applyLock.current = true; setApplying(true); setError('');
    try { accept(await onReloadProfile(cfg.active_model)); }
    catch (cause) { setError(String(cause)); throw cause; }
    finally { applyLock.current = false; setApplying(false); }
  };
  const apply = async (intent: 'save' | 'start') => {
    if (disabled || applyLock.current || invalid.size || profileDirty || pathPending || !cfg.active_model.trim()) return;
    if (intent === 'save') {
      await commitProfile(() => ({ config: structuredClone(latest.current), edit: profiles.result(), applyTarget: true })).catch(() => undefined);
      return;
    }
    applyLock.current = true; setApplying(true); setError('');
    try { await onApply(structuredClone(latest.current), intent, profiles.result()); setBaseline(executionSettings(latest.current)); onClose(); }
    catch (cause) {
      if (cause instanceof SettingsDeliveryError) {
        saved.current = structuredClone(cause.saved); initial.current = structuredClone(cause.saved);
        setSettings(executionSettings(cause.saved)); setBaseline(executionSettings(cause.saved));
        profiles.acceptSaved(cause.saved, cause.application);
        setError(profileCopy.savedFailure + cause.message);
      } else setError(String(cause));
    }
    finally { applyLock.current = false; setApplying(false); }
  };
  const runtimeMissing = !!cfg.active_backend && !resources.runtimes.some(item => item.backend === cfg.active_backend && item.build === cfg.active_build);
  const devices = runtime.capabilities ? runtimeGpuDevices(cfg.active_backend, runtime.capabilities.devices) : [];
  const device = resources.device && cfg.active_backend ? { ...resources.device, profile: { ...resources.device.profile, gpus: devices } } : resources.device;
  const sections = (['model', 'profiles', 'runtime', 'tuning', 'sampling', 'reasoning', 'adapters', 'advanced'] as const).filter(value => !benchmark || !['sampling', 'reasoning'].includes(value));
  const models = catalog.models.filter(model => !model.is_vision && `${model.name} ${normalizeDisplayPath(model.path)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = catalog.models.find(model => model.path === cfg.active_model);
  const incomplete = !!selected?.shards?.missing.length;
  const editorKey = `${cfg.active_model}:${editorRevision}`;
  const sidecar = (key: 'mmproj' | 'spec_draft_model', label: string, vision: boolean) => <label>{label}
    <CustomSelect ariaLabel={label} ariaDescribedBy={`${id}-${key}-help`} value={cfg[key]} disabled={disabled} options={[{ value: '', label: copy.none }, ...catalog.models.filter(model => model.is_vision === vision).map(model => ({ value: model.path, label: model.name, disabled: !!model.shards?.missing.length })),
      ...(cfg[key] && !catalog.models.some(model => model.path === cfg[key]) ? [{ value: cfg[key], label: modelDisplayName(cfg[key]) }] : [])]} onChange={value => change({ [key]: value })} />
    <input className="app-input" aria-label={`${label} — ${copy.path}`} aria-describedby={`${id}-${key}-help`} value={cfg[key]} disabled={disabled} onChange={event => change({ [key]: event.target.value })} />
    <span id={`${id}-${key}-help`} className="app-section-hint">{vision ? help.projector : help.draftModel}</span>
  </label>;
  return <dialog ref={dialog} className="model-settings-dialog" aria-labelledby={`${id}-title`} aria-busy={disabled || undefined}
    onKeyDown={event => {
      if (event.key !== 'Tab') return;
      const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])'))
        .filter(element => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden');
      const first = controls[0]; const last = controls.at(-1);
      if (!first || !last) { event.preventDefault(); heading.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === heading.current)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}
    onCancel={event => { event.preventDefault(); if (!disabled) { if (pending) setPending(null); else guarded(onClose); } }}>
    <OverlayContainerContext.Provider value={overlay}>
      <div className="model-settings-shell">
        <header className="model-settings-header"><div><span className="app-eyebrow">{targetLabel}{stateText ? ` · ${stateText}` : ''}</span><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{copy.title}</h2><p title={normalizeDisplayPath(cfg.active_model)}>{cfg.active_model ? modelDisplayName(cfg.active_model) : copy.model}</p></div>
          <button type="button" className="app-button app-button--ghost" aria-label={copy.close} disabled={disabled} onClick={() => guarded(onClose)}>×</button></header>
        <div className="model-settings-layout" inert={!!pending || disabled}>
          <nav className="model-settings-nav" aria-label={copy.title}>{sections.map(value => <button type="button" key={value} className={section === value ? 'is-active' : ''} aria-current={section === value ? 'page' : undefined} onClick={() => setSection(value)}>{copy[value]}</button>)}</nav>
          <div className="model-settings-body">
            <SettingsProfileControl items={profileItems} state={working ? 'working' : 'named'} activeId={displayId} basedOnId={working ? displayId : null}
              defaultProfileId={defaultSettingsProfileEntry(profiles.library).id} onSetDefault={id => commitProfile(() => profiles.prepareSetDefault(id), true)}
              modelPath={cfg.active_model} currentSettings={settings} currentPrompt={profiles.systemPrompt} defaults={{ ...executionSettings(resetProfileSettings(cfg, false)), runtime_defaults: [] }} full={section === 'profiles'}
              disabled={disabled} blocked={invalid.size > 0 || pathPending} onEditingChange={setProfileDirty}
              onApply={id => commitProfile(() => { const profile = profiles.available.find(item => item.id === id); if (!profile) throw new Error('This profile is no longer available.'); return profiles.prepareApply(profile); })}
              onSaveAs={(name, scope) => commitProfile(() => profiles.prepareSaveAs(name, scope))}
              onRename={(id, name) => commitProfile(() => profiles.prepareRename(id, name))} onDelete={id => commitProfile(() => profiles.prepareDelete(id))} onRevert={revertProfile} onReset={resetProfile}
              saveAction={<><span id={`${id}-save-target`} className="sr-only">{saveTarget}</span><button type="button" className="app-button app-button--primary app-button--sm" aria-describedby={`${id}-save-target`} disabled={disabled || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim()} onClick={() => void apply('save')}>{applying ? copy.pending : copy.save}</button></>}>
            {running && !liveMatches && <p className="model-settings-profile-status">{serverChanged ? profileCopy.next : profileCopy.request}</p>}
            {benchmark && <p className="model-settings-scope">{copy.benchmarkControlled}</p>}
            <div hidden={section !== 'model'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.model}</h3><button type="button" className="app-button app-button--ghost app-button--sm" onClick={catalog.refresh}>{copy.refresh}</button></div>
              <p id={`${id}-model-help`} className="app-section-hint">{help.model}</p>
              <input type="search" className="app-input" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy.search} aria-label={copy.search} />
              {catalog.error && <p className="text-error" role="alert">{normalizeDisplayText(catalog.error)}</p>}
              {catalog.loading && <p role="status">{t('extra.loading')}</p>}
              {catalog.truncated && <p role="status">{copy.truncated}</p>}
              <ul className="model-settings-models" onKeyDown={event => {
                if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
                const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
                const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
                event.preventDefault(); buttons[next]?.focus();
              }}>{models.map(model => <li key={model.path}><button type="button" className={cfg.active_model === model.path ? 'is-selected' : ''} disabled={!!model.shards?.missing.length}
                onClick={() => chooseModel(model.path)} aria-describedby={`${id}-model-help`} aria-pressed={cfg.active_model === model.path} title={normalizeDisplayPath(model.path)}><span><strong>{normalizeDisplayText(model.name)}</strong><small>{model.size_mb.toLocaleString(locale, { maximumFractionDigits: 0 })} MB{model.shards?.missing.length ? ` · ${t('ui.modelShardsMissing', { count: model.shards.missing.length, total: model.shards.total })}` : ''}</small></span>{cfg.active_model === model.path && <span>{copy.selected}</span>}</button></li>)}</ul>
              {!catalog.loading && !models.length && <p className="app-section-hint">{copy.empty}</p>}
              <label>{copy.path}<input className="app-input" aria-label={copy.path} aria-describedby={`${id}-path-help`} value={pathDraft} onChange={event => setPathDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); chooseModel(pathDraft.trim()); } }} /><span id={`${id}-path-help`} className="app-section-hint">{help.path}</span></label>
              {pathDraft.trim() !== cfg.active_model && <button type="button" className="app-button app-button--secondary" disabled={!pathDraft.trim()} onClick={() => chooseModel(pathDraft.trim())}>{copy.load}</button>}
            </div>
            <div hidden={section !== 'runtime'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.runtime}</h3>{onManageRuntimes && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => onManageRuntimes(structuredClone(cfg))}>{copy.manageRuntime}</button>}</div>
              <label>{copy.runtime}<CustomSelect ariaLabel={copy.runtime} ariaDescribedBy={`${id}-runtime-help`} value={`${cfg.active_backend}/${cfg.active_build}`} options={[{ value: '/', label: copy.systemRuntime }, ...resources.runtimes.map(item => ({ value: `${item.backend}/${item.build}`, label: `${item.backend} · ${item.build}` })), ...(runtimeMissing ? [{ value: `${cfg.active_backend}/${cfg.active_build}`, label: `${cfg.active_backend} · ${cfg.active_build}` }] : [])]}
                onChange={value => { const item = resources.runtimes.find(item => item.backend + '/' + item.build === value); change({ active_backend: item?.backend ?? '', active_build: item?.build ?? '' }); }} /><span id={`${id}-runtime-help`} className="app-section-hint">{help.runtime}</span></label>
              {runtimeMissing && <p className="text-warning" role="status">{copy.missingRuntime}</p>}
              {(resourceError || runtime.error) && <div><p className="text-warning" role="status">{normalizeDisplayText(resourceError || runtime.error || '')}</p><button type="button" className="app-button app-button--secondary" onClick={() => { setResourceRevision(value => value + 1); runtime.refresh(); }}>{copy.refresh}</button></div>}
              <DraftGpuEditor key={editorKey} placement={cfg.gpu} device={device} disabled={disabled || runtime.loading} onChange={gpu => change({ gpu })} onInvalid={setFieldInvalid} />
            </div>
            <div hidden={!['tuning', 'sampling', 'reasoning', 'adapters'].includes(section)}>
              {!benchmark && section === 'sampling' && <div className="model-settings-prompt"><label htmlFor={`${id}-system-prompt`}>{profileCopy.prompt}</label><textarea id={`${id}-system-prompt`} aria-describedby={`${id}-prompt-hint`} className="app-textarea" value={profiles.systemPrompt} disabled={disabled} rows={3} onChange={event => profiles.setSystemPrompt(event.target.value)} /><small id={`${id}-prompt-hint`}>{profileCopy.promptHint}</small></div>}
              <div hidden={section !== 'adapters'} className="model-settings-fields">
                {sidecar('mmproj', copy.projector, true)}{sidecar('spec_draft_model', copy.draftModel, false)}
                <h3>LoRA</h3><p id={`${id}-lora-help`} className="app-section-hint">{help.loraPath}</p>
                {cfg.lora_adapters.map((adapter, index) => <div key={adapter.path} className="model-settings-lora"><strong title={normalizeDisplayPath(adapter.path)}>{modelDisplayName(adapter.path)}</strong><label>{copy.enabled}<input type="checkbox" aria-describedby={`${id}-lora-enabled-help`} checked={adapter.enabled} onChange={event => change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })} /></label>
                  <label>{copy.scale}<input className="app-input" aria-describedby={`${id}-lora-scale-help`} type="number" min="0" max="4" step="0.05" value={adapter.scale} onChange={event => { const scale = Number(event.target.value); if (Number.isFinite(scale) && scale >= 0 && scale <= 4) change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, scale } : item) }); }} /></label>
                  <button type="button" className="app-button app-button--ghost" onClick={() => change({ lora_adapters: cfg.lora_adapters.filter((_, i) => i !== index) })}>{copy.remove}</button></div>)}
                {cfg.lora_adapters.length > 0 && <div className="app-section-hint"><p id={`${id}-lora-enabled-help`}>{help.loraEnabled}</p><p id={`${id}-lora-scale-help`}>{help.loraScale}</p></div>}
                <button type="button" className="app-button app-button--secondary" aria-describedby={`${id}-lora-help`} onClick={() => void api.pickLoraAdapter().then(path => { if (path) change({ lora_adapters: [...latest.current.lora_adapters.filter(item => item.path !== path), { path, enabled: true, scale: 1 }] }); }).catch(cause => setError(String(cause)))}>{copy.addLora}</button>
              </div>
              <DraftTuningEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} section={section} disabled={disabled} benchmark={benchmark} runtime={runtime} onChange={change} onInvalid={setFieldInvalid}
                onResetDrafts={() => { setTuningRevision(value => value + 1); setInvalid(previous => new Set([...previous].filter(key => key.startsWith('gpu_')))); }} />
            </div>
            <div hidden={section !== 'advanced'}><DraftAdvancedEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} options={runtime.options} disabled={disabled} benchmark={benchmark} onChange={change} onInvalid={setFieldInvalid} /></div>
            </SettingsProfileControl>
          </div>
        </div>
        <footer className="model-settings-footer">
          {pending ? <div className="model-settings-confirm" role="alert"><strong>{copy.discardTitle}</strong><p>{copy.discardBody}</p><div><button type="button" className="app-button app-button--secondary" onClick={() => setPending(null)}>{copy.keep}</button><button type="button" className="app-button app-button--danger" onClick={() => { const action = pending; setPending(null); action(); }}>{copy.discard}</button></div></div>
            : <><div className="model-settings-notices">{profileDirty && <p role="status">{copy.profilePending}</p>}{pathPending && <p role="status">{copy.pathPending}</p>}{executionNotice}{error && <p className="text-error" role="alert">{normalizeDisplayText(error)}</p>}{invalid.size > 0 && <p className="text-error" role="alert">{copy.invalid} ({[...invalid].join(', ')})</p>}{incomplete && <p className="text-error">{t('ui.modelShardsMissing', { count: selected!.shards!.missing.length, total: selected!.shards!.total })}</p>}</div>
              <div className="model-settings-actions">
                {!benchmark && mode !== 'project' && <button type="button" className="app-button app-button--primary" disabled={disabled || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim() || incomplete || runtimeMissing} onClick={() => void apply('start')}>{startText}</button>}
                {disabled && onCancelStart && <button type="button" className="app-button app-button--secondary" onClick={onCancelStart}>{copy.cancel}</button>}
              </div></>}
        </footer>
      </div>
      <div ref={setOverlay} className="model-settings-overlays" inert={disabled || !!pending} />
    </OverlayContainerContext.Provider>
  </dialog>;
}
export default ModelSettingsDialog;
