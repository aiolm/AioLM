import { useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import type { ViewId } from '../../shared/types/navigation';
import type { GgufModel } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { modelActions } from '../../shared/i18n/modelActions';
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from './modelExecutionState';
import ModelsPanel from './Models';

export type ExecutionSection = 'setup' | 'tuning' | 'profiles' | 'lora' | 'gpu';
type Props = { store: AppStore; active: boolean; section: { id: ExecutionSection; revision: number }; onNavigate: (view: ViewId) => void; onSelectModel: (path: string) => Promise<void> };

export default function ModelWorkspace({ store, onSelectModel }: Props) {
  const { locale, t } = useI18n();
  const copy = modelActions(locale);
  const settings = useModelSettings();
  const [error, setError] = useState('');
  const select = async (model: GgufModel) => {
    if (!store.cfg || model.shards?.missing.length) return;
    try {
      if (settings) settings.open({ target: { kind: 'default' }, config: { ...store.cfg, ...previewExecution(store.cfg, model.path), active_model: model.path } });
      else await onSelectModel(model.path);
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="model-workspace">
    <div className="model-workspace-library"><ModelsPanel store={store} onSelectModel={select} compact /></div>
    <div className="model-workspace-detail">
      {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{normalizeDisplayText(error)}</FeedbackBanner>}
      <div className="execution-setup">
        <header className="execution-heading"><div><span className="app-eyebrow">{copy.defaultScope}</span><h2 title={normalizeDisplayPath(store.cfg?.active_model ?? '')}>{modelDisplayName(store.cfg?.active_model ?? '') || t('load.noModel')}</h2></div></header>
        {store.status.state === 'running' && <p>{copy.current}: <strong>{modelDisplayName(store.status.model ?? '')}</strong></p>}
        {store.cfg?.active_model && <p>{store.cfg.active_backend || t('load.pathRuntime')} · {store.cfg.active_build}</p>}
        <div className="execution-footer"><button type="button" className="app-button app-button--primary" disabled={!store.cfg || !settings} onClick={() => settings?.open({ target: { kind: 'default' }, section: store.cfg?.active_model ? 'runtime' : 'model' })}>{store.cfg?.active_model ? copy.configure : copy.choose}</button></div>
      </div>
    </div>
  </div>;
}
