import type { Dispatch, RefObject, SetStateAction } from 'react';
import * as api from '../../shared/api/index';
import { IpcError } from '../../shared/api/ipcError';
import { providerOf } from '../../shared/api/providers';
import { executionConfig, ExecutionConflictError, executionSettings, mergeExecutionChanges, serverSettingsChanged } from '../../shared/config/executionSettings';
import { applyDefaultProfile, resolveProfileApplicationOrDefault, resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { ensureProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey, RUNTIME_SELECTION_KEYS, type ProfileApplication } from '../../shared/config/settingsProfiles';
import type { Locale } from '../../shared/i18n/i18n';
import { modelDisplayName } from '../../shared/lib/displayPaths';
import { isLifecycleCancellation } from '../../shared/lib/serverLifecycle';
import { notifySessionStatusChanged, sessionConfig } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import type { AppStore } from '../../shared/state/store';
import { finishTask, getTaskSnapshot, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { type ModelSettingsRequest } from './modelSettingsContext';
import { modelSettingsCopy } from './modelSettingsCopy';
import { launchModelSettings } from './modelSettingsLaunch';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileLibraryConfigPatch, profileTargetConfigPatch, SettingsDeliveryError, type ProfileCommitResult, type ProfileEditorResult } from './profileEditor';
import { applyProfile } from './profileWorkspaceState';
export interface LaunchCancellation {
  editorKey: number;
  id: string;
  cancelled: boolean;
  stage: 'preparing' | 'saving' | 'checking' | 'loading';
  cancellation?: Promise<void>;
  cancellationError?: string;
  cancel: () => Promise<void>;
}
export interface SettingsEditor {
  request: ModelSettingsRequest; base: api.AppConfig; baseDefinition?: api.SessionDefinition;
  initial: api.AppConfig; key: number; existingSession: boolean;
}
export interface ProfilePersistenceOptions {
  latest: RefObject<AppStore>; editor: SettingsEditor | null;
  lock: RefObject<boolean>; persistOwner: RefObject<number | null>; startInFlight: RefObject<boolean>;
  liveProfiles: RefObject<Map<string, { model: string; pid?: number; application: ProfileApplication }>>;
  deletedProfileFallbacks: RefObject<Map<string, ProfileApplication>>;
  setEditor: Dispatch<SetStateAction<SettingsEditor | null>>; setBusy: Dispatch<SetStateAction<boolean>>;
  setLaunching: Dispatch<SetStateAction<LaunchCancellation | null>>;
  setPreflightState: Dispatch<SetStateAction<LaunchCancellation['stage'] | 'cancelling' | null>>;
  copy: { loading: string; missing: string; busy: string; conflict: string; activity: string };
  locale: Locale; targetLabel: string; open: (request: ModelSettingsRequest) => void;
}

export function assignedTarget(config: api.AppConfig, application?: ProfileApplication, sessionId = 'default'): ProfileCommitResult {
  const library = application?.profile_id && config.settings_profiles ? ensureProfileLibrary(config.settings_profiles) : profileLibrary(config);
  const resolved = resolveProfileForExecution(config, library, application, profileTargetKey(config.active_model, sessionId, providerOf(config)));
  return { config: { ...executionConfig(config, resolved.application.settings), settings_profiles: resolved.library }, application: resolved.application };
}
export function createProfilePersistence(options: ProfilePersistenceOptions) {
  const { latest, editor, lock, persistOwner, startInFlight, liveProfiles, deletedProfileFallbacks, setEditor, setBusy, setLaunching, setPreflightState, copy, locale, targetLabel, open } = options;
  const savedTarget = (current: api.AppConfig, draft: api.AppConfig, previousApplication?: ProfileApplication): ProfileCommitResult => {
    if (!editor) throw new Error(copy.loading);
    const { target } = editor.request;
    const modelPath = draft.active_model;
    const provider = providerOf(draft);
    const selection = Object.fromEntries(RUNTIME_SELECTION_KEYS.map(key => [key, draft[key]]));
    const external = target.kind === 'project' || target.kind === 'benchmark';
    const id = target.kind === 'session' ? target.sessionId : 'default';
    const definition = target.kind === 'session' ? current.sessions?.find(item => item.id === id) ?? (!editor.existingSession ? editor.request.definition : undefined) : undefined;
    if (target.kind === 'session' && !definition) throw new Error(copy.missing);
    const base = external ? executionConfig(current, executionSettings(editor.base)) : definition ? sessionConfig(current, definition) : current;
    // Profiles restore options, never the execution context selected in this
    // editor. A metadata-only write must not put the store's runtime back.
    const config = { ...base, ...selection, active_model: modelPath };
    const previous = previousApplication ?? (external ? editor.request.application : undefined);
    if (previous && (previous.provider ?? 'llama.cpp') === provider && profileTargetKey(previous.model) === profileTargetKey(modelPath)) {
      return assignedTarget(config, previous, id);
    }
    const sameTarget = providerOf(base) === provider && profileTargetKey(base.active_model) === profileTargetKey(modelPath);
    const application = appliedProfile({ ...current, ...selection, active_model: modelPath }, sameTarget ? id : 'default');
    const library = profileLibrary(current);
    const recent = library.entries.find(entry => entry.id === library.provider_recent?.[provider] && (entry.provider ?? 'llama.cpp') === provider);
    const fallback = recent ? materializeProfileApplication(applyProfile(config, recent), recent.system_prompt ?? '', recent) : applyDefaultProfile(config, library).application;
    return assignedTarget(config, application ?? fallback, id);
  };
  const rebase = (result: ProfileCommitResult, editorKey = editor?.key) => {
    setEditor(previous => {
      if (!previous || previous.key !== editorKey) return previous;
      const current = latest.current.getConfig() ?? result.config;
      const target = previous.request.target;
      const definition = target.kind === 'session' ? current.sessions?.find(item => item.id === target.sessionId) : undefined;
      const base = target.kind === 'default' ? current : definition ? sessionConfig(current, definition) : result.config;
      return { ...previous, base: structuredClone(base),
        request: { ...previous.request, application: structuredClone(result.application) },
        existingSession: previous.existingSession || !!definition };
    });
  };
  const reloadProfile = async (draft: api.AppConfig): Promise<ProfileCommitResult> => {
    if (!editor || lock.current) throw new Error(copy.busy);
    const current = latest.current.getConfig();
    if (!current) throw new Error(copy.loading);
    const result = savedTarget(current, draft);
    const target = editor.request.target;
    rebase(target.kind === 'project' || target.kind === 'benchmark' ? savedTarget(current, editor.base) : result);
    return structuredClone(result);
  };
  const persist = async (draft: api.AppConfig, intent: 'save' | 'start', profile: ProfileEditorResult, close: boolean, applyTarget = true): Promise<ProfileCommitResult> => {
    if (!editor || lock.current) throw new Error(copy.busy);
    draft = structuredClone(draft); profile = structuredClone(profile);
    const capturedEditor = editor;
    const { target } = capturedEditor.request;
    const id = target.kind === 'session' ? target.sessionId : 'default';
    const starting = intent === 'start' && (target.kind === 'default' || target.kind === 'session');
    if (starting && getTaskSnapshot().some(task => task.kind === 'model-launch' && task.targetId === id && ['running', 'cancelling'].includes(task.state))) throw new Error(copy.busy);
    lock.current = true; persistOwner.current = capturedEditor.key; startInFlight.current = starting; setBusy(true);
    let persisted: api.AppConfig | undefined;
    let application = profile.application;
    let handedOff = false;
    let taskOutcome: 'completed' | 'cancelled' | 'failed' = 'completed';
    let taskDetail: string | undefined;
    const owner: LaunchCancellation | undefined = starting ? {
      editorKey: capturedEditor.key, id: crypto.randomUUID(), cancelled: false, stage: 'preparing',
      cancel: () => {
        if (!owner || owner.cancelled) return owner?.cancellation ?? Promise.resolve();
        owner.cancelled = true; owner.cancellationError = undefined;
        if (persistOwner.current === owner.editorKey) setPreflightState('cancelling');
        const previousPhase = getTaskSnapshot().find(task => task.id === owner.id)?.phase;
        updateTask(owner.id, { state: 'cancelling', phase: modelSettingsCopy[locale].launchCancelling });
        owner.cancellation = (async () => {
          try {
            if (target.kind === 'default' && owner.stage === 'loading') await latest.current.stop(owner.id);
            else await api.cancelLaunch(owner.id, id);
          } catch (cause) {
            owner.cancelled = false;
            owner.cancellationError = cause instanceof Error ? cause.message : String(cause);
            if (persistOwner.current === owner.editorKey) setPreflightState(owner.stage);
            updateTask(owner.id, { state: 'running', phase: previousPhase, detail: owner.cancellationError });
          }
        })();
        return owner.cancellation;
      },
    } : undefined;
    const taskId = owner ? registerTask({
      id: owner.id, kind: 'model-launch', targetId: id,
      label: `${targetLabel} · ${modelDisplayName(draft.active_model)}`,
      phase: modelSettingsCopy[locale].preparing, interruptible: true, cancel: owner.cancel,
    }) : undefined;
    if (owner) { setLaunching(owner); setPreflightState('preparing'); }
    const stage = (value: LaunchCancellation['stage'], phase: string) => {
      if (!owner || owner.cancelled) return;
      owner.stage = value;
      if (persistOwner.current === owner.editorKey) setPreflightState(value);
      updateTask(owner.id, { phase });
    };
    const assertNotCancelled = () => { if (owner?.cancelled) throw new IpcError('cancelled', 'server start cancelled'); };
    try {
      const current = latest.current.getConfig();
      if (!current) throw new Error(copy.loading);
      if (!applyTarget) {
        const previousLibrary = current.settings_profiles;
        const externalApplication = target.kind === 'project' || target.kind === 'benchmark'
          ? savedTarget(current, capturedEditor.base).application : undefined;
        const saved = await latest.current.updateConfig(latestCfg => profileLibraryConfigPatch(latestCfg, { ...profile, saveMode: undefined }));
        const removed = new Set((previousLibrary?.entries ?? []).map(entry => entry.id));
        if (removed.size && saved.settings_profiles) {
          for (const entry of saved.settings_profiles.entries) {
            removed.delete(entry.id);
            if (!removed.size) break;
          }
        }
        for (const [key, previous] of Object.entries(previousLibrary?.applied ?? {})) {
          const replacement = saved.settings_profiles?.applied[key];
          if (previous.profile_id && removed.has(previous.profile_id) && replacement) deletedProfileFallbacks.current.set(key, structuredClone(replacement));
        }
        for (const [key, cached] of liveProfiles.current) if (cached.application.profile_id && removed.has(cached.application.profile_id)) liveProfiles.current.delete(key);
        const result = savedTarget(saved, draft);
        const externalResult = externalApplication ? savedTarget(saved, capturedEditor.base, externalApplication) : undefined;
        persisted = result.config; application = result.application;
        rebase(externalResult ?? result);
        if (externalResult && externalApplication?.profile_id && removed.has(externalApplication.profile_id)) await capturedEditor.request.onApply?.(externalResult.config, externalResult.application);
        return structuredClone(result);
      }
      if (!profile.saveMode) {
        const selected = profile.library.entries.find(entry => entry.id === profile.application.profile_id);
        if (!selected) throw new Error('This profile is no longer available.');
        draft = applyProfile(draft, selected);
        application = materializeProfileApplication(draft, selected.system_prompt ?? profile.application.system_prompt, selected);
        profile = { ...profile, application };
      }
      if (target.kind === 'benchmark' || target.kind === 'project') {
        const libraryChanged = JSON.stringify(current.settings_profiles?.entries) !== JSON.stringify(profile.library.entries)
          || current.settings_profiles?.default_profile_id !== profile.library.default_profile_id || !current.settings_profiles?.legacy_imported || !!profile.saveMode;
        const saved = libraryChanged ? await latest.current.updateConfig(latestCfg => profileLibraryConfigPatch(latestCfg, {
          ...profile, application: { ...profile.application, model: draft.active_model, settings: profileSettingsSnapshot(draft) },
        })) : current;
        const entry = saved.settings_profiles?.entries.find(item => item.id === profile.application.profile_id);
        if (!entry) throw new Error('This profile is no longer available.');
        draft = applyProfile(draft, entry);
        application = materializeProfileApplication(draft, entry.system_prompt ?? '', entry);
        const result = { config: executionConfig(saved, executionSettings(draft)), application };
        if (libraryChanged) {
          persisted = result.config;
          setEditor(previous => previous ? { ...previous, base: { ...previous.base, settings_profiles: saved.settings_profiles } } : null);
        }
        await editor.request.onApply?.(result.config, application);
        rebase(result);
        if (close) setEditor(null);
        return structuredClone(result);
      }
      const list = api.normalizeSessionList(await api.sessionList());
      const status = id === 'default' ? await api.serverStatus() : list.find(item => item.id === id);
      // Only a launch has to wait for the server to settle: two overlapping
      // transitions race over the same process. Saving is configuration on
      // disk, so it stays available while a model loads into VRAM or shuts
      // down — which is the whole point of not blocking those windows.
      if (intent === 'start' && (latest.current.busy
        || (status && ['starting', 'stopping'].includes(status.state))
        || getTaskSnapshot().some(task => ['runtime', 'benchmark'].includes(task.kind) && ['running', 'cancelling'].includes(task.state)))) throw new Error(copy.busy);
      const existing = target.kind === 'session' ? current.sessions?.find(item => item.id === id) : undefined;
      const definition = existing ?? editor.request.definition;
      if (target.kind === 'session' && (!definition || (editor.existingSession && !existing))) throw new Error(copy.missing);
      const baseCurrent = definition ? sessionConfig(current, definition) : current;
      let next: api.AppConfig;
      try { next = mergeExecutionChanges(editor.base, draft, baseCurrent); }
      catch (cause) { if (cause instanceof ExecutionConflictError) throw new Error(copy.conflict + cause.fields.join(', ')); throw cause; }
      const live = status?.execution ? executionConfig(current, status.execution) : editor.base;
      const cached = liveProfiles.current.get(id);
      if (cached && (cached.pid !== status?.pid || cached.model !== live.active_model)) liveProfiles.current.delete(id);
      const requestOnly = status?.state === 'running' && !serverSettingsChanged(live, next);
      if (intent === 'start' && (sessionHasActivity(id) || (status?.active_requests ?? 0) > 0 || (current.stop_existing_sessions_on_load !== false && (anySessionActivity() || list.some(session => (session.active_requests ?? 0) > 0))))) throw new Error(copy.activity);
      if (status?.state === 'running' && !liveProfiles.current.has(id)) liveProfiles.current.set(id, { model: live.active_model, pid: status.pid,
        application: structuredClone(resolveProfileApplicationOrDefault(live, profileLibrary(live), appliedProfile(live, id), profileTargetKey(live.active_model, id, providerOf(live))).application) });
      assertNotCancelled();
      stage('saving', modelSettingsCopy[locale].pending);
      application = { ...profile.application, model: next.active_model, settings: profileSettingsSnapshot(next) };
      const edit = { ...profile, application };
      let saved: api.AppConfig;
      if (target.kind === 'session' && definition) {
        const cfg = await latest.current.updateConfig(latestCfg => {
          const latestDefinition = latestCfg.sessions?.find(item => item.id === id);
          if (editor.existingSession && !latestDefinition) throw new Error(copy.missing);
          const source = latestDefinition ?? definition;
          const resolved = mergeExecutionChanges(editor.base, next, sessionConfig(latestCfg, source));
          const metadata = editor.request.definition;
          const original = editor.baseDefinition ?? definition;
          const metadataPatch: Partial<api.SessionDefinition> = {};
          for (const field of ['name'] as const) {
            if (!metadata || metadata[field] === original[field]) continue;
            if (source[field] !== original[field] && source[field] !== metadata[field]) throw new Error(copy.conflict + field);
            Object.assign(metadataPatch, { [field]: metadata[field] });
          }
          application = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
          return profileTargetConfigPatch(latestCfg, resolved, mergeProfileEditor(latestCfg, { ...edit, application }, id), { ...source, ...metadataPatch });
        });
        saved = sessionConfig(cfg, cfg.sessions!.find(item => item.id === id)!);
      } else {
        saved = await latest.current.updateConfig(latestCfg => {
          const resolved = mergeExecutionChanges(editor.base, next, latestCfg);
          application = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
          return profileTargetConfigPatch(latestCfg, resolved, mergeProfileEditor(latestCfg, { ...edit, application }, id), null);
        });
      }
      // Capture before awaiting delivery: later edits must not mutate this launch.
      if (owner) saved = structuredClone(saved);
      application = appliedProfile(saved, id) ?? { ...application, settings: profileSettingsSnapshot(saved) };
      deletedProfileFallbacks.current.delete(profileTargetKey(saved.active_model, id, providerOf(saved)));
      persisted = saved;
      // A successful save is retained if a subsequent launch fails or is cancelled.
      const result = { config: saved, application };
      rebase(result, capturedEditor.key);
      if (owner) {
        // The durable draft has been accepted. This owned promise includes the
        // long engine/model checks, canonical snapshot write, and readiness.
        // No callback below can close or rebase a subsequently opened editor.
        updateTask(owner.id, { action: { label: modelSettingsCopy[locale].recoverLaunch, onClick: () => open({
          ...capturedEditor.request, config: saved, application, section: 'model',
        }) } });
        handedOff = true;
        void launchModelSettings({ ...options, owner, capturedEditor, saved, application, target, id, status, stage, assertNotCancelled });
        if (close) setEditor(current => current?.key === capturedEditor.key ? null : current);
        return structuredClone(result);
      } else if (requestOnly) {
        await api.applyRequestSettings(saved, id);
        liveProfiles.current.set(id, { model: saved.active_model, pid: status?.pid, application: structuredClone(application) });
      }
      await editor.request.onApply?.(saved, application);
      await latest.current.refreshStatus(); notifySessionStatusChanged();
      if (close) setEditor(current => current?.key === capturedEditor.key ? null : current);
      return structuredClone(result);
    } catch (cause) {
      await owner?.cancellation;
      const failure = owner?.cancellationError && isLifecycleCancellation(cause) ? new Error(owner.cancellationError) : cause;
      const cancelled = isLifecycleCancellation(failure);
      taskOutcome = cancelled ? 'cancelled' : 'failed';
      taskDetail = cancelled ? undefined : failure instanceof Error ? failure.message : String(failure);
      if (persisted) throw new SettingsDeliveryError(String(failure), persisted, application);
      throw failure;
    } finally {
      if (taskId && !handedOff) finishTask(taskId, taskOutcome, taskDetail);
      lock.current = false; persistOwner.current = null; startInFlight.current = false; setBusy(false); setPreflightState(null);
      if (owner && !handedOff) setLaunching(current => current?.id === owner.id ? null : current);
    }
  };
  const apply = async (draft: api.AppConfig, intent: 'save' | 'start', profile: ProfileEditorResult) => {
    await persist(draft, intent, { ...profile, saveMode: editor?.request.target.kind === 'benchmark' ? 'benchmark' : 'all' }, true);
  };
  const commitProfile = (draft: api.AppConfig, profile: ProfileEditorResult, applyTarget: boolean) => persist(draft, 'save', profile, false, applyTarget);
  return { apply, commitProfile, reloadProfile };
}
