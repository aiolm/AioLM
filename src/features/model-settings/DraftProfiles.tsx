import { useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { REQUEST_DEFAULT_KEYS } from '../../shared/config/tuningDefaults';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { createModelProfile, createServerProfile, deleteModelProfile, deleteServerProfile, loadProfiles, modelProfilePatch, saveModelProfile, saveServerProfile, serverProfilePatch } from '../profiles/modelProfiles';
import { modelSettingsCopy } from './modelSettingsCopy';

export interface ProfileSelection { serverProfileId?: string; modelProfileId?: string; systemPrompt?: string }

export default function DraftProfiles({ cfg, disabled, benchmark, onLoad, onDirty }: {
  cfg: AppConfig; disabled: boolean; benchmark: boolean;
  onLoad: (patch: Partial<AppConfig>, selection: ProfileSelection) => void; onDirty: (dirty: boolean) => void;
}) {
  const { locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const [profiles, setProfiles] = useState(() => loadProfiles(cfg, cfg.active_model));
  const [kind, setKind] = useState<'server' | 'model'>('server');
  const [serverId, setServerId] = useState(profiles.activeServerId);
  const [modelId, setModelId] = useState(profiles.activeModelId);
  const [name, setName] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<string | null>(null);
  const [stop, setStop] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [deletePending, setDeletePending] = useState(false);
  const [switchPending, setSwitchPending] = useState<(() => void) | null>(null);
  const server = profiles.server.find(item => item.id === serverId) ?? profiles.server[0];
  const model = profiles.model.find(item => item.id === modelId) ?? profiles.model[0];
  const profile = kind === 'server' ? server : model;
  const dirty = name !== null || prompt !== null || stop !== null;
  useEffect(() => { onDirty(dirty); return () => onDirty(false); }, [dirty, onDirty]);
  const clear = () => { setName(null); setPrompt(null); setStop(null); setError(''); setDeletePending(false); };
  const choose = (run: () => void) => { if (dirty) setSwitchPending(() => run); else { clear(); run(); } };
  const save = (create: boolean) => {
    try {
      const profileName = (name ?? profile.name).trim();
      if (!profileName) return;
      if (kind === 'server') {
        const value = { ...createServerProfile(cfg, profileName), ...(!create ? { id: server.id } : {}) };
        saveServerProfile(value, profiles.server); setServerId(value.id);
      } else {
        const value = { ...createModelProfile(cfg, profileName), ...(!create ? { id: model.id } : {}), system_prompt: prompt ?? model.system_prompt,
          stop_strings: (stop ?? model.stop_strings.join('\n')).split('\n').filter(Boolean) };
        saveModelProfile(value, profiles.model); setModelId(value.id);
      }
      setProfiles(loadProfiles(cfg, cfg.active_model)); clear(); setNotice(copy.profileSaved);
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="model-settings-fields">
    <div className="model-settings-presets">
      <button type="button" className={`app-button app-button--${kind === 'server' ? 'primary' : 'secondary'}`} disabled={disabled} onClick={() => choose(() => setKind('server'))}>{copy.serverProfile}</button>
      {!benchmark && <button type="button" className={`app-button app-button--${kind === 'model' ? 'primary' : 'secondary'}`} disabled={disabled} onClick={() => choose(() => setKind('model'))}>{copy.modelProfile}</button>}
    </div>
    {error && <p className="text-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <CustomSelect ariaLabel={kind === 'server' ? copy.serverProfile : copy.modelProfile} value={profile.id} options={(kind === 'server' ? profiles.server : profiles.model).map(item => ({ value: item.id, label: item.name }))}
      onChange={id => choose(() => kind === 'server' ? setServerId(id) : setModelId(id))} disabled={disabled} />
    <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => {
      const patch = kind === 'server' ? serverProfilePatch(server) : modelProfilePatch(model);
      onLoad({ ...patch, runtime_defaults: [...(cfg.runtime_defaults ?? []).filter(key => REQUEST_DEFAULT_KEYS.includes(key) === (kind === 'server')), ...(profile.runtime_defaults ?? [])] },
        kind === 'server' ? { serverProfileId: server.id } : { modelProfileId: model.id, systemPrompt: model.system_prompt });
    }}>{copy.load}</button>
    <details className="model-settings-shared"><summary>{copy.shared}</summary><p className="app-section-hint">{copy.sharedHint}</p>
      <label>{copy.profileName}<input className="app-input" value={name ?? profile.name} disabled={disabled} maxLength={120} onChange={event => setName(event.target.value)} /></label>
      {kind === 'model' && <><label>{copy.prompt}<textarea className="app-input" rows={4} value={prompt ?? model.system_prompt} disabled={disabled} onChange={event => setPrompt(event.target.value)} /></label>
        <label>{copy.stop}<textarea className="app-input" rows={3} value={stop ?? model.stop_strings.join('\n')} disabled={disabled} onChange={event => setStop(event.target.value)} /></label></>}
      <div className="model-settings-presets">
        {dirty && <button type="button" className="app-button app-button--ghost" disabled={disabled} onClick={clear}>{copy.discard}</button>}
        <button type="button" className="app-button app-button--secondary" disabled={disabled || !(name ?? profile.name).trim()} onClick={() => save(false)}>{copy.saveProfile}</button>
        <button type="button" className="app-button app-button--secondary" disabled={disabled || !(name ?? profile.name).trim()} onClick={() => save(true)}>{copy.newProfile}</button>
        <button type="button" className="app-button app-button--danger" disabled={disabled || (kind === 'server' ? profiles.server : profiles.model).length <= 1} onClick={() => setDeletePending(true)}>{copy.deleteProfile}</button>
      </div>
      {deletePending && <div className="model-settings-confirm" role="alert"><p>{copy.profileDeleteConfirm}</p><div>
        <button type="button" className="app-button app-button--danger" disabled={disabled} onClick={() => { try { if (kind === 'server') deleteServerProfile(server.id); else deleteModelProfile(model.id); setProfiles(loadProfiles(cfg, cfg.active_model)); clear(); setNotice(copy.profileDeleted); } catch (cause) { setError(String(cause)); } }}>{copy.deleteProfile}</button>
        <button type="button" className="app-button app-button--secondary" onClick={() => setDeletePending(false)}>{copy.cancel}</button>
      </div></div>}
    </details>
    {switchPending && <div className="model-settings-confirm" role="alert"><p>{copy.discardTitle}</p><div>
      <button type="button" className="app-button app-button--danger" onClick={() => { clear(); switchPending(); setSwitchPending(null); }}>{copy.discard}</button>
      <button type="button" className="app-button app-button--secondary" onClick={() => setSwitchPending(null)}>{copy.keep}</button>
    </div></div>}
  </div>;
}
