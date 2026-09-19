import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api';
import { executionConfig, executionSettings, serverSettingsChanged, type ExecutionSettings } from '../../shared/config/executionSettings';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import { useI18n, type Locale } from '../../shared/i18n/i18n';
import { executionText } from '../../shared/i18n/executionI18n';
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText, restoreDisplayPath } from '../../shared/lib/displayPaths';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { CustomSelect, OverlayContainerContext } from '../../shared/ui/CustomSelect';
import { previewExecution } from '../models/modelExecutionState';
import { useServerOptions } from '../tuning/useServerOptions';
import DraftTuningEditor from './DraftTuningEditor';
import DraftGpuEditor from './DraftGpuEditor';
import DraftAdvancedEditor from './DraftAdvancedEditor';
import SettingsPasteBox from './SettingsPasteBox';
import SettingsProfileControl from './SettingsProfileControl';
import SettingsChangeList, { changeCount } from './SettingsChangeList';
import { useProfileEditor } from './useProfileEditor';
import { appliedProfile, SettingsDeliveryError, type ProfileEditorResult, type ProfileCommitResult } from './profileEditor';
import { defaultSettingsProfileEntry, profileDeletionReason, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { resetProfileSettings } from './profileResetState';
import { describeLaunchFailure, profileStatusCopy } from './profileStatusCopy';
import { useModelCatalog } from './useModelCatalog';
import { useModelContextLimit } from './useModelContextLimit';
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
  /** Stops this target. Offered in place of a launch while the model is up. */
  onStop?: () => void;
}

const normalizeSection = (section = 'model') => ({ setup: 'runtime', gpu: 'runtime', lora: 'adapters', server: 'tuning', options: 'advanced', escape: 'advanced' }[section] ?? section);

/** A target-scoped editor. No configuration or model-profile writes happen on preview. */
export function ModelSettingsDialog({ open, initialConfig, targetLabel, mode, initialSection, onApply, onProfileCommit, onReloadProfile, onClose, onManageRuntimes,
  busy = false, liveState, liveConfig, initialApplication, liveApplication, sessionId = 'default', executionNotice, onCancelStart, onStop, requireModelSelection = false }: ModelSettingsDialogProps) {
  const { t, locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const help = modelSettingsHelp[locale];
  const profileCopy = profileStatusCopy[locale];
  const id = useId();
  const saved = useRef(structuredClone(initialConfig));
  const initial = useRef({ ...saved.current, ...(requireModelSelection ? { active_model: '' } : {}) });
  const [baseline, setBaseline] = useState(() => executionSettings(initial.current));
  const [settings, setSettings] = useState<ExecutionSettings>(() => executionSettings(initial.current));
  const cfg = useMemo(() => executionConfig(initialConfig, settings), [initialConfig, settings]);
  const latest = useRef(cfg); latest.current = cfg;
  const [section, setSection] = useState(normalizeSection(initialSection));
  const body = useRef<HTMLDivElement>(null);
  // Sections are tall; arriving at one part-scrolled from the last shows its
  // middle, which reads as a half-rendered panel.
  const showSection = (value: string) => { setSection(value); body.current?.scrollTo({ top: 0 }); };
  const [query, setQuery] = useState('');
  const [pathDraft, setPathDraft] = useState(normalizeDisplayPath(initial.current.active_model));
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const applyLock = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  // A profile is a wide snapshot, and the editor gives no sense of how much of it
  // an edit touched. Pressing save shows what it would rewrite, from and to, and
  // waits: overwriting a profile is not undoable from here.
  const [confirmSave, setConfirmSave] = useState(false);
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
  const contextLimit = useModelContextLimit(cfg.active_model, open);
  const disabled = busy || applying;
  const benchmark = mode === 'benchmark';
  const profiles = useProfileEditor(initialConfig, cfg, initialApplication ?? appliedProfile(initialConfig, sessionId), benchmark, entry => profileDisplayName(entry, locale));
  const running = liveState === 'running' && (mode === 'default' || mode === 'session');
  // This target holds a server process right now, loading one, or shutting one
  // down. Launching again from here would race that process, so the footer
  // offers the only move that makes sense on a live target: stopping it.
  const live = (mode === 'default' || mode === 'session') && ['running', 'starting', 'stopping'].includes(liveState ?? '');
  const serverChanged = running && serverSettingsChanged(liveConfig ?? initial.current, cfg);
  const startText = running ? (liveConfig ?? initial.current).active_model === cfg.active_model ? copy.restart : copy.switchStart : copy.start;
  const stateText = liveState && ['stopped', 'starting', 'stopping', 'running', 'failed', 'crashed'].includes(liveState) ? executionText[locale][liveState as 'running'] : liveState;
  const valuesDirty = cfg.active_model !== initial.current.active_model || !settingsEqual(settings, executionSettings(initial.current));
  const enteredPath = restoreDisplayPath(cfg.active_model, pathDraft.trim());
  const dirty = valuesDirty || invalid.size > 0 || profileDirty || profiles.working || enteredPath !== cfg.active_model;
  const liveMatches = running && !!liveConfig && cfg.active_model === liveConfig.active_model && settingsEqual(settings, executionSettings(liveConfig)) && profiles.systemPrompt === (liveApplication?.system_prompt ?? '');
  const profileItems = profiles.available.map(entry => {
      const deletionReason = profileDeletionReason(profiles.library, entry.id);
      return { ...entry, name: profileDisplayName(entry, locale), deletable: !deletionReason, deletionReason };
    });
  const displayId = profiles.selected.id;
  // The live process was launched from this profile's settings. Overwriting it
  // would leave the profile describing something the running server is not, so
  // editing stays open and only the save onto that profile is withheld.
  const profileInUse = live && !!liveApplication?.profile_id && displayId === liveApplication.profile_id;
  const saveTarget = copy.saveTarget.replace('{name}', profileDisplayName(profiles.selected, locale));
  const working = profiles.working || invalid.size > 0;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const pathPending = enteredPath !== cfg.active_model;
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
  useEffect(() => { if (pending || confirmSave) dialog.current?.querySelector<HTMLButtonElement>('.model-settings-footer .model-settings-confirm button')?.focus(); }, [pending, confirmSave]);
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
        setSettings(assigned); setBaseline(assigned); setPathDraft(normalizeDisplayPath(path)); setInvalid(new Set()); setProfileDirty(false); setEditorRevision(value => value + 1); setError('');
      } catch (cause) { setError(String(cause)); }
    };
    if (!settingsEqual(settings, baseline) || invalid.size || profileDirty || profiles.working) setPending(() => load); else load();
  };
  const accept = ({ config, application }: ProfileCommitResult) => {
    saved.current = structuredClone(config); initial.current = structuredClone(config);
    setSettings(executionSettings(config)); setBaseline(executionSettings(config)); setPathDraft(normalizeDisplayPath(config.active_model));
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
    setInvalid(new Set()); setPathDraft(normalizeDisplayPath(cfg.active_model)); setEditorRevision(value => value + 1); setError('');
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
  // A probe of the previous runtime survives a backend switch until the new one
  // answers; its device list describes a backend that is no longer active.
  const devices = runtime.capabilities?.backend === cfg.active_backend ? runtimeGpuDevices(cfg.active_backend, runtime.capabilities.devices) : [];
  const device = resources.device && cfg.active_backend ? { ...resources.device, profile: { ...resources.device.profile, gpus: devices } } : resources.device;
  // Changing the runtime here leaves the placement naming devices from the
  // backend being left, which the new one does not answer to: it looked settled
  // and failed at launch. Once the new runtime reports its own devices the
  // selection is re-pointed at them, which is what the runtimes panel does when
  // the backend is switched there.
  const deviceKey = devices.map(item => item.stable_id).join('|');
  const deviceRef = useRef(devices); deviceRef.current = devices;
  useEffect(() => {
    const available = deviceRef.current;
    if (!available.length) return;
    const known = new Set(available.map(item => item.stable_id));
    const gpu = latest.current.gpu;
    if (!gpu?.gpu_ids.length || gpu.gpu_ids.every(id => known.has(id))) return;
    change({ gpu: { ...gpu, gpu_ids: available.map(item => item.stable_id!), main_gpu: null, tensor_split: [], draft_gpu_id: null } });
    // `change` is rebuilt each render and `devices` is a fresh array each time;
    // the identity of the reported device list is what this reacts to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceKey]);
  const sections = (['model', 'profiles', 'runtime', 'tuning', 'sampling', 'reasoning', 'adapters', 'advanced'] as const).filter(value => !benchmark || !['sampling', 'reasoning'].includes(value));
  const models = catalog.models.filter(model => !model.is_vision && `${model.name} ${normalizeDisplayPath(model.path)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = catalog.models.find(model => model.path === cfg.active_model);
  const incomplete = !!selected?.shards?.missing.length;
  const editorKey = `${cfg.active_model}:${editorRevision}`;
  const sidecar = (key: 'mmproj' | 'spec_draft_model', label: string, vision: boolean) => <label>{label}
    <CustomSelect ariaLabel={label} ariaDescribedBy={`${id}-${key}-help`} value={cfg[key]} disabled={disabled} options={[{ value: '', label: copy.none }, ...catalog.models.filter(model => model.is_vision === vision).map(model => ({ value: model.path, label: normalizeDisplayText(model.name), disabled: !!model.shards?.missing.length })),
      ...(cfg[key] && !catalog.models.some(model => model.path === cfg[key]) ? [{ value: cfg[key], label: modelDisplayName(cfg[key]) }] : [])]} onChange={value => change({ [key]: value })} />
    <input className="app-input" aria-label={`${label} — ${copy.path}`} aria-describedby={`${id}-${key}-help`} value={normalizeDisplayPath(cfg[key])} disabled={disabled} onChange={event => change({ [key]: restoreDisplayPath(cfg[key], event.target.value) })} />
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
    onCancel={event => { event.preventDefault(); if (!disabled) { if (confirmSave) setConfirmSave(false); else if (pending) setPending(null); else guarded(onClose); } }}>
    <OverlayContainerContext.Provider value={overlay}>
      <div className="model-settings-shell">
        <header className="model-settings-header"><div><span className="app-eyebrow">{targetLabel}{stateText ? ` · ${stateText}` : ''}</span><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{copy.title}</h2><p title={normalizeDisplayPath(cfg.active_model)}>{cfg.active_model ? modelDisplayName(cfg.active_model) : copy.model}</p></div>
          <button type="button" className="app-button app-button--ghost" aria-label={copy.close} disabled={disabled} onClick={() => guarded(onClose)}>×</button></header>
        <div className="model-settings-layout" inert={!!pending || confirmSave || disabled}>
          <nav className="model-settings-nav" aria-label={copy.title}>{sections.map(value => <button type="button" key={value} className={section === value ? 'is-active' : ''} aria-current={section === value ? 'page' : undefined} onClick={() => showSection(value)}>{copy[value]}</button>)}</nav>
          <div className="model-settings-body" ref={body}>
            <SettingsProfileControl items={profileItems} state={working ? 'working' : 'named'} activeId={displayId} basedOnId={working ? displayId : null}
              defaultProfileId={defaultSettingsProfileEntry(profiles.library).id} onSetDefault={id => commitProfile(() => profiles.prepareSetDefault(id), true)}
              modelPath={cfg.active_model} currentSettings={settings} currentPrompt={profiles.systemPrompt} defaults={{ ...executionSettings(resetProfileSettings(cfg, false)), runtime_defaults: [] }} full={section === 'profiles'}
              disabled={disabled} blocked={invalid.size > 0 || pathPending} onEditingChange={setProfileDirty}
              onApply={id => commitProfile(() => { const profile = profiles.available.find(item => item.id === id); if (!profile) throw new Error('This profile is no longer available.'); return profiles.prepareApply(profile); })}
              onSaveAs={(name, scope) => commitProfile(() => profiles.prepareSaveAs(name, scope))}
              onRename={(id, name) => commitProfile(() => profiles.prepareRename(id, name))} onDelete={id => commitProfile(() => profiles.prepareDelete(id))} onRevert={revertProfile} onReset={resetProfile}
              saveAction={<><span id={`${id}-save-target`} className="sr-only">{saveTarget}</span><button type="button" className="app-button app-button--primary app-button--sm" aria-describedby={`${id}-save-target`} disabled={disabled || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim() || profileInUse} onClick={() => setConfirmSave(true)}>{applying ? copy.pending : copy.save}</button></>}>
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
              <label>{copy.path}<input className="app-input" aria-label={copy.path} aria-describedby={`${id}-path-help`} value={pathDraft} onChange={event => setPathDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); chooseModel(enteredPath); } }} /><span id={`${id}-path-help`} className="app-section-hint">{help.path}</span></label>
              {pathPending && <button type="button" className="app-button app-button--secondary" disabled={!pathDraft.trim()} onClick={() => chooseModel(enteredPath)}>{copy.load}</button>}
            </div>
            <div hidden={section !== 'runtime'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.runtime}</h3>{onManageRuntimes && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => onManageRuntimes(structuredClone(cfg))}>{copy.manageRuntime}</button>}</div>
              <label>{copy.runtime}<CustomSelect ariaLabel={copy.runtime} ariaDescribedBy={`${id}-runtime-help`} value={`${cfg.active_backend}/${cfg.active_build}`} options={[{ value: '/', label: copy.selectRuntime, disabled: true }, ...resources.runtimes.map(item => ({ value: `${item.backend}/${item.build}`, label: `${item.backend} · ${item.build}` })), ...(runtimeMissing ? [{ value: `${cfg.active_backend}/${cfg.active_build}`, label: `${cfg.active_backend} · ${cfg.active_build}` }] : [])]}
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
              <DraftTuningEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} section={section} disabled={disabled} benchmark={benchmark} runtime={runtime} contextLimit={contextLimit} onChange={change} onInvalid={setFieldInvalid}
                onResetDrafts={() => { setTuningRevision(value => value + 1); setInvalid(previous => new Set([...previous].filter(key => key.startsWith('gpu_')))); }} />
            </div>
            <div hidden={section !== 'advanced'}><SettingsPasteBox cfg={cfg} options={runtime.options} disabled={disabled} onChange={change} /><DraftAdvancedEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} options={runtime.options} disabled={disabled} benchmark={benchmark} onChange={change} onInvalid={setFieldInvalid} /></div>
            </SettingsProfileControl>
          </div>
        </div>
        <footer className="model-settings-footer">
          {confirmSave ? <div className="model-settings-confirm model-settings-confirm--save" role="alert">
            <strong>{copy.saveConfirmTitle.replace('{name}', profileDisplayName(profiles.selected, locale))}</strong>
            {changeCount(baseline, settings, profiles.savedApplication.system_prompt, profiles.systemPrompt) === 0
              ? <p>{copy.saveConfirmUnchanged}</p>
              : <SettingsChangeList saved={baseline} current={settings} savedPrompt={profiles.savedApplication.system_prompt} currentPrompt={profiles.systemPrompt} />}
            <div><button type="button" className="app-button app-button--secondary" onClick={() => setConfirmSave(false)}>{copy.cancel}</button>
              <button type="button" className="app-button app-button--primary" onClick={() => { setConfirmSave(false); void apply('save'); }}>{copy.saveConfirmAction}</button></div>
          </div>
          : pending ? <div className="model-settings-confirm" role="alert"><strong>{copy.discardTitle}</strong><p>{copy.discardBody}</p><div><button type="button" className="app-button app-button--secondary" onClick={() => setPending(null)}>{copy.keep}</button><button type="button" className="app-button app-button--danger" onClick={() => { const action = pending; setPending(null); action(); }}>{copy.discard}</button></div></div>
            : <><div className="model-settings-notices">{profileInUse && <p role="status">{copy.profileInUse}</p>}{profileDirty && <p role="status">{copy.profilePending}</p>}{pathPending && <p role="status">{copy.pathPending}</p>}{executionNotice}{error && <LaunchFailureNotice text={error} locale={locale} />}{invalid.size > 0 && <p className="text-error" role="alert">{copy.invalid} ({[...invalid].join(', ')})</p>}{incomplete && <p className="text-error">{t('ui.modelShardsMissing', { count: selected!.shards!.missing.length, total: selected!.shards!.total })}</p>}</div>
              <div className="model-settings-actions">
                {!benchmark && mode !== 'project' && (live
                  ? <button type="button" className="app-button app-button--danger" disabled={disabled || liveState === 'stopping' || !onStop} onClick={() => onStop?.()}>{liveState === 'stopping' ? t('status.working') : t('action.stop')}</button>
                  : <button type="button" className="app-button app-button--primary" disabled={disabled || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim() || !cfg.active_backend || !cfg.active_build || incomplete || runtimeMissing} onClick={() => void apply('start')}>{startText}</button>)}
                {disabled && onCancelStart && <button type="button" className="app-button app-button--secondary" onClick={onCancelStart}>{copy.cancel}</button>}
              </div></>}
        </footer>
      </div>
      <div ref={setOverlay} className="model-settings-overlays" inert={disabled || !!pending || confirmSave} />
    </OverlayContainerContext.Provider>
  </dialog>;
}

/** A launch failure shows a short summary first; the raw server log stays one click away. */
function LaunchFailureNotice({ text, locale }: { text: string; locale: Locale }) {
  const view = describeLaunchFailure(text, locale);
  const copy = modelSettingsCopy[locale];
  if (!view.detail) return <p className="text-error" role="alert">{normalizeDisplayText(text)}</p>;
  return <div className="text-error" role="alert">
    {view.summary.split('\n').map((line, index) => <p key={index}>{normalizeDisplayText(line)}</p>)}
    <details><summary>{copy.failureDetails}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-left text-xs">{normalizeDisplayText(view.detail)}</pre></details>
  </div>;
}
export default ModelSettingsDialog;
