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
import DraftTuningEditor, { BENCHMARK_CONTROLLED_KEYS } from './DraftTuningEditor';
import DraftGpuEditor from './DraftGpuEditor';
import DraftAdvancedEditor from './DraftAdvancedEditor';
import DraftProfiles, { type ProfileSelection } from './DraftProfiles';
import { useModelCatalog } from './useModelCatalog';
import { modelSettingsCopy } from './modelSettingsCopy';
import './model-settings.css';

export interface ModelSettingsDialogProps {
  open: boolean; initialConfig: api.AppConfig; targetLabel: string;
  mode: 'default' | 'session' | 'benchmark' | 'project'; initialSection?: string;
  onApply: (cfg: api.AppConfig, intent: 'save' | 'start', profiles?: ProfileSelection) => Promise<void>;
  onClose: () => void; onManageRuntimes?: (draft?: api.AppConfig) => void;
  busy?: boolean; liveState?: string; applyLabel?: string; startLabel?: string;
  liveConfig?: api.AppConfig;
  executionNotice?: ReactNode; onCancelStart?: () => void;
}

const normalizeSection = (section = 'model') => ({ setup: 'runtime', gpu: 'runtime', lora: 'adapters', server: 'tuning', options: 'advanced', escape: 'advanced' }[section] ?? section);

/** A target-scoped editor. No configuration or model-profile writes happen on preview. */
export function ModelSettingsDialog({ open, initialConfig, targetLabel, mode, initialSection, onApply, onClose, onManageRuntimes,
  busy = false, liveState, liveConfig, applyLabel, startLabel, executionNotice, onCancelStart }: ModelSettingsDialogProps) {
  const { t, locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const id = useId();
  const initial = useRef(structuredClone(initialConfig));
  const [baseline, setBaseline] = useState(() => executionSettings(initialConfig));
  const [settings, setSettings] = useState<ExecutionSettings>(() => executionSettings(initialConfig));
  const cfg = executionConfig(initialConfig, settings);
  const latest = useRef(cfg); latest.current = cfg;
  const [section, setSection] = useState(normalizeSection(initialSection));
  const [quickPicker, setQuickPicker] = useState(!initialSection || initialSection === 'model');
  const [query, setQuery] = useState('');
  const [pathDraft, setPathDraft] = useState(initialConfig.active_model);
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const applyLock = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileSelection, setProfileSelection] = useState<ProfileSelection>({});
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
  const running = liveState === 'running' && (mode === 'default' || mode === 'session');
  const serverChanged = running && serverSettingsChanged(liveConfig ?? initial.current, cfg);
  const saveText = applyLabel ?? (benchmark ? copy.benchmarkApply : mode === 'project' ? copy.projectApply : running ? serverChanged ? copy.saveNext : copy.apply : copy.save);
  const startText = startLabel ?? (running ? (liveConfig ?? initial.current).active_model === cfg.active_model ? copy.restart : copy.switchStart : copy.start);
  const stateText = liveState && ['stopped', 'starting', 'stopping', 'running', 'failed', 'crashed'].includes(liveState) ? executionText[locale][liveState as 'running'] : liveState;
  const selectionDirty = Object.keys(profileSelection).length > 0;
  const dirty = JSON.stringify(settings) !== JSON.stringify(executionSettings(initial.current)) || invalid.size > 0 || profileDirty || selectionDirty || pathDraft !== cfg.active_model;
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
  const setFieldInvalid = useCallback((key: string, value: boolean) => setInvalid(previous => {
    if (previous.has(key) === value) return previous;
    const next = new Set(previous); if (value) next.add(key); else next.delete(key); return next;
  }), []);
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
        const restored = previewExecution(initial.current, path);
        const next = executionSettings({ ...initial.current, ...restored, active_model: path,
          mmproj: restored.mmproj ?? '', spec_draft_model: restored.spec_draft_model ?? '', lora_adapters: restored.lora_adapters ?? [],
          ...(mode === 'session' ? { gpu: initial.current.gpu } : {}) });
        setSettings(next); setBaseline(next); setPathDraft(path); setInvalid(new Set()); setProfileSelection({}); setProfileDirty(false); setEditorRevision(value => value + 1); setError('');
      } catch (cause) { setError(String(cause)); }
    };
    if (JSON.stringify(settings) !== JSON.stringify(baseline) || invalid.size || profileDirty || selectionDirty) setPending(() => load); else load();
  };
  const apply = async (intent: 'save' | 'start') => {
    if (disabled || applyLock.current || invalid.size || profileDirty || pathPending || !cfg.active_model.trim()) return;
    applyLock.current = true; setApplying(true); setError('');
    try { await onApply(structuredClone(latest.current), intent, profileSelection); setBaseline(executionSettings(latest.current)); onClose(); }
    catch (cause) { setError(String(cause)); }
    finally { applyLock.current = false; setApplying(false); }
  };
  const runtimeMissing = !!cfg.active_backend && !resources.runtimes.some(item => item.backend === cfg.active_backend && item.build === cfg.active_build);
  const devices = runtime.capabilities ? runtimeGpuDevices(cfg.active_backend, runtime.capabilities.devices) : [];
  const device = resources.device && cfg.active_backend ? { ...resources.device, profile: { ...resources.device.profile, gpus: devices } } : resources.device;
  const sections = (['model', 'runtime', 'tuning', 'sampling', 'reasoning', 'adapters', 'advanced', 'profiles'] as const).filter(value => !benchmark || !['sampling', 'reasoning'].includes(value));
  const models = catalog.models.filter(model => !model.is_vision && `${model.name} ${normalizeDisplayPath(model.path)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = catalog.models.find(model => model.path === cfg.active_model);
  const incomplete = !!selected?.shards?.missing.length;
  const editorKey = `${cfg.active_model}:${editorRevision}`;
  const sidecar = (key: 'mmproj' | 'spec_draft_model', label: string, vision: boolean) => <label>{label}
    <CustomSelect ariaLabel={label} value={cfg[key]} disabled={disabled} options={[{ value: '', label: copy.none }, ...catalog.models.filter(model => model.is_vision === vision).map(model => ({ value: model.path, label: model.name, disabled: !!model.shards?.missing.length })),
      ...(cfg[key] && !catalog.models.some(model => model.path === cfg[key]) ? [{ value: cfg[key], label: modelDisplayName(cfg[key]) }] : [])]} onChange={value => change({ [key]: value })} />
    <input className="app-input" aria-label={`${label} — ${copy.path}`} value={cfg[key]} disabled={disabled} onChange={event => change({ [key]: event.target.value })} />
  </label>;
  return <dialog ref={dialog} className={`model-settings-dialog${quickPicker ? ' model-settings-dialog--picker' : ''}`} aria-labelledby={`${id}-title`} aria-busy={disabled || undefined}
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
        <header className="model-settings-header"><div><span className="app-eyebrow">{targetLabel}{stateText ? ` · ${stateText}` : ''}</span><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{quickPicker ? copy.choose : copy.title}</h2><p title={normalizeDisplayPath(cfg.active_model)}>{cfg.active_model ? modelDisplayName(cfg.active_model) : copy.model}</p></div>
          <button type="button" className="app-button app-button--ghost" aria-label={copy.close} disabled={disabled} onClick={() => guarded(onClose)}>×</button></header>
        <div className="model-settings-layout" inert={!!pending || disabled}>
          {!quickPicker && <nav className="model-settings-nav" aria-label={copy.title}>{sections.map(value => <button type="button" key={value} className={section === value ? 'is-active' : ''} aria-current={section === value ? 'page' : undefined} onClick={() => setSection(value)}>{copy[value]}</button>)}</nav>}
          <div className="model-settings-body">
            {benchmark && !quickPicker && <p className="model-settings-scope">{copy.benchmarkControlled}</p>}
            <div hidden={section !== 'model'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.model}</h3><div>{quickPicker && <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => { setQuickPicker(false); setSection('runtime'); }}>{copy.details}</button>}<button type="button" className="app-button app-button--ghost app-button--sm" onClick={catalog.refresh}>{copy.refresh}</button></div></div>
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
                onClick={() => chooseModel(model.path)} aria-pressed={cfg.active_model === model.path} title={normalizeDisplayPath(model.path)}><span><strong>{normalizeDisplayText(model.name)}</strong><small>{model.size_mb.toLocaleString(locale, { maximumFractionDigits: 0 })} MB{model.shards?.missing.length ? ` · ${t('ui.modelShardsMissing', { count: model.shards.missing.length, total: model.shards.total })}` : ''}</small></span>{cfg.active_model === model.path && <span>{copy.selected}</span>}</button></li>)}</ul>
              {!catalog.loading && !models.length && <p className="app-section-hint">{copy.empty}</p>}
              <label>{copy.path}<input className="app-input" value={pathDraft} onChange={event => setPathDraft(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); chooseModel(pathDraft.trim()); } }} /></label>
              {pathDraft.trim() !== cfg.active_model && <button type="button" className="app-button app-button--secondary" disabled={!pathDraft.trim()} onClick={() => chooseModel(pathDraft.trim())}>{copy.load}</button>}
            </div>
            <div hidden={section !== 'runtime'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.runtime}</h3>{onManageRuntimes && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => onManageRuntimes(structuredClone(cfg))}>{copy.manageRuntime}</button>}</div>
              <label>{copy.runtime}<CustomSelect ariaLabel={copy.runtime} value={`${cfg.active_backend}/${cfg.active_build}`} options={[{ value: '/', label: copy.systemRuntime }, ...resources.runtimes.map(item => ({ value: `${item.backend}/${item.build}`, label: `${item.backend} · ${item.build}` })), ...(runtimeMissing ? [{ value: `${cfg.active_backend}/${cfg.active_build}`, label: `${cfg.active_backend} · ${cfg.active_build}` }] : [])]}
                onChange={value => { const item = resources.runtimes.find(item => `${item.backend}/${item.build}` === value); change({ active_backend: item?.backend ?? '', active_build: item?.build ?? '' }); }} /></label>
              {runtimeMissing && <p className="text-warning" role="status">{copy.missingRuntime}</p>}
              {(resourceError || runtime.error) && <div><p className="text-warning" role="status">{normalizeDisplayText(resourceError || runtime.error || '')}</p><button type="button" className="app-button app-button--secondary" onClick={() => { setResourceRevision(value => value + 1); runtime.refresh(); }}>{copy.refresh}</button></div>}
              <DraftGpuEditor key={editorKey} placement={cfg.gpu} device={device} disabled={disabled || runtime.loading} onChange={gpu => change({ gpu })} onInvalid={setFieldInvalid} />
            </div>
            <div hidden={!['tuning', 'sampling', 'reasoning', 'adapters'].includes(section)}>
              <div hidden={section !== 'adapters'} className="model-settings-fields">
                {sidecar('mmproj', copy.projector, true)}{sidecar('spec_draft_model', copy.draftModel, false)}
                <h3>LoRA</h3>{cfg.lora_adapters.map((adapter, index) => <div key={adapter.path} className="model-settings-lora"><strong title={normalizeDisplayPath(adapter.path)}>{modelDisplayName(adapter.path)}</strong><label>{copy.enabled}<input type="checkbox" checked={adapter.enabled} onChange={event => change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, enabled: event.target.checked } : item) })} /></label>
                  <label>{copy.scale}<input className="app-input" type="number" min="0" max="4" step="0.05" value={adapter.scale} onChange={event => { const scale = Number(event.target.value); if (Number.isFinite(scale) && scale >= 0 && scale <= 4) change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, scale } : item) }); }} /></label>
                  <button type="button" className="app-button app-button--ghost" onClick={() => change({ lora_adapters: cfg.lora_adapters.filter((_, i) => i !== index) })}>{copy.remove}</button></div>)}
                <button type="button" className="app-button app-button--secondary" onClick={() => void api.pickLoraAdapter().then(path => { if (path) change({ lora_adapters: [...latest.current.lora_adapters.filter(item => item.path !== path), { path, enabled: true, scale: 1 }] }); }).catch(cause => setError(String(cause)))}>{copy.addLora}</button>
              </div>
              <DraftTuningEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} section={section} disabled={disabled} benchmark={benchmark} runtime={runtime} onChange={change} onInvalid={setFieldInvalid}
                onResetDrafts={() => { setTuningRevision(value => value + 1); setInvalid(previous => new Set([...previous].filter(key => key.startsWith('gpu_')))); }} />
            </div>
            <div hidden={section !== 'advanced'}><DraftAdvancedEditor key={`${editorKey}:${tuningRevision}`} cfg={cfg} options={runtime.options} disabled={disabled} benchmark={benchmark} onChange={change} onInvalid={setFieldInvalid} /></div>
            <div hidden={section !== 'profiles'}><DraftProfiles key={editorKey} cfg={cfg} disabled={disabled} benchmark={benchmark} onDirty={setProfileDirty} onLoad={(patch, selection) => {
              change(benchmark ? Object.fromEntries(Object.entries(patch).filter(([key]) => !BENCHMARK_CONTROLLED_KEYS.has(key))) : patch);
              setProfileSelection(previous => ({ ...previous, ...selection })); setEditorRevision(value => value + 1); setInvalid(new Set());
            }} /></div>
          </div>
        </div>
        <footer className="model-settings-footer">
          {pending ? <div className="model-settings-confirm" role="alert"><strong>{copy.discardTitle}</strong><p>{copy.discardBody}</p><div><button type="button" className="app-button app-button--secondary" onClick={() => setPending(null)}>{copy.keep}</button><button type="button" className="app-button app-button--danger" onClick={() => { const action = pending; setPending(null); action(); }}>{copy.discard}</button></div></div>
            : <><div className="model-settings-notices"><p>{copy.draft}</p>{profileDirty && <p role="status">{copy.profilePending}</p>}{pathPending && <p role="status">{copy.pathPending}</p>}{executionNotice}{error && <p className="text-error" role="alert">{normalizeDisplayText(error)}</p>}{invalid.size > 0 && <p className="text-error" role="alert">{copy.invalid} ({[...invalid].join(', ')})</p>}{incomplete && <p className="text-error">{t('ui.modelShardsMissing', { count: selected!.shards!.missing.length, total: selected!.shards!.total })}</p>}</div>
              <div className="model-settings-actions"><button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => guarded(onClose)}>{copy.cancel}</button>
                <button type="button" className="app-button app-button--primary" disabled={disabled || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim()} onClick={() => void apply('save')}>{applying ? copy.pending : saveText}</button>
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
