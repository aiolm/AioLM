import * as api from '../../shared/api';
import { modelDisplayName, normalizeDisplayPath, normalizeDisplayText, restoreDisplayPath } from '../../shared/lib/displayPaths';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import Switch from '../../shared/ui/Switch';
import { TuningOptionLabel, TuningOptionsContext } from '../tuning/TuningOptionMetadata';
import DraftAdvancedEditor from './DraftAdvancedEditor';
import DraftGpuEditor from './DraftGpuEditor';
import DraftTuningEditor from './DraftTuningEditor';
import './model-settings.css';
import { ProviderOptions } from './ProviderControls';
import SettingsPasteBox from './SettingsPasteBox';
import type { ModelSettingsDialogController } from './useModelSettingsDialogController';
export default function ModelSettingsEditors({ controller }: { controller: ModelSettingsDialogController }) {
  const { onManageRuntimes, copy, help, profileCopy, id, cfg, provider, llama, external, latest, section, setError, setProviderOptionsPending, editorRevision, resourceError, setResourceRevision, runtime, catalog, contextLimit, disabled, benchmark, profiles, manageRuntimes, setFieldInvalid, change, device, editorKey } = controller;
  const sidecar = (key: 'mmproj' | 'spec_draft_model', label: string, vision: boolean) => <TuningOptionsContext.Provider value={runtime}><label><TuningOptionLabel id={`${id}-${key}-label`} fieldKey={key} label={label} />
    <CustomSelect ariaLabelledBy={`${id}-${key}-label`} ariaDescribedBy={`${id}-${key}-help`} value={cfg[key]} disabled={disabled} onInputChange={value => change({ [key]: restoreDisplayPath(cfg[key], value) })} options={[{ value: '', label: copy.none }, ...catalog.models.filter(model => model.is_vision === vision && (model.artifact ? model.artifact.format === 'gguf' : /\.(gguf|mmproj)$/i.test(model.path))).map(model => ({ value: model.path, label: normalizeDisplayText(model.name), icon: <ModelIcon model={model.name} />, disabled: !!model.shards?.missing.length })),
      ...(cfg[key] && !catalog.models.some(model => model.path === cfg[key]) ? [{ value: cfg[key], label: modelDisplayName(cfg[key]), icon: <ModelIcon model={cfg[key]} /> }] : [])]} onChange={value => change({ [key]: value })} placeholder={copy.path} />
    <span id={`${id}-${key}-help`} className="app-section-hint">{vision ? help.projector : help.draftModel}</span>
  </label></TuningOptionsContext.Provider>;
  return <>
            {!external && <div hidden={section !== 'runtime'} className="model-settings-fields">
              <div className="model-settings-section-heading"><h3>{copy.runtime}</h3>{onManageRuntimes && <button type="button" className="app-button app-button--ghost app-button--sm" data-icon="settings" onClick={manageRuntimes}>{copy.manageRuntime}</button>}</div>
              {(resourceError || llama && runtime.error) && <FeedbackBanner tone="warning" action={{ label: copy.refresh, onClick: () => { setResourceRevision(value => value + 1); if (llama) runtime.refresh(); } }}>{normalizeDisplayText(resourceError || runtime.error || '')}</FeedbackBanner>}
              {llama && <TuningOptionsContext.Provider value={runtime}><DraftGpuEditor key={editorKey} placement={cfg.gpu} device={device} disabled={disabled || runtime.loading} onChange={gpu => change({ gpu })} draftDevice={cfg.spec_draft_device} onDraftDeviceChange={spec_draft_device => change({ spec_draft_device })} onInvalid={setFieldInvalid} /></TuningOptionsContext.Provider>}
            </div>}
            {!benchmark && (external ? section === 'prompt' : section === 'sampling') && <div className="model-settings-prompt"><label htmlFor={`${id}-system-prompt`}>{profileCopy.prompt}</label><textarea id={`${id}-system-prompt`} className="app-textarea" value={profiles.systemPrompt} disabled={disabled} rows={3} onChange={event => profiles.setSystemPrompt(event.target.value)} /><small className="app-section-hint">{external ? copy.promptScope : profileCopy.promptHint}</small></div>}
            <div hidden={!llama || !['tuning', 'sampling', 'reasoning', 'adapters'].includes(section)}>
              <div hidden={section !== 'adapters'} className="model-settings-fields">
                {sidecar('mmproj', copy.projector, true)}{sidecar('spec_draft_model', copy.draftModel, false)}
                <h3>LoRA</h3><p id={`${id}-lora-help`} className="app-section-hint">{help.loraPath}</p>
                {cfg.lora_adapters.map((adapter, index) => <div key={adapter.path} className="model-settings-lora app-card app-card--tight"><strong title={normalizeDisplayPath(adapter.path)}><ModelIcon model={adapter.path} />{modelDisplayName(adapter.path)}<ModelBadges mode="compact" model={adapter.path} localPath={adapter.path} /></strong><span className="model-settings-lora-toggle"><label htmlFor={`${id}-lora-${index}-enabled`}>{copy.enabled}</label><Switch id={`${id}-lora-${index}-enabled`} aria-describedby={`${id}-lora-enabled-help`} checked={adapter.enabled} onChange={enabled => change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, enabled } : item) })} /></span>
                  <label>{copy.scale}<input className="app-input" aria-describedby={`${id}-lora-scale-help`} type="number" min="0" max="4" step="0.05" value={adapter.scale} onChange={event => { const scale = Number(event.target.value); if (Number.isFinite(scale) && scale >= 0 && scale <= 4) change({ lora_adapters: cfg.lora_adapters.map((item, i) => i === index ? { ...item, scale } : item) }); }} /></label>
                  <button type="button" className="app-button app-button--ghost app-button--danger app-button--sm" data-icon="delete" onClick={() => change({ lora_adapters: cfg.lora_adapters.filter((_, i) => i !== index) })}>{copy.remove}</button></div>)}
                {cfg.lora_adapters.length > 0 && <div className="app-section-hint"><p id={`${id}-lora-enabled-help`}>{help.loraEnabled}</p><p id={`${id}-lora-scale-help`}>{help.loraScale}</p></div>}
                <button type="button" className="app-button app-button--secondary" aria-describedby={`${id}-lora-help`} data-icon="add" onClick={() => void api.pickLoraAdapter().then(path => { if (path) change({ lora_adapters: [...latest.current.lora_adapters.filter(item => item.path !== path), { path, enabled: true, scale: 1 }] }); }).catch(cause => setError(String(cause)))}>{copy.addLora}</button>
              </div>
              <DraftTuningEditor key={editorKey} cfg={cfg} section={section} disabled={disabled} benchmark={benchmark} runtime={runtime} contextLimit={contextLimit} onChange={change} onInvalid={setFieldInvalid} />
            </div>
            <div hidden={section !== 'advanced' || !llama}>{llama && <><SettingsPasteBox cfg={cfg} options={runtime.options} disabled={disabled} benchmark={benchmark} onChange={change} /><DraftAdvancedEditor key={editorKey} cfg={cfg} options={runtime.options} verified={runtime.verified} disabled={disabled} benchmark={benchmark} onChange={change} onInvalid={setFieldInvalid} /></>}</div>
            {/* Profile selection can save before an option tab is visited. Keep
                provider validation active and retain field drafts across tabs. */}
            {external && <div hidden={section !== 'options'}><p className="app-section-hint">{copy.externalOptions}</p><ProviderOptions benchmark={benchmark} collapseTools hideDefaultsReset key={`${provider}:${editorRevision}`} cfg={cfg} disabled={disabled} onChange={change} onInvalid={setFieldInvalid} onChecking={setProviderOptionsPending} /></div>}
            {!llama && !external && <div hidden={section === 'model'}><ProviderOptions benchmark={benchmark} key={`${provider}:${editorRevision}`} section={section} cfg={cfg} disabled={disabled} onChange={change} onInvalid={setFieldInvalid} onChecking={setProviderOptionsPending} /></div>}
            {llama && section === 'advanced' && <ProviderOptions benchmark={benchmark} editor="custom" key={`${provider}:${editorRevision}`} cfg={cfg} disabled={disabled} onChange={change} onInvalid={setFieldInvalid} onChecking={setProviderOptionsPending} />}
  </>;
}
