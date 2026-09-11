import { useEffect, useRef, useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import * as api from '../../shared/api/index';
import { useI18n } from '../../shared/i18n/i18n';
import { executionText } from '../../shared/i18n/executionI18n';
import { useDraftGuard } from '../../shared/state/draftGuard';
import type { ViewId } from '../../shared/types/navigation';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { normalizeDisplayPath } from '../../shared/lib/displayPaths';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ModelsPanel from './Models';
import ExecutionProfiles from '../profiles/ExecutionProfiles';
import RuntimeGpuAssignment from '../runtimes/RuntimeGpuAssignment';
import { useServerOptions } from '../tuning/useServerOptions';
import { useTuningController } from '../tuning/useTuningController';
import { TuningEditor } from '../tuning/Tuning';
import { TuningDefaultsContext } from '../tuning/TuningDefaultField';
import { TuningOptionsContext } from '../tuning/TuningOptionMetadata';
import NumericFieldGrid from '../tuning/NumericFieldGrid';
import { SERVER_FIELDS } from '../tuning/tuningFields';
import { tuningDisplayConfig } from '../tuning/tuningResetState';

export type ExecutionSection = 'setup' | 'tuning' | 'profiles' | 'lora' | 'gpu';
type Props = {
  store: AppStore; active: boolean; section: { id: ExecutionSection; revision: number };
  onNavigate: (view: ViewId) => void; onSelectModel: (path: string) => Promise<void>;
};

export default function ModelWorkspace({ store, active, section, onNavigate, onSelectModel }: Props) {
  const { locale, t } = useI18n();
  const copy = executionText[locale];
  const guard = useDraftGuard();
  const latest = useRef(store); latest.current = store;
  const [pendingModel, setPendingModel] = useState<api.GgufModel | null>(null);
  const [switching, setSwitching] = useState(false);
  const switchLock = useRef(false);
  const [error, setError] = useState('');
  const [models, setModels] = useState<api.GgufModel[]>([]);
  const detail = useRef<HTMLDivElement>(null);
  const switchTo = async (model: api.GgufModel, stop = false) => {
    if (switchLock.current || latest.current.busy || model.shards?.missing.length) return;
    switchLock.current = true; setSwitching(true); setError('');
    try {
      await guard.run(async () => {
        if (stop) await latest.current.stop();
        await onSelectModel(model.path);
        requestAnimationFrame(() => detail.current?.focus());
      });
    } catch (cause) { setError(String(cause)); }
    finally { switchLock.current = false; setSwitching(false); }
  };
  const select = async (model: api.GgufModel) => {
    if (store.busy || switching) return;
    if (store.cfg?.active_model === model.path) { detail.current?.focus(); return; }
    if (store.status.state === 'running') { setPendingModel(model); return; }
    if (['starting', 'stopping'].includes(store.status.state)) return;
    await switchTo(model);
  };
  return <div className="model-workspace">
    <div className="model-workspace-library" inert={switching}>
      <div className="model-workspace-intro"><p>{copy.hint}</p></div>
      <ModelsPanel store={store} onSelectModel={select} onModels={setModels} compact />
    </div>
    <div className="model-workspace-detail" ref={detail} tabIndex={-1} aria-label={copy.setup} inert={switching} aria-busy={switching}>
      {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{error}</FeedbackBanner>}
      {store.cfg?.active_model ? <ExecutionSetup store={store} active={active} section={section} onNavigate={onNavigate} model={models.find(model => model.path === store.cfg?.active_model)} />
        : <div className="app-empty-state"><h2>{copy.setup}</h2><p>{copy.selectFirst}</p></div>}
    </div>
    <ConfirmDialog open={!!pendingModel} title={copy.switchTitle} description={<><p>{copy.switchBody}</p><strong>{pendingModel?.name}</strong></>}
      confirmLabel={copy.switchAction} cancelLabel={t('common.cancel')} tone="primary" busy={switching}
      onConfirm={() => { const model = pendingModel; setPendingModel(null); if (model) void switchTo(model, true); }} onCancel={() => setPendingModel(null)} />
  </div>;
}

function ExecutionSetup({ store, active, section, onNavigate, model }: Omit<Props, 'onSelectModel'> & { model?: api.GgufModel }) {
  const { t, locale } = useI18n();
  const copy = executionText[locale];
  const guard = useDraftGuard();
  const cfg = store.cfg!;
  const runtime = useServerOptions(cfg.active_backend, cfg.active_build);
  const tuning = useTuningController(store, runtime.options);
  const display = tuningDisplayConfig(cfg, runtime.options);
  const [resources, setResources] = useState<{ runtimes: api.InstalledRuntime[]; device: api.DeviceReport | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [acting, setActing] = useState(false);
  const actionLock = useRef(false);
  const advanced = useRef<HTMLDetailsElement>(null);
  const adapters = useRef<HTMLDetailsElement>(null);
  const profiles = useRef<HTMLDivElement>(null);
  const gpuSection = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active) return;
    let disposed = false;
    setLoadError('');
    void Promise.all([api.rtList(), api.deviceProfile()]).then(([runtimes, device]) => {
      if (!disposed) setResources({ runtimes, device });
    }).catch(cause => { if (!disposed) setLoadError(String(cause)); });
    return () => { disposed = true; };
  }, [active, revision]);
  useEffect(() => {
    if (!active) return;
    const target = section.id === 'tuning' ? advanced.current : section.id === 'lora' ? adapters.current : section.id === 'profiles' ? profiles.current : section.id === 'gpu' ? gpuSection.current : null;
    if (target instanceof HTMLDetailsElement) target.open = true;
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'nearest' }));
  }, [active, section]);
  const managed = !!cfg.active_backend;
  const selectedRuntime = `${cfg.active_backend}/${cfg.active_build}`;
  const missing = !!resources && managed && !resources.runtimes.some(item => item.backend === cfg.active_backend && item.build === cfg.active_build);
  const devices = runtime.capabilities ? runtimeGpuDevices(cfg.active_backend, runtime.capabilities.devices) : [];
  const device = resources?.device && managed ? { ...resources.device, profile: { ...resources.device.profile, gpus: devices } } : resources?.device ?? null;
  const disabled = store.busy || acting || ['starting', 'stopping'].includes(store.status.state);
  const incomplete = !!model?.shards?.missing.length;
  const ready = !!resources && !missing && !loadError && !incomplete;
  const act = async (kind: 'start' | 'stop' | 'restart') => {
    if (actionLock.current || disabled) return;
    actionLock.current = true; setActing(true); setError('');
    try {
      if (kind === 'stop') await store.stop();
      else await guard.run(async () => {
        if (kind === 'restart') await tuning.applyRestart();
        else await store.start();
      });
    } catch (cause) { setError(String(cause)); }
    finally { actionLock.current = false; setActing(false); }
  };
  const changeRuntime = async (value: string) => {
    if (disabled) return;
    setError('');
    try {
      await guard.run(async () => {
        const item = resources?.runtimes.find(item => `${item.backend}/${item.build}` === value);
        await store.updateConfig({ active_backend: item?.backend ?? '', active_build: item?.build ?? '' });
      });
    } catch (cause) { setError(String(cause)); }
  };
  return <div className="execution-setup">
    <header className="execution-heading">
      <div><span className="app-eyebrow">{copy.setup}{model ? ` · ${model.size_mb.toLocaleString(locale, { maximumFractionDigits: 0 })} MB` : ''}</span><h2 title={normalizeDisplayPath(cfg.active_model)}>{normalizeDisplayPath(cfg.active_model).split(/[\\/]/).pop()}</h2><p>{copy.remembered}</p></div>
      <span className={`app-status-badge app-status-badge--${store.status.state === 'running' ? 'success' : 'neutral'}`} role="status">{copy[store.status.state]}</span>
    </header>
    {(error || store.actionError || store.status.error) && <FeedbackBanner tone="error">{error || store.actionError || store.status.error}</FeedbackBanner>}
    {incomplete && <FeedbackBanner tone="error">{t('ui.modelShardsMissing', { count: model!.shards!.missing.length, total: model!.shards!.total })}</FeedbackBanner>}
    <section className="execution-runtime" aria-label={copy.runtime}>
      <div className="execution-section-heading"><label htmlFor="execution-runtime">{copy.runtime}</label><button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => onNavigate('runtimes')}>{copy.manageRuntime}</button></div>
      <select id="execution-runtime" className="app-select" value={selectedRuntime} disabled={disabled || !resources} onChange={event => void changeRuntime(event.target.value)}>
        <option value="/">{copy.systemRuntime}</option>
        {resources?.runtimes.map(item => <option key={`${item.backend}/${item.build}`} value={`${item.backend}/${item.build}`}>{item.backend} · {item.build}</option>)}
        {managed && (!resources || missing) && <option value={selectedRuntime}>{cfg.active_backend} · {cfg.active_build}</option>}
      </select>
      {missing && <p className="text-error" role="alert">{copy.runtimeMissing}</p>}
      {loadError && <FeedbackBanner tone="error" action={{ label: t('panel.retry'), onClick: () => setRevision(value => value + 1) }}>{copy.runtimeError}<span className="execution-error-detail">{loadError}</span></FeedbackBanner>}
    </section>
    <div ref={profiles} className="execution-profiles"><ExecutionProfiles store={store} modelPath={cfg.active_model} compact /></div>
    <TuningOptionsContext.Provider value={runtime}>
      <TuningDefaultsContext.Provider value={{ cfg, disabled, revision: tuning.defaultsRevision, reset: key => void tuning.resetRuntimeDefaults(key) }}>
        <section className="execution-quick" aria-label={copy.quick}>
          <h3>{copy.quick}</h3>
          <div className="execution-numeric-fields"><NumericFieldGrid fields={SERVER_FIELDS.filter(field => ['ctx_size', 'ngl'].includes(field.key))} cfg={display} drafts={tuning.numericDrafts} disabled={disabled}
            onChange={(key, value) => tuning.setNumericDrafts(drafts => ({ ...drafts, [key]: value }))} onCommit={(field, value) => void tuning.commitNumeric(field, value)} /></div>
          <div ref={gpuSection}><RuntimeGpuAssignment t={t} device={device} placement={cfg.gpu ?? { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null }}
            disabled={disabled || !resources || runtime.loading} onChange={gpu => store.updateConfig({ gpu }).then(() => undefined)} /></div>
        </section>
      </TuningDefaultsContext.Provider>
    </TuningOptionsContext.Provider>
    <details ref={advanced} className="execution-disclosure"><summary>{copy.details}</summary>
      <TuningEditor store={store} runtime={runtime} tuning={tuning} embedded onNavigate={view => {
        if (view === 'runtimes') gpuSection.current?.scrollIntoView({ block: 'nearest' });
        else if (view === 'models' || view === 'lora') { if (adapters.current) { adapters.current.open = true; adapters.current.scrollIntoView({ block: 'nearest' }); } }
        else onNavigate(view);
      }} />
    </details>
    <details ref={adapters} className="execution-disclosure"><summary>{copy.adapters}</summary>
      <div className="execution-projector"><label htmlFor="execution-projector">{t('ui.profileVisionProjector')}</label>
        <input id="execution-projector" className="app-input" value={tuning.serverTextValue('mmproj')} disabled={disabled || !tuning.projectorEditable}
          onChange={event => tuning.setServerTextDrafts(drafts => ({ ...drafts, mmproj: event.target.value }))} onBlur={event => { if (tuning.serverTextDrafts.mmproj !== undefined) void tuning.commitServerText('mmproj', event.target.value); }} />
      </div><ModelsPanel store={store} focus="lora" compact />
    </details>
    <footer className="execution-footer">
      <p>{store.status.state === 'running' ? copy.restartHint : copy.ready}</p>
      <div>{store.status.state === 'running' ? <>
        <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => void act('stop')}>{t('action.stop')}</button>
        <button type="button" className="app-button app-button--primary" disabled={disabled || !ready} onClick={() => void act('restart')}>{t('extra.applyRestart')}</button>
      </> : <button type="button" className="app-button app-button--primary" disabled={disabled || !ready} onClick={() => void act('start')}>{t('action.start')}</button>}</div>
    </footer>
  </div>;
}
