import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { executionConfig, executionSettings, serverSettingsChanged, type ExecutionSettings } from '../../shared/config/executionSettings';
import { ensureProfileLibrary, RUNTIME_SELECTION_KEYS, settingsEqual } from '../../shared/config/settingsProfiles';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import { executionText } from '../../shared/i18n/executionI18n';
import { useI18n } from '../../shared/i18n/i18n';
import { profileDisplayName } from '../../shared/i18n/profileNames';
import { normalizeDisplayPath, restoreDisplayPath } from '../../shared/lib/displayPaths';
import { isLifecycleCancellation } from '../../shared/lib/serverLifecycle';
import { runSetupGaps } from '../../shared/runtime/runReadiness';
import { runtimeGpuDevices } from '../../shared/runtime/sessionUtils';
import { useImeEnterGuard } from '../../shared/ui/useImeEnterGuard';
import { previewExecution } from '../models/modelExecutionState';
import { useServerOptions } from '../tuning/useServerOptions';
import './model-settings.css';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { ModelSettingsDialogProps } from './ModelSettingsDialog';
import { modelSettingsHelp } from './modelSettingsHelp';
import { appliedProfile, SettingsDeliveryError, type ProfileCommitResult } from './profileEditor';
import { resetProfileOptions } from './profileResetState';
import { profileStatusCopy } from './profileStatusCopy';
import { runtimeDefaultsCopy } from './runtimeDefaultsCopy';
import { settingsFlowCopy } from './settingsFlowCopy';
import { useModelCatalog } from './useModelCatalog';
import { useModelSettingsDialogSurface } from './useModelSettingsDialogSurface';
import { useProfileEditor } from './useProfileEditor';
import { useProfileRuntimeSchema } from './useProfileRuntimeSchema';
import { useSelectedModelMetadata } from './useSelectedModelMetadata';
const normalizeSection = (section = 'model') => ({ setup: 'runtime', gpu: 'runtime', lora: 'adapters', server: 'tuning', options: 'advanced', escape: 'advanced' }[section] ?? section);
export function useModelSettingsDialogController({ open, initialConfig, targetLabel, mode, initialSection, onApply, onProfileCommit, onReloadProfile, onClose, onManageRuntimes,
  busy = false, startPending = false, liveState, liveConfig, initialApplication, liveApplication, sessionId = 'default', executionNotice, onCancelStart, onStop, requireModelSelection = false, preflightState }: ModelSettingsDialogProps) {
  const { t, locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const flowCopy = settingsFlowCopy[locale];
  const help = modelSettingsHelp[locale];
  const profileCopy = profileStatusCopy[locale];
  const id = useId();
  const saved = useRef<api.AppConfig | null>(null);
  if (saved.current === null) saved.current = structuredClone(initialConfig);
  const initial = useRef({ ...saved.current, ...(requireModelSelection ? { active_model: '' } : {}) });
  const [baseline, setBaseline] = useState(() => executionSettings(initial.current));
  const [settings, setSettings] = useState<ExecutionSettings>(() => executionSettings(initial.current));
  const cfg = useMemo(() => executionConfig(initialConfig, settings), [initialConfig, settings]);
  const provider = api.providerOf(cfg);
  const llama = provider === 'llama.cpp';
  const external = api.isExternalProvider(provider);
  const runtimeSchema = useProfileRuntimeSchema(cfg, open && !llama);
  const providerDrafts = useRef<Partial<Record<api.ProviderId, { settings: ExecutionSettings; prompt: string }>>>({});
  const [providerReady, setProviderReady] = useState<boolean | null>(null);
  const [profileBannerTarget, setProfileBannerTarget] = useState<HTMLDivElement | null>(null);
  const latest = useRef(cfg); latest.current = cfg;
  const [requestedSection, setSection] = useState(normalizeSection(initialSection));
  const sections = external
    ? (['model', 'options', 'prompt'] as const).filter(value => mode !== 'benchmark' || value !== 'prompt')
    : ['model', 'runtime', 'tuning', 'sampling', 'reasoning', 'adapters', 'advanced'] as const;
  // Existing deep links keep working when an external runtime has no native
  // tuning categories. Derive a valid panel during engine switches as well.
  const mappedSection = external && ['runtime', 'tuning', 'sampling', 'reasoning', 'adapters', 'advanced'].includes(requestedSection)
    ? 'options' : !external && requestedSection === 'prompt' ? 'sampling' : requestedSection;
  const section = sections.find(value => value === mappedSection) ?? (external ? 'options' : 'model');
  const [query, setQuery] = useState('');
  const [pathDraft, setPathDraft] = useState(normalizeDisplayPath(initial.current.active_model));
  const [error, setError] = useState('');
  const [applying, setApplying] = useState(false);
  const [starting, setStarting] = useState(false);
  const applyLock = useRef(false);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const pendingCancel = useRef<(() => void) | null>(null);
  const cancelPending = () => { pendingCancel.current?.(); pendingCancel.current = null; setPending(null); };
  // A profile is a wide snapshot, and the editor gives no sense of how much of it
  // an edit touched. Pressing save shows what it would rewrite, from and to, and
  // waits: overwriting a profile is not undoable from here.
  const [confirmSave, setConfirmSave] = useState(false);
  const [invalid, setInvalid] = useState<Set<string>>(new Set());
  const [providerOptionsPending, setProviderOptionsPending] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [editorRevision, setEditorRevision] = useState(0);
  const [resources, setResources] = useState<{ runtimes: api.InstalledRuntime[]; device: api.DeviceReport | null }>({ runtimes: [], device: null });
  // Whether the current installed-runtime query has answered. An empty
  // list is a real answer — no runtime installed — and must report the selected
  // runtime as missing; only a list that has not loaded yet stays unchecked.
  const [resourcesLoaded, setResourcesLoaded] = useState(false);
  const [resourceError, setResourceError] = useState('');
  const [resourceRevision, setResourceRevision] = useState(0);
  const [overlay, setOverlay] = useState<HTMLDivElement | null>(null);
  const runtime = useServerOptions(llama ? cfg.active_backend : '', llama ? cfg.active_build : '', open && llama && !!cfg.active_backend && !!cfg.active_build);
  const catalog = useModelCatalog(initialConfig.models_dir, open, cfg);
  const selectedMetadata = useSelectedModelMetadata(llama ? cfg.active_model : '', open && llama);
  const contextLimit = selectedMetadata?.context_length;
  const disabled = busy || applying;
  const closingStart = (starting || startPending) && (preflightState === 'checking' || preflightState === 'loading' || liveState === 'starting');
  const benchmark = mode === 'benchmark';
  const savedApplication = useMemo(() => initialApplication ?? appliedProfile(initialConfig, sessionId), [initialApplication, initialConfig, sessionId]);
  const profiles = useProfileEditor(initialConfig, cfg, savedApplication, benchmark, entry => profileDisplayName(entry, locale));
  const runtimeSelection = llama ? cfg.active_backend && cfg.active_build ? `${cfg.active_backend}:${cfg.active_build}` : '' : cfg.active_runtime ?? '';
  const runtimeKey = JSON.stringify([provider, runtimeSelection]);
  const { dialog, heading, body, scroller, startButton, cancelFocus, flowHeading, tabOrientation, showSection, setFlow, profilePreview, setProfilePreview, canProfile, canOptions, step, navigateStep, continueStep, onDialogKeyDown, onDialogFocus } = useModelSettingsDialogSurface({ open, disabled, initialSection, runtimeSelection, runtimeKey, profileId: profiles.selected.id, profileDirty, setSection });
  const manageRuntimes = () => {
    if (disabled || pending || confirmSave) return;
    onManageRuntimes?.();
  };
  const running = liveState === 'running' && (mode === 'default' || mode === 'session');
  // This target holds a server process right now, loading one, or shutting one
  // down. Launching again from here would race that process, so the footer
  // offers the only move that makes sense on a live target: stopping it.
  const live = (mode === 'default' || mode === 'session') && ['running', 'starting', 'stopping'].includes(liveState ?? '');
  const serverChanged = running && serverSettingsChanged(liveConfig ?? initial.current, cfg);
  const startText = running ? (liveConfig ?? initial.current).active_model === cfg.active_model ? copy.restart : copy.switchStart : copy.start;
  const executionCopy = executionText[locale];
  const stateText = liveState && ['stopped', 'starting', 'stopping', 'running', 'failed', 'crashed'].includes(liveState) ? executionText[locale][liveState as 'running'] : liveState;
  const valuesDirty = cfg.active_model !== initial.current.active_model || !settingsEqual(settings, executionSettings(initial.current));
  const enteredPath = restoreDisplayPath(cfg.active_model, pathDraft.trim());
  const pathImeHandlers = useImeEnterGuard<HTMLInputElement>(pathDraft, event => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); chooseModel(enteredPath);
  });
  const dirty = valuesDirty || invalid.size > 0 || profileDirty || profiles.working || enteredPath !== cfg.active_model;
  const liveMatches = running && !!liveConfig && cfg.active_model === liveConfig.active_model && settingsEqual(settings, executionSettings(liveConfig)) && profiles.systemPrompt === (liveApplication?.system_prompt ?? '');
  // Default protection is a property of the library, not of an individual row.
  // Normalize once when it changes; typing an option must not clone every
  // saved profile once for each visible profile.
  const { profileItems, defaultProfileId } = useMemo(() => {
    const library = ensureProfileLibrary(profiles.library, provider);
    const protectedIds = new Set(Object.values(library.provider_defaults ?? {}));
    const defaultId = library.provider_defaults?.[provider] ?? library.default_profile_id;
    return {
      defaultProfileId: library.entries.find(entry => entry.id === defaultId)!.id,
      profileItems: profiles.library.entries.filter(entry => (entry.provider ?? 'llama.cpp') === provider).map(entry => {
        const deletionReason = protectedIds.has(entry.id) ? 'default' as const : undefined;
        return { ...entry, name: profileDisplayName(entry, locale), deletable: !deletionReason, deletionReason };
      }),
    };
  }, [profiles.library, provider, locale]);
  const displayId = profiles.selected.id;
  // The live process was launched from this profile's settings. Overwriting it
  // would leave the profile describing something the running server is not, so
  // editing stays open and only the save onto that profile is withheld.
  const profileInUse = live && !!liveApplication?.profile_id && displayId === liveApplication.profile_id;
  const saveTarget = copy.saveTarget.replace('{name}', profileDisplayName(profiles.selected, locale));
  const working = profiles.working || invalid.size > 0;
  const dirtyRef = useRef(dirty); dirtyRef.current = dirty;
  const pathPending = enteredPath !== cfg.active_model;
  const currentConfig = useRef(initialConfig); currentConfig.current = initialConfig;
  useEffect(() => {
    if (!open) return;
    let active = true;
    setResourceError('');
    setResourcesLoaded(false);
    void Promise.all([llama ? api.rtList() : Promise.resolve([]), api.deviceProfile()]).then(([runtimes, device]) => { if (active) { setResources({ runtimes, device }); setResourcesLoaded(true); } })
      .catch(cause => { if (active) setResourceError(String(cause)); });
    return () => { active = false; };
  }, [open, resourceRevision, llama]);
  const setFieldInvalid = useCallback((key: string, value: boolean) => { setInvalid(previous => {
    if (previous.has(key) === value) return previous;
    const next = new Set(previous); if (value) next.add(key); else next.delete(key); return next;
  }); }, []);
  const change = (patch: Partial<api.AppConfig>) => {
    if (disabled || applyLock.current) return;
    if ((['active_runtime', 'active_backend', 'active_build'] as const).some(key => key in patch && patch[key] !== latest.current[key])) {
      setFlow({ step: 'runtime', runtime: null, profile: null });
    }
    setSettings(previous => {
      const current = executionConfig(currentConfig.current, previous);
      return executionSettings({ ...current, ...withManualOverrides(current, patch) });
    });
    setError('');
  };
  const guarded = (action: () => void) => { if (disabled) return; if (dirtyRef.current) setPending(() => action); else action(); };
  // Starting has captured the draft already; dismissing only releases the UI.
  // Saves and ordinary edits still use the existing busy/discard guards.
  const closeEditor = () => { if (closingStart) onClose(); else guarded(onClose); };
  const chooseModel = (path: string) => {
    if (!path.trim() || path === cfg.active_model) return;
    const load = () => {
      try {
        const restored = previewExecution(cfg, path);
        const next = executionSettings({ ...cfg, ...restored, active_model: path,
          mmproj: restored.mmproj ?? '', spec_draft_model: restored.spec_draft_model ?? '', lora_adapters: restored.lora_adapters ?? [],
          ...(mode === 'session' ? { gpu: initial.current.gpu } : {}) });
        const assigned = executionSettings(profiles.resetModel(executionConfig(cfg, next), sessionId));
        setSettings(assigned); setBaseline(assigned); setPathDraft(normalizeDisplayPath(path)); setInvalid(new Set()); setProfileDirty(false); setEditorRevision(value => value + 1); setError('');
      } catch (cause) { setError(String(cause)); }
    };
    // Loading a model keeps the chosen runtime. Only values the load can
    // replace need a discard confirmation.
    const modelBaseline = { ...baseline, ...Object.fromEntries(RUNTIME_SELECTION_KEYS.map(key => [key, settings[key]])) };
    if (!settingsEqual(settings, modelBaseline) || invalid.size || profileDirty || profiles.working) setPending(() => load); else load();
  };
  const accept = ({ config, application }: ProfileCommitResult, applyTarget = true) => {
    initial.current = structuredClone(applyTarget ? config : { ...config, active_model: initial.current.active_model,
      ...Object.fromEntries(RUNTIME_SELECTION_KEYS.map(key => [key, initial.current[key]])) });
    saved.current = structuredClone(initial.current);
    setSettings(executionSettings(config)); setBaseline(executionSettings(config)); setPathDraft(normalizeDisplayPath(config.active_model));
    profiles.acceptSaved(config, application); setInvalid(new Set()); setProfileDirty(false); setEditorRevision(value => value + 1);
    setFlow(previous => previous.step === 'options' ? { ...previous, profile: application.profile_id ?? profiles.selected.id } : previous);
  };
  const acceptMetadata = ({ config, application }: ProfileCommitResult) => {
    initial.current = structuredClone({ ...config, active_model: initial.current.active_model,
      ...Object.fromEntries(RUNTIME_SELECTION_KEYS.map(key => [key, initial.current[key]])) });
    saved.current = structuredClone(initial.current);
    setBaseline(executionSettings(config)); profiles.acceptMetadata(config, application);
  };
  const resetProfile = () => {
    if (disabled || applyLock.current || (!llama && (runtimeSchema.pending || !runtimeSchema.view || ['stale', 'unchecked'].includes(runtimeSchema.view.help_state)))) return;
    let defaults: api.AppConfig;
    try { defaults = resetProfileOptions(cfg, benchmark, runtimeSchema.view); }
    catch { setError(runtimeDefaultsCopy[locale].order); return; }
    const changed = !settingsEqual(cfg, defaults) || invalid.size > 0 || pathPending;
    setSettings(executionSettings(defaults));
    setInvalid(new Set()); setPathDraft(normalizeDisplayPath(cfg.active_model)); setEditorRevision(value => value + 1); setError('');
    return changed;
  };
  const commitProfile = async (prepare: () => ReturnType<typeof profiles.prepareApply>, preserveDraft = false) => {
    if (disabled || applyLock.current || providerOptionsPending && !preserveDraft) return;
    applyLock.current = true; setApplying(true); setError('');
    let applyTarget = true;
    try {
      const next = prepare();
      applyTarget = next.applyTarget;
      const result = await onProfileCommit(next.config, next.edit, next.applyTarget);
      if (preserveDraft) acceptMetadata(result); else accept(result, applyTarget);
    } catch (cause) {
      if (cause instanceof SettingsDeliveryError) {
        const result = { config: cause.saved, application: cause.application };
        if (preserveDraft) acceptMetadata(result); else accept(result, applyTarget);
        setError(profileCopy.savedFailure + cause.message); return;
      }
      setError(String(cause));
      throw cause;
    } finally { applyLock.current = false; setApplying(false); }
  };
  const revertProfile = async () => {
    if (disabled || applyLock.current) return;
    applyLock.current = true; setApplying(true); setError('');
    try { accept(await onReloadProfile(structuredClone(cfg)), false); }
    catch (cause) { setError(String(cause)); throw cause; }
    finally { applyLock.current = false; setApplying(false); }
  };
  const selectProfile = (id: string) => new Promise<void>((resolve, reject) => {
    const select = () => { void commitProfile(() => {
      const profile = profiles.available.find(item => item.id === id);
      if (!profile) throw new Error('This profile is no longer available.');
      return profiles.prepareApply(profile);
    }).then(resolve, reject); };
    if (profiles.working || invalid.size > 0 || pathPending) { pendingCancel.current = resolve; setPending(() => select); }
    else select();
  });
  const apply = async (intent: 'save' | 'start') => {
    if (disabled || applyLock.current || providerOptionsPending || invalid.size || profileDirty || pathPending || intent === 'start' && !cfg.active_model.trim()) return;
    if (intent === 'save') {
      await commitProfile(() => ({ config: structuredClone(latest.current), edit: profiles.result(), applyTarget: true })).catch(() => undefined);
      return;
    }
    applyLock.current = true; setApplying(true); setStarting(true); setError('');
    try { await onApply(structuredClone(latest.current), intent, profiles.result()); setBaseline(executionSettings(latest.current)); }
    catch (cause) {
      if (cause instanceof SettingsDeliveryError) {
        saved.current = structuredClone(cause.saved); initial.current = structuredClone(cause.saved);
        setSettings(executionSettings(cause.saved)); setBaseline(executionSettings(cause.saved));
        profiles.acceptSaved(cause.saved, cause.application);
        setError(profileCopy.savedFailure + cause.message);
      } else setError(isLifecycleCancellation(cause) ? '' : String(cause));
    }
    finally { applyLock.current = false; setApplying(false); setStarting(false); }
  };
  const runtimeKnown = llama ? resourcesLoaded : providerReady !== null;
  const runtimeMissing = llama ? !!cfg.active_backend && !resources.runtimes.some(item => item.backend === cfg.active_backend && item.build === cfg.active_build) : providerReady === false;
  const runtimeSelected = llama ? !!cfg.active_backend && !!cfg.active_build : !!cfg.active_runtime;
  const chooseProvider = (nextProvider: api.ProviderId) => {
    if (nextProvider === provider) return;
    setFlow({ step: 'runtime', runtime: null, profile: null });
    providerDrafts.current[provider] = { settings: structuredClone(settings), prompt: profiles.systemPrompt };
    const remembered = providerDrafts.current[nextProvider];
    const currentModel = catalog.models.find(model => model.path === cfg.active_model);
    const next = remembered ? { ...executionConfig(cfg, remembered.settings), active_provider: nextProvider, active_runtime: remembered.settings.active_runtime ?? '' } : { ...cfg, active_provider: nextProvider, active_runtime: '',
      active_model: currentModel && api.modelLoadable(currentModel, nextProvider) ? cfg.active_model : '',
      ...(nextProvider === 'llama.cpp' ? {} : { mmproj: '', spec_draft_model: '' }) };
    const resolved = profiles.resetModel(next, sessionId);
    if (remembered) profiles.setSystemPrompt(remembered.prompt);
    const nextSettings = executionSettings(remembered ? next : resolved);
    setSettings(nextSettings); setBaseline(executionSettings(resolved));
    setPathDraft(normalizeDisplayPath(next.active_model)); setInvalid(new Set()); setEditorRevision(value => value + 1);
  };
  // A probe of the previous runtime survives a backend switch until the new one
  // answers; its device list describes a backend that is no longer active.
  const devices = runtime.capabilities?.backend === cfg.active_backend ? runtimeGpuDevices(cfg.active_backend, runtime.capabilities.devices) : [];
  const device = resources.device && cfg.active_backend ? { ...resources.device, profile: { ...resources.device.profile, gpus: devices } } : resources.device;
  // Changing the runtime here leaves the placement naming devices from the
  // backend being left, which the new one does not answer to: it looked settled
  // and failed at launch. Once the new runtime reports its own devices the
  // selection is re-pointed at them, which is what the runtimes panel does when
  // the backend is switched there.
  const deviceKey = devices.map(item => item.stable_id).join('|');
  const deviceRef = useRef(devices); deviceRef.current = devices;
  const changeRef = useRef(change); changeRef.current = change;
  useEffect(() => {
    const available = deviceRef.current;
    if (!available.length) return;
    const known = new Set(available.map(item => item.stable_id));
    const gpu = latest.current.gpu;
    if (!gpu?.gpu_ids.length || gpu.gpu_ids.every(id => known.has(id))) return;
    changeRef.current({ gpu: { ...gpu, gpu_ids: available.map(item => item.stable_id!), main_gpu: null, tensor_split: [], draft_gpu_id: null } });
  }, [deviceKey]);
  const models = catalog.models.filter(model => api.modelSelectable(model, provider) && `${model.name} ${normalizeDisplayPath(model.path)}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = catalog.models.find(model => model.path === cfg.active_model);
  const compatibility = selected?.compatibility?.find(item => item.provider === provider);
  const supportedInputs = compatibility && ['supported', 'partial'].includes(compatibility.status)
    ? Object.entries(compatibility.modalities).filter(([, supported]) => supported).map(([name]) => name).join(', ') || '—' : '—';
  const incompatible = !!compatibility && !api.modelSelectable(selected!, provider);
  const compatibilityBlocked = incompatible || !!compatibility?.readiness.length;
  const incomplete = !!selected?.shards?.missing.length || !!selected?.artifact?.incomplete || !!selected?.artifact?.missing.length;
  // What still has to be chosen before the start button can do anything. The
  // installed list is only consulted once it has loaded, so a slow read never
  // reports an installed runtime as missing — but a list that loaded empty is
  // consulted too, so a selected runtime with nothing installed is reported.
  const setupGaps = runSetupGaps({
    activeModel: cfg.active_model,
    activeBackend: llama ? cfg.active_backend : cfg.active_runtime ?? '',
    activeBuild: llama ? cfg.active_build : cfg.active_runtime ?? '',
    modelIncomplete: incomplete,
    ...(runtimeKnown ? { runtimeInstalled: !runtimeMissing } : {}),
  }).filter((gap): gap is 'modelShards' | 'runtimeMissing' => gap === 'modelShards' || gap === 'runtimeMissing');
  const editorKey = `${cfg.active_model}:${editorRevision}`;
  const launchStage = preflightState === 'checking' ? copy.preflightChecking : preflightState === 'saving' ? copy.pending : preflightState === 'loading' ? copy.loadingModel : preflightState === 'cancelling' ? copy.launchCancelling : copy.preparing;
  return { open, targetLabel, mode, onApply, onClose, onManageRuntimes, busy, liveState, executionNotice, onCancelStart, onStop, preflightState, t, locale, copy, flowCopy, help, profileCopy, id, saved, baseline, settings, cfg, provider, llama, external, runtimeSchema, setProviderReady, profileBannerTarget, setProfileBannerTarget, latest, sections, section, query, setQuery, pathDraft, setPathDraft, error, setError, applying, starting, pending, setPending, pendingCancel, cancelPending, confirmSave, setConfirmSave, invalid, providerOptionsPending, setProviderOptionsPending, profileDirty, setProfileDirty, editorRevision, resourceError, resourceRevision, setResourceRevision, overlay, setOverlay, runtime, catalog, selectedMetadata, contextLimit, disabled, closingStart, benchmark, savedApplication, profiles, runtimeSelection, dialog, heading, body, scroller, startButton, cancelFocus, flowHeading, tabOrientation, showSection, profilePreview, setProfilePreview, canProfile, canOptions, step, navigateStep, continueStep, manageRuntimes, running, live, serverChanged, startText, executionCopy, stateText, enteredPath, pathImeHandlers, liveMatches, profileItems, defaultProfileId, displayId, profileInUse, saveTarget, working, pathPending, setFieldInvalid, change, guarded, closeEditor, chooseModel, resetProfile, commitProfile, revertProfile, selectProfile, apply, runtimeKnown, runtimeMissing, runtimeSelected, chooseProvider, devices, device, models, selected, compatibility, supportedInputs, compatibilityBlocked, incomplete, setupGaps, editorKey, launchStage, onDialogKeyDown, onDialogFocus };
}
export type ModelSettingsDialogController = ReturnType<typeof useModelSettingsDialogController>;
