import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { providerOf, providerDisplayName } from '../../shared/api/providers';
import type { GpuDevice } from '../../shared/api/types';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { useI18n } from '../../shared/i18n/i18n';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import Badge from '../../shared/ui/Badge';
import { profileControlCopy, profileFieldLabel } from './profileControlCopy';
import { valueRenderer } from './SettingsChangeList';
import { settingDefaultInfo } from '../../shared/config/defaultValueDisplay';
import DefaultValue from '../../shared/ui/DefaultValue';
import { isCustomizedSetting } from './profileValueState';
import { SERVER_OPTIONS, type ServerOption } from '../../shared/config/serverOptions';
import { useServerOptions } from '../tuning/useServerOptions';
import GpuPlacementSummary from './GpuPlacementSummary';
import ServerArgumentsSummary from './ServerArgumentsSummary';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { runtimeVersionLabel, useInstalledRuntimes } from '../../shared/runtime/installedRuntimes';
import './settings-profile.css';

export interface ProfileViewItem {
  id: string;
  name: string;
  scope: 'preset' | 'global' | 'model';
  settings: Partial<ExecutionSettings>;
  system_prompt?: string;
  description?: string;
  deletable?: boolean;
  deletionReason?: 'default';
}

export interface SettingsProfileControlProps {
  bannerTarget?: HTMLElement | null;
  saveAction?: ReactNode;
  children?: ReactNode;
  items: ProfileViewItem[];
  state: 'named' | 'working';
  activeId: string | null;
  basedOnId: string | null;
  defaultProfileId: string;
  modelPath: string;
  currentSettings: Partial<ExecutionSettings>;
  currentPrompt: string;
  defaults: Partial<ExecutionSettings>;
  runtimeOptions?: readonly ServerOption[];
  runtimeVerified?: boolean;
  /** Devices the selected runtime reports, used to name stored GPU ids. */
  gpuDevices?: readonly GpuDevice[];
  disabled: boolean;
  blocked?: boolean;
  full: boolean;
  onApply: (id: string) => Promise<void>;
  onSaveAs: (name: string, scope: 'model' | 'global') => Promise<void>;
  onRename: (id: string, name: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onSetDefault: (id: string) => Promise<void>;
  onRevert: () => Promise<void>;
  onReset: () => boolean;
  onEditingChange?: (dirty: boolean) => void;
}

type ActionDraft =
  | { kind: 'create'; name: string; scope: 'global'; model: string }
  | { kind: 'rename' | 'delete'; id: string; name: string; model: string };

const groups = [
  { scope: 'global', label: 'globalProfiles', empty: 'emptyGlobal' },
] as const;
const settingGroups = [
  { label: 'sampling', keys: ['temperature', 'top_p', 'top_k'] },
  { label: 'capacity', keys: ['ctx_size', 'batch_size', 'ubatch_size', 'keep', 'threads', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds', 'cache_type_k', 'cache_type_v', 'flash_attn'] },
  { label: 'reasoning', keys: ['reasoning', 'reasoning_format', 'reasoning_effort', 'reasoning_budget', 'reasoning_budget_message', 'reasoning_preserve'] },
  { label: 'runtime', keys: ['active_backend', 'active_build', 'ngl', 'n_cpu_moe', 'gpu', 'mmproj', 'lora_adapters', 'spec_type', 'spec_draft_model', 'spec_draft_n_max', 'spec_draft_n_min', 'spec_draft_p_min', 'spec_draft_p_split', 'spec_draft_ngl', 'spec_draft_device'] },
  { label: 'advanced', keys: ['server_args'] },
] as const;

type DefaultRuntime = { options: readonly ServerOption[]; verified: boolean; backend?: string; build?: string };

function SettingsValues({ settings, prompt, runtime, gpuDevices, mode = 'current' }: { settings: Partial<ExecutionSettings>; prompt?: string; runtime: DefaultRuntime; gpuDevices: readonly GpuDevice[]; mode?: 'current' | 'preview' | 'reference' }) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
  const renderValue = valueRenderer(locale);
  const provider = providerOf(settings);
  const llama = provider === 'llama.cpp';
  const installedRuntimes = useInstalledRuntimes(llama);
  const backend = settings.active_backend ?? runtime.backend ?? '';
  const build = settings.active_build ?? runtime.build ?? '';
  const sameRuntime = backend === (runtime.backend ?? '') && build === (runtime.build ?? '');
  // A preview may name a different runtime. Its defaults must come from that
  // build, while the current/default cards reuse the editor's existing probe.
  const previewRuntime = useServerOptions(backend, build, llama && !sameRuntime && !!backend && !!build);
  const source = sameRuntime ? runtime : previewRuntime;
  const displayDevices = sameRuntime ? gpuDevices
    : previewRuntime.capabilities?.backend === backend ? runtimeGpuDevices(backend, previewRuntime.capabilities.devices) : [];
  const keys = new Set([...Object.keys(settings), ...(settings.runtime_defaults ?? [])]);
  const shared = ['active_provider', 'active_runtime', 'temperature', 'top_p', 'top_k', 'reasoning_effort', 'request_timeout_seconds'];
  const entries: [string, unknown][] = [...keys].filter(key => key !== 'active_model' && key !== 'runtime_defaults' && key !== 'chat_options' && key !== 'provider_options' && (llama ? key !== 'active_runtime' : shared.includes(key))).map(key => [key, settings[key as keyof ExecutionSettings]]);
  if (!llama) for (const entry of Object.entries(settings.provider_options?.[provider] ?? {})) {
    const index = entries.findIndex(([key]) => key === entry[0]);
    if (index < 0) entries.push(entry); else entries[index] = entry;
  }
  const rendered = new Set(settingGroups.flatMap(group => [...group.keys]) as string[]);
  const extra = [...entries.filter(([key]) => !rendered.has(key)), ...Object.entries(settings.chat_options ?? {})];
  return <div className="settings-profile-values">
    {settingGroups.map(group => {
      const rows = entries.filter(([key]) => (group.keys as readonly string[]).includes(key));
      if (group.label === 'advanced') rows.push(...extra);
      if (!rows.length) return null;
      return <section key={group.label} className="settings-profile-value-group" aria-label={copy[group.label]}>
        <h4>{copy[group.label]}</h4>
        <dl>{rows.map(([key, value]) => {
          const inherited = llama && settings.runtime_defaults?.includes(key);
          const customized = mode !== 'reference' && (llama ? isCustomizedSetting(key, value, settings, source.options, source.verified) : settings.provider_options?.[provider]?.[key] !== undefined);
          const placement = key === 'gpu' && !inherited && value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length ? value as Record<string, unknown> : null;
          const args = key === 'server_args' && !inherited && Array.isArray(value) && value.length && value.every(token => typeof token === 'string') ? value as string[] : null;
          return <div key={key} className={`settings-profile-value${placement || args ? ' settings-profile-value--stacked' : ''}${customized ? ' settings-profile-value--custom' : ''}`}>
            <dt>{profileFieldLabel(key, locale)}</dt>
            <dd>{inherited ? <DefaultValue info={settingDefaultInfo(key, source.options, source.verified, locale, { selected: mode === 'current' })} />
              : placement ? <GpuPlacementSummary placement={placement} devices={displayDevices} />
                : args ? <ServerArgumentsSummary args={args} options={source.options} />
                  : key === 'active_provider' ? providerDisplayName(provider) : key === 'active_build' && typeof value === 'string' && value ? runtimeVersionLabel(installedRuntimes, backend, value) : renderValue(value)}</dd>
          </div>;
        })}</dl>
      </section>;
    })}
    {prompt !== undefined && <section className="settings-profile-value-group settings-profile-prompt" aria-label={copy.prompt}>
      <h4>{copy.prompt}</h4><p>{prompt || copy.empty}</p>
    </section>}
  </div>;
}

export default function SettingsProfileControl({ items, state, activeId, basedOnId, defaultProfileId, modelPath, currentSettings, currentPrompt, defaults, runtimeOptions = SERVER_OPTIONS, runtimeVerified = false, gpuDevices = [], disabled, blocked = false, full, onApply, onSaveAs, onRename, onDelete, onSetDefault, onRevert, onReset, onEditingChange, saveAction, children, bannerTarget }: SettingsProfileControlProps) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
  const runtime = { options: runtimeOptions, verified: runtimeVerified, backend: currentSettings.active_backend, build: currentSettings.active_build };
  const labelId = useId();
  const detailId = useId();
  const formId = useId();
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [action, setAction] = useState<ActionDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [resetFeedback, setResetFeedback] = useState<{ changed: boolean; sequence: number } | null>(null);
  const resetSequence = useRef(0);
  const actionKind = action?.kind;
  const pendingRef = useRef(false);
  const originRef = useRef<HTMLButtonElement | null>(null);
  const bannerRef = useRef<HTMLHeadingElement>(null);
  const restoreFocusRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const editingChangeRef = useRef(onEditingChange);
  editingChangeRef.current = onEditingChange;
  const active = items.find(item => item.id === (activeId ?? basedOnId));
  const preview = items.find(item => item.id === previewId);
  const detailItem = preview ?? active;
  const defaultProfile = items.find(item => item.id === defaultProfileId);
  const isDefault = (item: ProfileViewItem) => item.id === defaultProfileId;
  const deleteItem = action?.kind === 'delete' ? items.find(item => item.id === action.id) : undefined;
  const deleteBlocked = action?.kind === 'delete' && (!deleteItem || isDefault(deleteItem));
  const locked = disabled || pending;
  const mutationLocked = locked || Boolean(action);
  const title = state === 'working' ? copy.editingTitle.replace('{name}', active?.name ?? '') : active?.name;
  const subtitle = active && (state === 'working' ? copy.editingHint : copy.namedHint).replace('{scope}', copy[active.scope]);

  useEffect(() => { editingChangeRef.current?.(Boolean(action)); }, [action]);
  useEffect(() => () => editingChangeRef.current?.(false), []);
  useEffect(() => {
    setAction(null); setPreviewId(null); setError(''); setResetFeedback(null);
  }, [modelPath]);
  useEffect(() => {
    if (!resetFeedback) return;
    const timer = window.setTimeout(() => setResetFeedback(null), 4000);
    return () => window.clearTimeout(timer);
  }, [resetFeedback]);
  useEffect(() => { if (disabled) setResetFeedback(null); }, [disabled]);
  useEffect(() => {
    if (actionKind && actionKind !== 'delete') inputRef.current?.focus();
  }, [actionKind]);
  useEffect(() => {
    if (!action && !pending && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      if (originRef.current?.isConnected) originRef.current.focus();
      else if (bannerTarget) bannerTarget.querySelector<HTMLButtonElement>('.settings-profile-picker button')?.focus();
      else bannerRef.current?.focus();
    }
  }, [action, pending, previewId, bannerTarget]);

  const closeAction = () => { restoreFocusRef.current = true; setAction(null); setError(''); };
  const closePreview = () => { restoreFocusRef.current = true; setPreviewId(null); };
  const openAction = (draft: ActionDraft, origin: HTMLButtonElement) => {
    originRef.current = origin; setError(''); setAction(draft);
  };
  const run = async (operation: () => Promise<void>, after?: () => void) => {
    if (pendingRef.current || disabled) return;
    pendingRef.current = true; setPending(true); setError('');
    try { await operation(); after?.(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : typeof reason === 'string' ? reason : copy.error); }
    finally { pendingRef.current = false; setPending(false); }
  };
  const submit = () => {
    if (!action || action.model !== modelPath || locked || deleteBlocked) return;
    if (action.kind === 'rename' && action.name.trim() === items.find(item => item.id === action.id)?.name) return;
    if (action.kind === 'delete') void run(() => onDelete(action.id), () => { closeAction(); setPreviewId(null); });
    else if (action.name.trim() && !(action.kind === 'create' && blocked)) {
      void run(() => action.kind === 'create' ? onSaveAs(action.name.trim(), action.scope) : onRename(action.id, action.name.trim()), closeAction);
    }
  };
  const handleEscape = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || (!action && !preview)) return;
    event.preventDefault(); event.stopPropagation();
    if (pending) return;
    if (action) closeAction();
    else closePreview();
  };

  if (!active) return null;

  const banner = <div className={`settings-profile-banner settings-profile-banner--${state}${bannerTarget ? ' settings-profile-banner--compact' : ` app-card app-card--tight${state === 'working' ? ' app-card--warning' : ''}`}`}>
      <span className="settings-profile-state-dot" aria-hidden="true" />
      <div className="settings-profile-banner-text"><div className="settings-profile-title-line" aria-live="polite"><h3 ref={bannerRef} id={labelId} tabIndex={-1}>{title}</h3>{isDefault(active) && <Badge tone="info" className="settings-profile-default-badge">{copy.defaultProfile}</Badge>}</div><p role="status" aria-atomic="true" className={resetFeedback ? 'settings-profile-feedback' : undefined}><span key={resetFeedback?.sequence ?? 0}>{resetFeedback ? resetFeedback.changed ? copy.resetDone : copy.resetUnchanged : subtitle}</span></p></div>
      <div className="settings-profile-buttons">
        <CustomSelect className="settings-profile-picker" ariaLabel={copy.profiles} size="sm" value={active.id}
          disabled={mutationLocked || blocked} options={items.map(item => ({ value: item.id, label: `${copy[item.scope]} · ${item.name}${bannerTarget && state === 'working' && item.id === active.id ? ` · ${copy.editing}` : ''}` }))}
          onChange={id => { if (id !== active.id) void run(() => onApply(id), () => setPreviewId(null)); }} />
        {full && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={() => { const changed = onReset(); setResetFeedback({ changed, sequence: ++resetSequence.current }); setPreviewId(null); setError(''); }}>{copy.resetAll}</button>}
        {saveAction}
        <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="save" disabled={mutationLocked || blocked} onClick={event => openAction({ kind: 'create', name: '', scope: 'global', model: modelPath }, event.currentTarget)}>{copy.saveAs}</button>
        {state === 'working' && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={() => void run(onRevert, () => setPreviewId(null))}>{copy.revert}</button>}
      </div>
    </div>;

  return <section className={`settings-profile-control${full ? ' settings-profile-control--full' : ''}`} aria-label={copy.profiles} onKeyDown={handleEscape} aria-busy={pending}>
    {bannerTarget ? createPortal(banner, bannerTarget) : banner}

    {action && action.kind !== 'delete' && <div className="settings-profile-action app-card app-card--tight" role="group" aria-label={action.kind === 'create' ? copy.saveAs : copy.rename}>
      <>
        <label htmlFor={`${formId}-name`}>{copy.name}</label>
        <input ref={inputRef} id={`${formId}-name`} className="app-input" value={action.name} maxLength={120} disabled={locked} onChange={event => setAction({ ...action, name: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
        {action.kind === 'create' && <p className="settings-profile-hint">{copy.saveGlobalHint}</p>}
      </>
      <div className="settings-profile-buttons">
        <button ref={cancelRef} type="button" className="app-button app-button--secondary app-button--sm" disabled={pending} onClick={closeAction}>{copy.cancel}</button>
        <button type="button" className="app-button app-button--primary app-button--sm" disabled={locked || !action.name.trim() || action.kind === 'create' && blocked || action.kind === 'rename' && action.name.trim() === items.find(item => item.id === action.id)?.name} onClick={submit}>{action.kind === 'create' ? copy.create : copy.done}</button>
      </div>
    </div>}
    {action?.kind === 'delete' && <ConfirmDialog open title={copy.deleteConfirm.replace('{name}', action.name)}
      description={<><p>{copy.deleteHint.replace('{name}', defaultProfile?.name ?? '')}</p>
        {deleteItem && isDefault(deleteItem) && <p>{copy.defaultDeleteHint}</p>}{error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}</>}
      confirmLabel={copy.remove} cancelLabel={copy.cancel} busy={locked} confirmDisabled={deleteBlocked}
      onConfirm={submit} onCancel={closeAction} />}
    {error && action?.kind !== 'delete' && <FeedbackBanner tone="error">{error}</FeedbackBanner>}

    {full && <>
      <div className="settings-profile-groups">
        {groups.map(group => {
          const members = items.filter(item => item.scope === group.scope);
          return <section className={`settings-profile-group settings-profile-group--${group.scope}`} key={group.scope} aria-label={copy[group.label]}>
            <h4 className="settings-profile-group-heading">{copy[group.label]}</h4>
            <div className="settings-profile-chips">{members.length ? members.map(item => {
              const isActive = active?.id === item.id;
              const isEditing = isActive && state === 'working';
              const isPreview = preview?.id === item.id;
              return <button key={item.id} type="button" className={`app-button app-button--secondary app-button--sm settings-profile-chip${isActive ? ' settings-profile-chip--active' : ''}`} disabled={mutationLocked} aria-pressed={isPreview} aria-label={`${item.name}${isActive ? ` · ${copy.active}` : ''}${isEditing ? ` · ${copy.editing}` : ''}${isDefault(item) ? ` · ${copy.defaultProfile}` : ''}`} aria-controls={detailId} onClick={event => { originRef.current = event.currentTarget; setPreviewId(isPreview ? null : item.id); setError(''); }}>
                {isActive && <span aria-hidden="true">✓</span>}<span>{item.name}</span>{isEditing && <Badge tone="warning" aria-hidden="true">{copy.editing}</Badge>}{isDefault(item) && <Badge tone="info" className="settings-profile-default-badge" aria-hidden="true">{copy.defaultProfile}</Badge>}
              </button>;
            }) : <span className="settings-profile-hint">{copy[group.empty]}</span>}</div>
          </section>;
        })}
      </div>
      <section id={detailId} className={`settings-profile-detail app-card${preview ? ' app-card--accent' : ''}`} aria-label={preview ? copy.preview : copy.current}>
        <div className="settings-profile-detail-heading">
          <div>{preview && <p className="settings-profile-eyebrow">{copy.preview}</p>}<h3>{preview?.name ?? copy.current}</h3>
            {preview && <div className="settings-profile-badges">
              <Badge>{copy[preview.scope]}</Badge>
              {isDefault(preview) && <Badge>{copy.defaultProfile}</Badge>}
              {preview.id === active.id && <Badge>{copy.active}</Badge>}
              {preview.scope === 'preset' && <Badge>{copy.readonly}</Badge>}
            </div>}
          </div>
          <div className="settings-profile-buttons">
            {preview && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={closePreview}>{copy.closePreview}</button>}
            {preview && preview.id !== active?.id && <button type="button" className="app-button app-button--primary app-button--sm" disabled={mutationLocked || blocked} onClick={() => void run(() => onApply(preview.id), () => setPreviewId(null))}>{copy.apply}</button>}
            {detailItem && detailItem.scope !== 'preset' && <>
              {!isDefault(detailItem) && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={() => void run(() => onSetDefault(detailItem.id))}>{copy.setDefault}</button>}
              <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={event => openAction({ kind: 'rename', id: detailItem.id, name: detailItem.name, model: modelPath }, event.currentTarget)}>{copy.rename}</button>
              <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked || isDefault(detailItem)} aria-describedby={isDefault(detailItem) ? `${detailId}-delete-hint` : undefined} onClick={event => openAction({ kind: 'delete', id: detailItem.id, name: detailItem.name, model: modelPath }, event.currentTarget)}>{copy.remove}</button>
            </>}
          </div>
        </div>
        {detailItem && isDefault(detailItem) && <p id={`${detailId}-delete-hint`} className="settings-profile-hint">{copy.defaultDeleteHint}</p>}
        {preview && <p className="settings-profile-hint">{copy.previewHint}</p>}
        {preview?.description && <p className="settings-profile-hint">{preview.description}</p>}
        <SettingsValues settings={preview?.settings ?? currentSettings} prompt={preview ? preview.system_prompt : currentPrompt} runtime={runtime} gpuDevices={gpuDevices} mode={preview ? 'preview' : 'current'} />
      </section>
      <details className="settings-profile-defaults app-card app-card--tight"><summary>{copy.defaults}<Badge>{copy.readonly}</Badge></summary>
        <p className="settings-profile-hint">{copy.defaultsSummary}</p><SettingsValues settings={defaults} runtime={runtime} gpuDevices={gpuDevices} mode="reference" />
      </details>
    </>}
    {children && <div className="settings-profile-editor">{children}</div>}
  </section>;
}
