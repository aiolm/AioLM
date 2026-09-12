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
      if (settings) settings.open({ target: { kind: 'default' }, config: { ...store.cfg, ...previewExecution(store.cfg, model.path), active_model: model.path } });
      else await onSelectModel(model.path);
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="model-workspace">
    {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{normalizeDisplayText(error)}</FeedbackBanner>}
    <div className="model-workspace-library"><ModelsPanel store={store} onSelectModel={select} compact active={active} /></div>
  </div>;
}
