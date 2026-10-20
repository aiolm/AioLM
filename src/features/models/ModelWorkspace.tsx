import { registeredProviderIds, modelLoadable, modelSelectable, providerOf } from '../../shared/api/providers';
import { useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import type { ViewId } from '../../shared/types/navigation';
import type { GgufModel } from '../../shared/api/types';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from './modelExecutionState';
import ModelsPanel from './Models';

export type ExecutionSection = 'setup' | 'tuning' | 'profiles' | 'lora' | 'gpu';
type Props = { store: AppStore; active: boolean; section: { id: ExecutionSection; revision: number }; onNavigate: (view: ViewId) => void; onSelectModel: (path: string) => Promise<void> };

export default function ModelWorkspace({ store, onSelectModel, active }: Props) {
  const settings = useModelSettings();
  const [error, setError] = useState('');
  const select = async (model: GgufModel) => {
    if (!store.cfg || model.shards?.missing.length) return;
    try {
      if (settings) {
        const provider = providerOf(store.cfg);
        const selectable = modelSelectable(model, provider);
        const active_provider = selectable ? provider : registeredProviderIds().find(candidate => modelLoadable(model, candidate)) ?? provider;
        const selected = { ...store.cfg, active_provider };
        settings.open({ target: { kind: 'default' }, config: { ...selected, ...previewExecution(selected, model.path), active_model: model.path,
          active_runtime: selectable ? store.cfg.active_runtime : '' } });
      }
      else await onSelectModel(model.path);
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="model-workspace">
    {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{normalizeDisplayText(error)}</FeedbackBanner>}
    <div className="model-workspace-library"><ModelsPanel store={store} onSelectModel={select} compact active={active} /></div>
  </div>;
}
