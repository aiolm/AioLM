import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { useI18n } from '../../shared/i18n/i18n';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { profileControlCopy, profileFieldLabel } from './profileControlCopy';
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
  | { kind: 'create'; name: string; scope: 'model' | 'global'; model: string }
  | { kind: 'rename' | 'delete'; id: string; name: string; model: string };

const groups = [
  { scope: 'global', label: 'globalProfiles', empty: 'emptyGlobal' },
  { scope: 'model', label: 'modelProfiles', empty: 'emptyModel' },
] as const;
const settingGroups = [
  { label: 'sampling', keys: ['temperature', 'top_p', 'top_k'] },
  { label: 'capacity', keys: ['ctx_size', 'batch_size', 'ubatch_size', 'keep', 'threads', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds', 'cache_type_k', 'cache_type_v', 'flash_attn'] },
  { label: 'reasoning', keys: ['reasoning', 'reasoning_format', 'reasoning_effort', 'reasoning_budget', 'reasoning_budget_message', 'reasoning_preserve'] },
  { label: 'runtime', keys: ['active_backend', 'active_build', 'ngl', 'n_cpu_moe', 'gpu', 'mmproj', 'lora_adapters', 'spec_type', 'spec_draft_model', 'spec_draft_n_max', 'spec_draft_n_min', 'spec_draft_p_min', 'spec_draft_p_split', 'spec_draft_ngl', 'spec_draft_device'] },
  { label: 'advanced', keys: ['server_args'] },
] as const;

function SettingsValues({ settings, prompt }: { settings: Partial<ExecutionSettings>; prompt?: string }) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
  const renderValue = (value: unknown): string => {
    if (value == null || value === '') return copy.empty;
    if (typeof value === 'boolean') return value ? copy.on : copy.off;
    if (Array.isArray(value)) return value.length ? value.map(renderValue).join(', ') : copy.empty;
    if (typeof value === 'object') return Object.entries(value).map(([key, child]) => `${profileFieldLabel(key, locale)}: ${renderValue(child)}`).join(' · ') || copy.empty;
    return String(value);
  };
  const keys = new Set([...Object.keys(settings), ...(settings.runtime_defaults ?? [])]);
  const entries: [string, unknown][] = [...keys].filter(key => key !== 'active_model' && key !== 'runtime_defaults' && key !== 'chat_options').map(key => [key, settings[key as keyof ExecutionSettings]]);
  const rendered = new Set(settingGroups.flatMap(group => [...group.keys]) as string[]);
  const extra = [...entries.filter(([key]) => !rendered.has(key)), ...Object.entries(settings.chat_options ?? {})];
  return <div className="settings-profile-values">
    {settingGroups.map(group => {
      const rows = entries.filter(([key]) => (group.keys as readonly string[]).includes(key));
      if (group.label === 'advanced') rows.push(...extra);
      if (!rows.length) return null;
      return <section key={group.label} className="settings-profile-value-group" aria-label={copy[group.label]}>
        <h4>{copy[group.label]}</h4>
        <dl>{rows.map(([key, value]) => <div key={key} className="settings-profile-value">
          <dt>{profileFieldLabel(key, locale)}</dt>
          <dd>{settings.runtime_defaults?.includes(key) ? <span className="settings-profile-inherited">{copy.runtimeDefault}</span> : renderValue(value)}</dd>
        </div>)}</dl>
      </section>;
    })}
    {prompt !== undefined && <section className="settings-profile-value-group settings-profile-prompt" aria-label={copy.prompt}>
      <h4>{copy.prompt}</h4><p>{prompt || copy.empty}</p>
    </section>}
  </div>;
}

export default function SettingsProfileControl({ items, state, activeId, basedOnId, defaultProfileId, modelPath, currentSettings, currentPrompt, defaults, disabled, blocked = false, full, onApply, onSaveAs, onRename, onDelete, onSetDefault, onRevert, onReset, onEditingChange, saveAction, children }: SettingsProfileControlProps) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
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
    if (actionKind === 'delete') cancelRef.current?.focus();
    else if (actionKind) inputRef.current?.focus();
  }, [actionKind]);
  useEffect(() => {
    if (!action && !pending && restoreFocusRef.current) {
      restoreFocusRef.current = false;
      if (originRef.current?.isConnected) originRef.current.focus();
      else bannerRef.current?.focus();
    }
  }, [action, pending, previewId]);

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

  return <section className={`settings-profile-control${full ? ' settings-profile-control--full' : ''}`} aria-label={copy.profiles} onKeyDown={handleEscape} aria-busy={pending}>
    <div className={`settings-profile-banner settings-profile-banner--${state}`}>
      <span className="settings-profile-state-dot" aria-hidden="true" />
      <div className="settings-profile-banner-text"><div className="settings-profile-title-line" aria-live="polite"><h3 ref={bannerRef} id={labelId} tabIndex={-1}>{title}</h3>{isDefault(active) && <span className="settings-profile-default-badge">{copy.defaultProfile}</span>}</div><p role="status" aria-atomic="true" className={resetFeedback ? 'settings-profile-feedback' : undefined}><span key={resetFeedback?.sequence ?? 0}>{resetFeedback ? resetFeedback.changed ? copy.resetDone : copy.resetUnchanged : subtitle}</span></p></div>
      <div className="settings-profile-buttons">
        {full && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked || !modelPath.trim()} onClick={() => { const changed = onReset(); setResetFeedback({ changed, sequence: ++resetSequence.current }); setPreviewId(null); setError(''); }}>{copy.resetAll}</button>}
        {saveAction}
        <button type="button" className="app-button app-button--secondary app-button--sm" disabled={mutationLocked || blocked || !modelPath.trim()} onClick={event => openAction({ kind: 'create', name: '', scope: active.scope === 'global' ? 'global' : 'model', model: modelPath }, event.currentTarget)}>{copy.saveAs}</button>
        {state === 'working' && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={() => void run(onRevert, () => setPreviewId(null))}>{copy.revert}</button>}
      </div>
    </div>

    {action && <div className="settings-profile-action" role="group" aria-label={action.kind === 'create' ? copy.saveAs : action.kind === 'rename' ? copy.rename : copy.remove}>
      {action.kind === 'delete' ? <>
        <p><strong>{copy.deleteConfirm.replace('{name}', action.name)}</strong></p>
        <p className="settings-profile-hint">{copy.deleteHint.replace('{name}', defaultProfile?.name ?? '')}</p>
        {deleteItem && isDefault(deleteItem) && <p id={`${formId}-delete-hint`} className="settings-profile-hint">{copy.defaultDeleteHint}</p>}
      </> : <>
        <label htmlFor={`${formId}-name`}>{copy.name}</label>
        <input ref={inputRef} id={`${formId}-name`} className="app-input" value={action.name} maxLength={120} disabled={locked} onChange={event => setAction({ ...action, name: event.target.value })} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); submit(); } }} />
        {action.kind === 'create' && <>
          <label className="settings-profile-scope">{copy.scope}<CustomSelect<'model' | 'global'> value={action.scope} options={[{ value: 'model', label: copy.model }, { value: 'global', label: copy.global }]} ariaLabel={copy.scope} disabled={locked} size="sm" onChange={scope => setAction({ ...action, scope })} /></label>
          {action.scope === 'global' && <p className="settings-profile-hint">{copy.saveGlobalHint}</p>}
        </>}
      </>}
      <div className="settings-profile-buttons">
        <button ref={cancelRef} type="button" className="app-button app-button--secondary app-button--sm" disabled={pending} onClick={closeAction}>{copy.cancel}</button>
        <button type="button" className={`app-button app-button--${action.kind === 'delete' ? 'danger' : 'primary'} app-button--sm`} disabled={locked || deleteBlocked || (action.kind !== 'delete' && !action.name.trim()) || action.kind === 'create' && blocked || action.kind === 'rename' && action.name.trim() === items.find(item => item.id === action.id)?.name} aria-describedby={action.kind === 'delete' && deleteItem && isDefault(deleteItem) ? `${formId}-delete-hint` : undefined} onClick={submit}>{action.kind === 'delete' ? copy.remove : action.kind === 'create' ? copy.create : copy.done}</button>
      </div>
    </div>}
    {error && <p className="settings-profile-error" role="alert">{error}</p>}

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
              return <button key={item.id} type="button" className={`settings-profile-chip${isActive ? ' settings-profile-chip--active' : ''}${isPreview ? ' settings-profile-chip--preview' : ''}`} disabled={mutationLocked} aria-pressed={isPreview} aria-label={`${item.name}${isActive ? ` · ${copy.active}` : ''}${isEditing ? ` · ${copy.editing}` : ''}${isDefault(item) ? ` · ${copy.defaultProfile}` : ''}`} aria-controls={detailId} onClick={event => { originRef.current = event.currentTarget; setPreviewId(isPreview ? null : item.id); setError(''); }}>
                {isActive && <span aria-hidden="true">✓</span>}<span>{item.name}</span>{isEditing && <span className="settings-profile-chip-editing" aria-hidden="true">{copy.editing}</span>}{isDefault(item) && <span className="settings-profile-default-badge" aria-hidden="true">{copy.defaultProfile}</span>}
              </button>;
            }) : <span className="settings-profile-hint">{copy[group.empty]}</span>}</div>
          </section>;
        })}
      </div>
      <section id={detailId} className={`settings-profile-detail${preview ? ' settings-profile-detail--preview' : ''}`} aria-label={preview ? copy.preview : copy.current}>
        <div className="settings-profile-detail-heading">
          <div>{preview && <p className="settings-profile-eyebrow">{copy.preview}</p>}<h3>{preview?.name ?? copy.current}</h3>
            {preview && <div className="settings-profile-badges">
              <span>{copy[preview.scope]}</span>
              {isDefault(preview) && <span>{copy.defaultProfile}</span>}
              {preview.id === active.id && <span>{copy.active}</span>}
              {preview.scope === 'preset' && <span>{copy.readonly}</span>}
            </div>}
          </div>
          <div className="settings-profile-buttons">
            {preview && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={closePreview}>{copy.closePreview}</button>}
            {preview && preview.id !== active?.id && <button type="button" className="app-button app-button--primary app-button--sm" disabled={mutationLocked || blocked || !modelPath.trim()} onClick={() => void run(() => onApply(preview.id), () => setPreviewId(null))}>{copy.apply}</button>}
            {detailItem && detailItem.scope !== 'preset' && <>
              {!isDefault(detailItem) && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} aria-describedby={detailItem.scope === 'model' ? `${detailId}-default-hint` : undefined} onClick={() => void run(() => onSetDefault(detailItem.id))}>{copy.setDefault}</button>}
              <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked} onClick={event => openAction({ kind: 'rename', id: detailItem.id, name: detailItem.name, model: modelPath }, event.currentTarget)}>{copy.rename}</button>
              <button type="button" className="app-button app-button--ghost app-button--sm" disabled={mutationLocked || isDefault(detailItem)} aria-describedby={isDefault(detailItem) ? `${detailId}-delete-hint` : undefined} onClick={event => openAction({ kind: 'delete', id: detailItem.id, name: detailItem.name, model: modelPath }, event.currentTarget)}>{copy.remove}</button>
            </>}
          </div>
        </div>
        {detailItem && isDefault(detailItem) && <p id={`${detailId}-delete-hint`} className="settings-profile-hint">{copy.defaultDeleteHint}</p>}
        {detailItem?.scope === 'model' && !isDefault(detailItem) && <p id={`${detailId}-default-hint`} className="settings-profile-hint">{copy.modelDefaultHint}</p>}
        {preview && <p className="settings-profile-hint">{copy.previewHint}</p>}
        {preview?.description && <p className="settings-profile-hint">{preview.description}</p>}
        <SettingsValues settings={preview?.settings ?? currentSettings} prompt={preview ? preview.system_prompt : currentPrompt} />
      </section>
      <details className="settings-profile-defaults"><summary>{copy.defaults}<span>{copy.readonly}</span></summary>
        <p className="settings-profile-hint">{copy.defaultsSummary}</p><SettingsValues settings={defaults} />
      </details>
    </>}
    {children && <div className="settings-profile-editor">{children}</div>}
  </section>;
}
