import { type ReactNode } from 'react';
import * as api from '../../shared/api';
import { executionSettings } from '../../shared/config/executionSettings';
import { type ProfileApplication } from '../../shared/config/settingsProfiles';
import { type Locale } from '../../shared/i18n/i18n';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { modelDisplayName,normalizeDisplayPath,normalizeDisplayText } from '../../shared/lib/displayPaths';
import { runSetupGapMessage } from '../../shared/runtime/runReadiness';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import { OverlayContainerContext } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import ModelName from '../../shared/ui/ModelName';
import ProgressBar from '../../shared/ui/ProgressBar';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import TabNav from '../../shared/ui/TabNav';
import './model-settings.css';
import { modelSettingsCopy } from './modelSettingsCopy';
import ModelSettingsEditors from './ModelSettingsEditors';
import ModelSettingsModelPicker from './ModelSettingsModelPicker';
import { profileFieldLabel } from './profileControlCopy';
import { type ProfileCommitResult,type ProfileEditorResult } from './profileEditor';
import { resetProfileSettings } from './profileResetState';
import { describeLaunchFailure } from './profileStatusCopy';
import { ProviderRuntimeControl } from './ProviderControls';
import ResourceEstimatePanel from './ResourceEstimatePanel';
import SettingsChangeList,{ changeCount } from './SettingsChangeList';
import SettingsFlowNav from './SettingsFlowNav';
import SettingsProfileControl from './SettingsProfileControl';
import { useModelSettingsDialogController } from './useModelSettingsDialogController';
import { ProfileRuntimeSchemaContext } from './useProfileRuntimeSchema';
export interface ModelSettingsDialogProps {
  open: boolean; initialConfig: api.AppConfig; targetLabel: string;
  mode: 'default' | 'session' | 'benchmark' | 'project'; initialSection?: string;
  /** The owner closes this editor after durable save and launch acceptance. */
  onApply: (cfg: api.AppConfig, intent: 'save' | 'start', profiles: ProfileEditorResult) => Promise<void>;
  onProfileCommit: (cfg: api.AppConfig, edit: ProfileEditorResult, applyTarget: boolean) => Promise<ProfileCommitResult>;
  onReloadProfile: (draft: api.AppConfig) => Promise<ProfileCommitResult>;
  onClose: () => void; onManageRuntimes?: () => void;
  busy?: boolean; startPending?: boolean; liveState?: string;
  preflightState?: 'preparing' | 'saving' | 'checking' | 'loading' | 'cancelling';
  liveConfig?: api.AppConfig;
  initialApplication?: ProfileApplication; liveApplication?: ProfileApplication; sessionId?: string;
  requireModelSelection?: boolean;
  executionNotice?: ReactNode; onCancelStart?: () => void;
  /** Stops this target. Offered in place of a launch while the model is up. */
  onStop?: () => void;
}
/** A target-scoped editor. No configuration or model-profile writes happen on preview. */
export function ModelSettingsDialog(props: ModelSettingsDialogProps) {
  const controller = useModelSettingsDialogController(props);
  const { open, targetLabel, mode, onClose, onManageRuntimes, liveState, executionNotice, onCancelStart, onStop, preflightState, t, locale, copy, flowCopy, profileCopy, id, baseline, settings, cfg, llama, external, runtimeSchema, setProviderReady, profileBannerTarget, setProfileBannerTarget, sections, section, error, applying, starting, pending, setPending, pendingCancel, cancelPending, confirmSave, setConfirmSave, invalid, providerOptionsPending, profileDirty, setProfileDirty, resourceError, resourceRevision, setResourceRevision, overlay, setOverlay, runtime, catalog, selectedMetadata, disabled, closingStart, benchmark, profiles, runtimeSelection, dialog, heading, body, scroller, startButton, cancelFocus, flowHeading, tabOrientation, showSection, profilePreview, setProfilePreview, canProfile, canOptions, step, navigateStep, continueStep, manageRuntimes, running, live, serverChanged, startText, executionCopy, stateText, liveMatches, profileItems, defaultProfileId, displayId, profileInUse, saveTarget, working, pathPending, change, guarded, closeEditor, resetProfile, commitProfile, revertProfile, selectProfile, apply, runtimeKnown, runtimeMissing, runtimeSelected, chooseProvider, device, selected, compatibility, supportedInputs, compatibilityBlocked, incomplete, setupGaps, launchStage, onDialogKeyDown, onDialogFocus } = controller;
  return <ProfileRuntimeSchemaContext.Provider value={llama ? null : runtimeSchema}><dialog ref={dialog} className="app-dialog model-settings-dialog" aria-labelledby={`${id}-title`} aria-busy={disabled || undefined}
    onKeyDown={onDialogKeyDown}
    onCancel={event => {
      if (closingStart) { onClose(); return; }
      event.preventDefault();
      if (!disabled) { if (confirmSave) setConfirmSave(false); else if (pending) cancelPending(); else guarded(onClose); }
    }}>
    <OverlayContainerContext.Provider value={overlay}>
      <div className="model-settings-shell">
      <div className="model-settings-main" ref={scroller} onFocus={onDialogFocus}>
        <header className="model-settings-header"><div className="model-settings-heading"><span className="app-eyebrow">{targetLabel}{stateText ? ` · ${stateText}` : ''}</span><h2 id={`${id}-title`} ref={heading} tabIndex={-1}>{copy.title}</h2>{(step === 'options' || !!cfg.active_model) && <p className="model-settings-target" title={normalizeDisplayPath(cfg.active_model)}><ModelIcon model={cfg.active_model} /><span><ModelName model={cfg.active_model} empty={copy.model} /></span></p>}{step === 'options' && <ModelBadges mode="detail" model={cfg.active_model} metadata={selectedMetadata} artifact={selected?.artifact} />}</div>
          <button type="button" className="app-icon-button" aria-label={copy.close} disabled={disabled && !closingStart} onClick={closeEditor}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button>
        </header>
        <div inert={!!pending || confirmSave || disabled}><SettingsFlowNav step={step} runtime={runtimeSelection ? <RuntimeSelectionLabel config={cfg} /> : flowCopy.choose} profile={profileDisplayName(profiles.selected, locale)} canProfile={canProfile} canOptions={canOptions} disabled={disabled || profileDirty} onSelect={navigateStep} /></div>
        <div className={`model-settings-layout${step !== 'options' ? ' model-settings-layout--setup' : ''}`} inert={!!pending || confirmSave || disabled}>
          {step === 'options' && <TabNav items={sections.map(value => ({ id: value, label: value === 'prompt' ? copy.promptSection : copy[value] }))} active={section} onSelect={showSection} label={copy.title}
            tabId={value => `${id}-tab-${value}`} panelId={() => `${id}-panel`} orientation={tabOrientation} className="model-settings-nav" />}
          <div className="model-settings-content">
            <div className="model-settings-context" hidden={step !== 'options'}>
              <p className="model-settings-context-model" title={normalizeDisplayPath(cfg.active_model)}><ModelIcon model={cfg.active_model} /><span><ModelName model={cfg.active_model} empty={copy.model} /></span></p>
              <div ref={setProfileBannerTarget} />
            </div>
            <div className="model-settings-body" ref={body} id={`${id}-panel`} role={step === 'options' ? 'tabpanel' : 'region'} aria-labelledby={step === 'options' ? `${id}-tab-${section}` : `${id}-step-title`}>
            <h3 id={`${id}-step-title`} ref={flowHeading} tabIndex={-1}>{flowCopy[step]}</h3>
            <p className="app-section-hint">{flowCopy[`${step}Hint`]}</p>
              <div className="model-settings-runtime-selection" hidden={step !== 'runtime'}>
              <ProviderRuntimeControl cfg={cfg} disabled={disabled} onProvider={chooseProvider} onChange={change} onReady={setProviderReady} revision={resourceRevision} />
              {onManageRuntimes && <button type="button" className="app-button app-button--ghost app-button--sm" data-icon="settings" disabled={disabled} onClick={manageRuntimes}>{copy.manageRuntime}</button>}
              {runtimeSelected && runtimeKnown && runtimeMissing && <FeedbackBanner tone="warning">{copy.missingRuntime}</FeedbackBanner>}
              {(resourceError || llama && runtime.error) && <FeedbackBanner tone="warning" action={{ label: copy.refresh, onClick: () => { setResourceRevision(value => value + 1); if (llama) runtime.refresh(); } }}>{normalizeDisplayText(resourceError || runtime.error || '')}</FeedbackBanner>}
              </div>
            <div hidden={step === 'runtime'}>
            <SettingsProfileControl bannerTarget={profileBannerTarget} items={profileItems} state={working ? 'working' : 'named'} activeId={displayId} basedOnId={working ? displayId : null}
              showBanner={step !== 'runtime'} lockSelection={step === 'options'} selectionOnly={step === 'profile'} onPreviewChange={setProfilePreview}
              defaultProfileId={defaultProfileId} onSetDefault={id => commitProfile(() => profiles.prepareSetDefault(id), true)}
              modelPath={cfg.active_model} currentSettings={settings} runtimeConfig={cfg} currentPrompt={profiles.systemPrompt} defaults={executionSettings(resetProfileSettings(cfg, false))} runtimeOptions={runtime.options} runtimeVerified={runtime.verified} gpuDevices={device?.profile.gpus} full={step === 'profile'}
              disabled={disabled} resetDisabled={!llama && (runtimeSchema.pending || !runtimeSchema.view || ['stale', 'unchecked'].includes(runtimeSchema.view.help_state))} blocked={providerOptionsPending || invalid.size > 0 || pathPending} onEditingChange={setProfileDirty}
              onApply={selectProfile}
              onSaveAs={(name, scope) => commitProfile(() => profiles.prepareSaveAs(name, scope))}
              onRename={(id, name) => commitProfile(() => profiles.prepareRename(id, name))} onDelete={id => commitProfile(() => profiles.prepareDelete(id))} onRevert={revertProfile} onReset={resetProfile}
              saveAction={step !== 'runtime' && <><span id={`${id}-save-target`} className="sr-only">{saveTarget}</span><button type="button" className="app-button app-button--secondary app-button--sm" data-icon="save" aria-describedby={`${id}-save-target`} disabled={disabled || providerOptionsPending || invalid.size > 0 || profileDirty || pathPending || profileInUse} onClick={() => setConfirmSave(true)}>{applying ? copy.pending : copy.save}</button></>}>
            <div hidden={step !== 'options'}>
            {running && !liveMatches && <p className="model-settings-profile-status">{serverChanged ? profileCopy.next : profileCopy.request}</p>}
            {benchmark && <FeedbackBanner tone="info" className="model-settings-scope">{copy.benchmarkControlled}</FeedbackBanner>}
            <ModelSettingsModelPicker controller={controller} />
            <ModelSettingsEditors controller={controller} />
            </div>
            </SettingsProfileControl>
            </div>
            </div>
          </div>
        </div>
        </div>
        <footer className="model-settings-footer">
          <div className="model-settings-footer-summary" role="region" aria-label={saveTarget} tabIndex={0}>
            {(preflightState || starting) && <div className="model-settings-launch-progress">
              <p className="app-section-hint">{launchStage}</p>
              <ProgressBar label={`${targetLabel} · ${modelDisplayName(cfg.active_model)}: ${launchStage}`} />
            </div>}
            {providerOptionsPending && <p className="app-section-hint" role="status">{copy.checkingOptions}</p>}
            <div className="model-settings-notices">{profileInUse && <FeedbackBanner tone="info">{copy.profileInUse}</FeedbackBanner>}{profileDirty && <FeedbackBanner tone="warning">{copy.profilePending}</FeedbackBanner>}{pathPending && <FeedbackBanner tone="warning">{copy.pathPending}</FeedbackBanner>}{executionNotice}{error && <LaunchFailureNotice text={error} locale={locale} />}{invalid.size > 0 && <FeedbackBanner tone="error">{copy.invalid} ({[...invalid].map(key => {
              if (key === 'provider-options') return profileFieldLabel('provider_options', locale);
              if (key === 'gpu_tensor_split') return profileFieldLabel('tensor_split', locale);
              if (key.startsWith('provider:') || key.startsWith('schema:')) {
                const rawKey = key.replace(/^(?:provider|schema):/, '');
                return runtimeSchema.view?.schema.options.find(option => option.key === rawKey)?.spellings[0]?.flag ?? rawKey;
              }
              return key.startsWith('-') ? key : profileFieldLabel(key, locale);
            }).join(', ')})</FeedbackBanner>}{incomplete && <FeedbackBanner tone="error">{selected?.shards ? t('ui.modelShardsMissing', { count: selected.shards.missing.length, total: selected.shards.total }) : providerCopy[locale].files}</FeedbackBanner>}
              {compatibilityBlocked && <FeedbackBanner tone="error">{providerCopy[locale].compatibility}: {[...(compatibility?.reasons.map(reason => reason.detail) ?? []), ...(compatibility?.readiness ?? [])].join('; ') || (compatibility?.status === 'unknown' ? copy.unverifiedModel : copy.unavailable)}</FeedbackBanner>}
              {step === 'options' && !benchmark && mode !== 'project' && !live && setupGaps.length > 0 && <FeedbackBanner tone="warning" title={executionCopy.blockedTitle}><ul className="model-settings-blocked" aria-label={executionCopy.blockedTitle}>
                {setupGaps.map(gap => <li key={gap}><span>{runSetupGapMessage(gap, locale)}</span>
                  {gap === 'runtimeMissing' && onManageRuntimes && <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="settings" onClick={manageRuntimes}>{executionCopy.manageRuntime}</button>}
                </li>)}
              </ul></FeedbackBanner>}</div>
            {step === 'options' && (!external || supportedInputs !== '—') && <div className="model-settings-footer-bar">
              {llama ? <ResourceEstimatePanel cfg={cfg} options={runtime.options} verified={runtime.verified} runtimeDevices={runtime.capabilities?.devices} open={open} invalid={invalid.size > 0 || pathPending} benchmark={benchmark} /> : <span>{providerCopy[locale].modalities}: {supportedInputs}</span>}
            </div>}
          </div>
          <div className="model-settings-actions">
            {step !== 'runtime' && <button type="button" className="app-button app-button--secondary" disabled={disabled || profileDirty} onClick={() => navigateStep(step === 'profile' ? 'runtime' : 'profile')}>{step === 'profile' ? flowCopy.backRuntime : flowCopy.backProfile}</button>}
            {step !== 'options' && <button type="button" className="app-button app-button--primary" disabled={disabled || profileDirty || !runtimeSelection || step === 'profile' && !!profilePreview && profilePreview !== displayId} onClick={continueStep}>{step === 'runtime' ? flowCopy.nextProfile : flowCopy.nextOptions}</button>}
            {step === 'options' && !benchmark && mode !== 'project' && (live
              ? <button type="button" className="app-button app-button--danger" disabled={disabled || liveState === 'stopping' || !onStop} onClick={() => onStop?.()}>{liveState === 'stopping' ? t('status.working') : t('action.stop')}</button>
              : <button type="button" ref={startButton} className="app-button app-button--primary" disabled={disabled || providerOptionsPending || invalid.size > 0 || profileDirty || pathPending || !cfg.active_model.trim() || !runtimeSelected || incomplete || compatibilityBlocked || (!llama && catalog.loading) || !runtimeKnown || runtimeMissing} onClick={() => void apply('start')}>{startText}</button>)}
            {disabled && onCancelStart && <button type="button" className="app-button app-button--secondary" data-icon="close" disabled={preflightState === 'cancelling'} onClick={event => { cancelFocus.current = document.activeElement === event.currentTarget; onCancelStart(); }}>{copy.cancel}</button>}
          </div>
        </footer>
      </div>
      <div ref={setOverlay} className="model-settings-overlays" inert={disabled || !!pending || confirmSave} />
      {pending && <ConfirmDialog open={open} title={copy.discardTitle} description={copy.discardBody}
        confirmLabel={copy.discard} cancelLabel={copy.keep} busy={disabled}
        onCancel={cancelPending} onConfirm={() => { const action = pending; pendingCancel.current = null; setPending(null); action(); }} />}
      {confirmSave && <ConfirmDialog open={open} title={copy.saveConfirmTitle.replace('{name}', profileDisplayName(profiles.selected, locale))}
        description={changeCount(baseline, settings, profiles.savedApplication.system_prompt, profiles.systemPrompt) === 0
          ? copy.saveConfirmUnchanged
          : <SettingsChangeList saved={baseline} current={settings} savedPrompt={profiles.savedApplication.system_prompt} currentPrompt={profiles.systemPrompt}
            runtimeOptions={runtime.options} runtimeVerified={runtime.verified} runtimeConfig={cfg} />}
        scrollableDescription
        confirmLabel={copy.saveConfirmAction} cancelLabel={copy.cancel} tone="primary" busy={disabled}
        onCancel={() => setConfirmSave(false)} onConfirm={() => { setConfirmSave(false); void apply('save'); }} />}
    </OverlayContainerContext.Provider>
  </dialog></ProfileRuntimeSchemaContext.Provider>;
}
/** A launch failure shows a short summary first; the raw server log stays one click away. */
function LaunchFailureNotice({ text, locale }: { text: string; locale: Locale }) {
  const view = describeLaunchFailure(text, locale);
  const copy = modelSettingsCopy[locale];
  if (!view.detail) return <FeedbackBanner tone="error">{normalizeDisplayText(text)}</FeedbackBanner>;
  return <FeedbackBanner tone="error">
    {view.summary.split('\n').map((line, index) => <p key={index}>{normalizeDisplayText(line)}</p>)}
    <details><summary>{copy.failureDetails}</summary><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-left text-xs">{normalizeDisplayText(view.detail)}</pre></details>
  </FeedbackBanner>;
}
export default ModelSettingsDialog;
