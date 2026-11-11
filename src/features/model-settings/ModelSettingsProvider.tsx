import { providerOf } from '../../shared/api/providers';
import { mergeProviderRequestSettings } from '../../shared/config/providerRequestSettings';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';
import { executionConfig, executionSettings, mergeExecutionChanges, REQUEST_KEYS, serverSettingsChanged, ExecutionConflictError } from '../../shared/config/executionSettings';
import { sessionConfig, notifySessionStatusChanged } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import { finishTask, getTaskSnapshot, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileLibraryConfigPatch, profileTargetConfigPatch, requestProfileFromApplication, SettingsDeliveryError, type ModelProfile, type ProfileCommitResult, type ProfileEditorResult } from './profileEditor';
import { ensureProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey, RUNTIME_SELECTION_KEYS, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { applyDefaultProfile, resolveProfileApplicationOrDefault, resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { applyProfile } from './profileWorkspaceState';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { modelDisplayName, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { MANAGE_MODEL_RUNTIMES, modelSettingsContext as Context, type ModelSettingsRequest } from './modelSettingsContext';
import { modelSettingsCopy } from './modelSettingsCopy';
import { isLifecycleCancellation } from '../../shared/lib/serverLifecycle';

export { MANAGE_MODEL_RUNTIMES, useModelSettings } from './modelSettingsContext';
export type { ExecutionTarget, ModelSettingsRequest, ModelSettingsContext } from './modelSettingsContext';

const ModelSettingsDialog = lazy(() => import('./ModelSettingsDialog'));

interface LaunchCancellation {
  editorKey: number;
  id: string;
  cancelled: boolean;
  stage: 'preparing' | 'saving' | 'checking' | 'loading';
  cancellation?: Promise<void>;
  cancellationError?: string;
  cancel: () => Promise<void>;
}

function assignedTarget(config: api.AppConfig, application?: ProfileApplication, sessionId = 'default'): ProfileCommitResult {
  const library = application?.profile_id && config.settings_profiles ? ensureProfileLibrary(config.settings_profiles) : profileLibrary(config);
  const resolved = resolveProfileForExecution(config, library, application, profileTargetKey(config.active_model, sessionId, providerOf(config)));
  return { config: { ...executionConfig(config, resolved.application.settings), settings_profiles: resolved.library }, application: resolved.application };
}
// Only these session fields reach the editor. Poll deliveries that differ in
// usage telemetry alone must not re-render the provider and every reader below
// it. Compare every session so switching targets cannot surface a value that
// was never committed while the editor was open on another one.
function sessionRefreshKey(list: api.SessionStatus[]): string {
  // Object fields keep a native null PID distinct from an omitted one: the
  // live-profile cache compares process identities with strict equality.
  return JSON.stringify(list.map(({ id, state, pid, model, execution }) => ({ id, state, pid, model, execution })));
}
const messages = {
  en: { default: 'Default execution', session: 'Session', benchmark: 'Benchmark target', project: 'Project settings', busy: 'Wait for the current model operation to finish.', activity: 'Stop the current response before changing its model.', conflict: 'These settings changed elsewhere. Close and reopen settings to review the latest values: ', loading: 'Loading model settings…', stopOthers: 'Starting this model will stop other model sessions according to your load policy.', live: 'Saving server settings keeps the current model running. Reload to use the new settings.', resume: 'Return to model settings', missing: 'The selected session was removed. Reopen settings to choose a session.' },
  ko: { default: '기본 실행', session: '세션', benchmark: '벤치마크 대상', project: '프로젝트 설정', busy: '진행 중인 모델 작업이 끝날 때까지 기다려 주세요.', activity: '모델을 변경하기 전에 현재 응답을 중지해 주세요.', conflict: '다른 곳에서 설정이 변경되었습니다. 창을 다시 열어 최신 값을 확인해 주세요: ', loading: '모델 설정 불러오는 중…', stopOthers: '이 모델을 실행하면 현재 로드 정책에 따라 다른 모델 세션이 중지됩니다.', live: '서버 설정을 저장해도 현재 모델은 계속 실행됩니다. 새 설정은 다시 실행할 때 적용됩니다.', resume: '모델 설정으로 돌아가기', missing: '선택한 세션이 삭제되었습니다. 설정을 다시 열어 세션을 선택해 주세요.' },
  ja: { default: '既定の実行', session: 'セッション', benchmark: 'ベンチマーク対象', project: 'プロジェクト設定', busy: '現在のモデル操作が完了するまでお待ちください。', activity: 'モデルを変更する前に現在の応答を停止してください。', conflict: '設定が別の場所で変更されました。設定を開き直してください: ', loading: 'モデル設定を読み込み中…', stopOthers: 'このモデルの起動時に、読み込み設定に従って他のセッションを停止します。', live: '設定の保存後も現在のモデルは動作します。再起動すると新しい設定が適用されます。', resume: 'モデル設定に戻る', missing: '選択したセッションは削除されました。設定を開き直してください。' },
  zh: { default: '默认运行', session: '会话', benchmark: '基准测试模型', project: '项目设置', busy: '请等待当前模型操作完成。', activity: '更改模型前请停止当前回复。', conflict: '设置已在其他位置更改。请重新打开设置：', loading: '正在加载模型设置…', stopOthers: '启动此模型时，将根据加载策略停止其他会话。', live: '保存设置不会停止当前模型。重新启动后应用新设置。', resume: '返回模型设置', missing: '所选会话已删除。请重新打开设置。' },
};

export function ModelSettingsProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  const { locale } = useI18n();
  const copy = messages[locale];
  const latest = useRef(store); latest.current = store;
  const counter = useRef(0);
  const [editor, setEditor] = useState<{ request: ModelSettingsRequest; base: api.AppConfig; baseDefinition?: api.SessionDefinition; initial: api.AppConfig; key: number; existingSession: boolean } | null>(null);
  const [suspended, setSuspended] = useState(false);
  const [busy, setBusy] = useState(false);
  const [launching, setLaunching] = useState<LaunchCancellation | null>(null);
  const [preflightState, setPreflightState] = useState<'preparing' | 'saving' | 'checking' | 'loading' | 'cancelling' | null>(null);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const lastSessionsKey = useRef<string | null>(null);
  const applySessionData = useCallback((next: api.SessionStatus[]) => {
    const key = sessionRefreshKey(next);
    if (key === lastSessionsKey.current) return;
    lastSessionsKey.current = key;
    // A delivery may reuse its array after updating a session in place.
    setSessions([...next]);
  }, []);
  const lock = useRef(false);
  const persistOwner = useRef<number | null>(null);
  const startInFlight = useRef(false);
  const liveProfiles = useRef(new Map<string, { model: string; pid?: number; application: ProfileApplication }>());
  const deletedProfileFallbacks = useRef(new Map<string, ProfileApplication>());
  const runningProfile = useRef<{ key: string; application?: ProfileApplication }>(undefined);
  const requestFallback = useCallback((id: string, model: string) => {
    const key = profileTargetKey(model, id, providerOf(latest.current.getConfig() ?? {}));
    const fallback = deletedProfileFallbacks.current.get(key);
    if (!fallback || profileTargetKey(fallback.model) !== profileTargetKey(model)) return undefined;
    const current = latest.current.getConfig()?.settings_profiles?.applied[key];
    if (!current || current.profile_id !== fallback.profile_id || !settingsEqual(current.settings, fallback.settings) || current.system_prompt !== fallback.system_prompt) {
      deletedProfileFallbacks.current.delete(key); return undefined;
    }
    return current;
  }, []);
  const open = useCallback((request: ModelSettingsRequest) => {
    if (lock.current) { setError(copy.busy); return; }
    const cfg = latest.current.getConfig();
    if (!cfg) return;
    const target = request.target;
    const definition = target.kind === 'session' ? cfg.sessions?.find(item => item.id === target.sessionId) ?? request.definition : undefined;
    if (request.target.kind === 'session' && !definition) { setError(copy.missing); return; }
    let base = definition ? sessionConfig(cfg, definition) : request.target.kind === 'default' ? cfg : request.config ? executionConfig(cfg, executionSettings(request.config)) : cfg;
    const status = latest.current.status;
    const loadedModel = loadedModelPath(status);
    let initial = request.config ? executionConfig(cfg, executionSettings(request.config)) : (target.kind === 'default' && status.state === 'running' && loadedModel !== cfg.active_model
      ? { ...executionConfig(cfg, status.execution ?? {}), active_model: loadedModel }
      : base);
    const id = target.kind === 'session' ? target.sessionId : 'default';
    const external = target.kind === 'project' || target.kind === 'benchmark';
    let reference = request.application;
    if (!reference) {
      if (external && request.config) reference = { model: initial.active_model, settings: profileSettingsSnapshot(initial), system_prompt: request.systemPrompt ?? '' };
      else if (target.kind === 'default' && providerOf(initial) !== providerOf(cfg)) {
        // Look up the saved target before repairing assignments from the draft:
        // a new provider without an assignment starts from its designated default.
        const library = cfg.settings_profiles ? ensureProfileLibrary(cfg.settings_profiles, providerOf(initial)) : profileLibrary(cfg);
        const application = library.applied[profileTargetKey(initial.active_model, id, providerOf(initial))];
        reference = application && profileTargetKey(application.model) === profileTargetKey(initial.active_model)
          ? application : applyDefaultProfile(initial, library).application;
      } else reference = appliedProfile({ ...cfg, active_model: initial.active_model }, id);
    }
    const assigned = assignedTarget(initial, reference, id);
    initial = assigned.config;
    if (target.kind === 'default') {
      const library = initial.settings_profiles!;
      const key = profileTargetKey(initial.active_model, id, providerOf(initial));
      // Keep the resolved identity and prompt when the editor repairs this new
      // target, rather than creating an anonymous recovery profile alongside it.
      if (!library.applied[key]) initial = { ...initial, settings_profiles: { ...library, applied: { ...library.applied, [key]: assigned.application } } };
    }
    if (external) base = assigned.config;
    request = { ...request, application: assigned.application, systemPrompt: assigned.application.system_prompt };
    setEditor({ request, base: structuredClone(base), baseDefinition: definition ? structuredClone(definition) : undefined, initial: structuredClone(initial), key: ++counter.current,
      existingSession: !!definition && !!cfg.sessions?.some(item => item.id === definition.id) });
    setSuspended(false); setError('');
  }, [copy.busy, copy.missing]);
  const pollingActive = editor !== null && !suspended && api.isNativeRuntimeAvailable();
  useSessionPolling({
    active: pollingActive,
    details: true,
    onData: applySessionData,
    intervalMs: 1500,
  });
  useEffect(() => {
    // The poller unsubscribes before this effect, so a pending IPC cannot
    // repopulate the extra fingerprint while this editor is inactive.
    if (!pollingActive) lastSessionsKey.current = null;
  }, [pollingActive]);
  const getRequestConfig = useCallback((id: string, fallback: api.AppConfig, status?: api.ServerStatus | api.SessionStatus) => {
    const cached = liveProfiles.current.get(id);
    if (cached && status?.pid !== undefined && cached.pid !== status.pid) liveProfiles.current.delete(id);
    const live = status?.execution;
    const cfg = executionConfig(fallback, live ?? {});
    cfg.active_model = loadedModelPath(status, cfg.active_model);
    if (status?.mmproj !== undefined) cfg.mmproj = status.mmproj;
    const replacement = requestFallback(id, cfg.active_model);
    if (replacement && (replacement.provider ?? 'llama.cpp') === providerOf(cfg)) {
      cfg.provider_options = mergeProviderRequestSettings(cfg, replacement.settings.provider_options, status?.engine?.request_option_keys);
      Object.assign(cfg, Object.fromEntries(REQUEST_KEYS.filter(key => replacement.settings[key] !== undefined).map(key => [key, structuredClone(replacement.settings[key])])));
      const requestKeys: readonly string[] = REQUEST_KEYS;
      cfg.runtime_defaults = [...(cfg.runtime_defaults ?? []).filter(key => !requestKeys.includes(key)), ...(replacement.settings.runtime_defaults ?? []).filter(key => requestKeys.includes(key))];
    }
    return cfg;
  }, [requestFallback]);
  const getRequestProfile = useCallback((id: string, cfg: api.AppConfig): ModelProfile | null => {
    const replacement = requestFallback(id, cfg.active_model);
    if (replacement) return requestProfileFromApplication(replacement);
    const live = liveProfiles.current.get(id);
    const application = live?.model === cfg.active_model ? live.application : appliedProfile(cfg, id);
    return requestProfileFromApplication(application ? { ...application, settings: profileSettingsSnapshot(cfg) } : undefined);
  }, [requestFallback]);
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
    const assertNotCancelled = () => { if (owner?.cancelled) throw new Error('server start cancelled'); };
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
        const launch = async () => {
          try {
            await capturedEditor.request.onApply?.(saved, application);
            assertNotCancelled();
            stage('checking', modelSettingsCopy[locale].preflightChecking);
            const prepared = await api.preflightLaunch(saved, owner.id);
            assertNotCancelled();
            let launchConfig = saved;
            let launchApplication = application;
            if (!settingsEqual(executionSettings(saved), executionSettings(prepared))) {
              stage('saving', modelSettingsCopy[locale].pending);
              const canonical = await latest.current.updateConfig(latestCfg => {
                const definition = target.kind === 'session' ? latestCfg.sessions?.find(item => item.id === id) : undefined;
                if (target.kind === 'session' && !definition) throw new Error(copy.missing);
                const currentTarget = definition ? sessionConfig(latestCfg, definition) : latestCfg;
                if (!settingsEqual(executionSettings(saved), executionSettings(currentTarget))) throw new Error(copy.conflict + 'execution');
                const resolved = mergeExecutionChanges(saved, prepared, currentTarget);
                // Do not overwrite a profile edited while engine checks ran.
                const currentApplication = appliedProfile(currentTarget, id);
                if (!currentApplication || currentApplication.profile_id !== application.profile_id
                  || currentApplication.profile_revision !== application.profile_revision
                  || currentApplication.system_prompt !== application.system_prompt
                  || !settingsEqual(currentApplication.settings, application.settings)) throw new Error(copy.conflict + 'profile');
                launchApplication = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
                const library = profileLibrary(latestCfg);
                return profileTargetConfigPatch(latestCfg, resolved, mergeProfileEditor(latestCfg, {
                  library, baseRevision: library.revision, application: launchApplication, saveMode: 'all',
                }, id), definition ?? null);
              });
              const canonicalTarget = target.kind === 'session' ? sessionConfig(canonical, canonical.sessions!.find(item => item.id === id)!) : canonical;
              // Keep this request's policy without reverting the newer global preference.
              launchConfig = { ...canonicalTarget, stop_existing_sessions_on_load: saved.stop_existing_sessions_on_load };
              launchApplication = appliedProfile(launchConfig, id) ?? launchApplication;
            }
            updateTask(owner.id, { action: { label: modelSettingsCopy[locale].recoverLaunch, onClick: () => open({
              ...capturedEditor.request, config: launchConfig, application: launchApplication, section: 'model',
            }) } });
            assertNotCancelled();
            // Activity can start while a lengthy check is pending. Keep the
            // original stop-other-sessions policy and never interrupt a reply.
            if (launchConfig !== saved) await capturedEditor.request.onApply?.(launchConfig, launchApplication);
            assertNotCancelled();
            const list = api.normalizeSessionList(await api.sessionList());
            assertNotCancelled();
            if (sessionHasActivity(id) || (list.find(item => item.id === id)?.active_requests ?? 0) > 0
              || (launchConfig.stop_existing_sessions_on_load !== false && (anySessionActivity() || list.some(session => (session.active_requests ?? 0) > 0)))) throw new Error(copy.activity);
            stage('loading', modelSettingsCopy[locale].loadingModel);
            let readyStatus: api.ServerStatus | api.SessionStatus | undefined;
            if (target.kind === 'session') {
              readyStatus = await api.sessionStart(id, launchConfig, launchConfig.stop_existing_sessions_on_load, { persist: false, operationId: owner.id });
            } else {
              await latest.current.start(launchConfig, status?.state === 'running', { persist: false, operationId: owner.id });
              if (!owner.cancelled) readyStatus = await api.serverStatus().catch(() => undefined);
            }
            await owner.cancellation;
            if (!owner.cancelled) liveProfiles.current.set(id, { model: launchConfig.active_model, pid: readyStatus?.pid, application: structuredClone(launchApplication) });
            if (owner.cancellationError) throw new Error(owner.cancellationError);
            finishTask(owner.id, owner.cancelled ? 'cancelled' : 'completed');
          } catch (cause) {
            await owner.cancellation;
            const failure = owner.cancellationError && isLifecycleCancellation(cause) ? new Error(owner.cancellationError) : cause;
            const cancelled = isLifecycleCancellation(failure);
            finishTask(owner.id, cancelled ? 'cancelled' : 'failed', cancelled ? undefined : (failure instanceof Error ? failure.message : String(failure)));
          } finally {
            setLaunching(current => current?.id === owner.id ? null : current);
            void latest.current.refreshStatus().catch(() => undefined); notifySessionStatusChanged();
          }
        };
        handedOff = true;
        void launch();
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
  const target = editor?.request.target;
  const id = target?.kind === 'session' ? target.sessionId : 'default';
  const liveStatus = target?.kind === 'session' ? sessions.find(item => item.id === id) : target?.kind === 'default' ? store.status : undefined;
  const liveState = liveStatus?.state ?? (target?.kind === 'session' ? 'stopped' : undefined);
  const cachedApplication = liveProfiles.current.get(id);
  const liveModel = loadedModelPath(liveStatus);
  // Relevant session changes refresh an open editor after polling. Resolving the saved
  // profile copies and serializes the whole library, so the result is reused
  // while the configuration content is unchanged. Content, not the reference,
  // is the key because a configuration can be updated in place. A library
  // migrated from browser storage is resolved again on every render. The entry
  // is kept only by a render that resolves a stored library, so a closed editor,
  // a live cache hit or a migrated library releases the copied configuration.
  const previousRunningProfile = runningProfile.current;
  runningProfile.current = undefined;
  const savedRunningProfile = (cfg: api.AppConfig, sessionId: string) => {
    if (!cfg.settings_profiles) return appliedProfile(cfg, sessionId);
    const key = JSON.stringify([sessionId, cfg]);
    runningProfile.current = previousRunningProfile?.key === key ? previousRunningProfile : { key, application: appliedProfile(cfg, sessionId) };
    return runningProfile.current.application;
  };
  const liveApplication = cachedApplication && cachedApplication.pid === liveStatus?.pid && cachedApplication.model === liveModel
    ? cachedApplication.application : store.cfg && liveModel ? savedRunningProfile({ ...store.cfg, active_model: liveModel }, id) : undefined;
  const stopsOtherSessions = (target?.kind === 'session' || target?.kind === 'default') && store.cfg?.stop_existing_sessions_on_load !== false
    && (sessions.some(session => session.id !== id && ['running', 'starting', 'stopping'].includes(session.state))
      || (target.kind === 'session' && ['running', 'starting', 'stopping'].includes(store.status.state)));
  const targetLabel = target ? `${copy[target.kind]}${target.kind === 'session' ? `: ${store.cfg?.sessions?.find(item => item.id === id)?.name || id}` : ''}` : '';
  // Stopping this target, whether it is still loading or already serving. The
  // dialog offers it in place of a launch while the model is up, so there is
  // somewhere to stop from without closing the settings first.
  const stopTarget = () => { void (id === 'default' ? latest.current.stop() : api.sessionStop(id)).catch(cause => setError(String(cause))); };
  return <Context.Provider value={{ open, suspended, resume: () => setSuspended(false), getRequestConfig, getRequestProfile }}>
    {children}
    {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{normalizeDisplayText(error)}</FeedbackBanner>}
    {editor && <Suspense fallback={<div role="status">{copy.loading}</div>}><ModelSettingsDialog key={editor.key} open={!suspended} initialConfig={editor.initial} targetLabel={targetLabel} mode={editor.request.target.kind}
      requireModelSelection={editor.request.target.kind === 'default' && !editor.request.config && !editor.initial.active_model.trim() && !['running', 'starting', 'stopping'].includes(store.status.state)}
      initialSection={editor.request.section} busy={busy} startPending={busy && startInFlight.current} liveState={liveState} liveConfig={store.cfg && liveStatus?.execution ? executionConfig(store.cfg, liveStatus.execution) : undefined} onApply={apply} onClose={() => {
        if (lock.current) return;
        setEditor(current => current?.key === editor.key ? null : current);
      }}
      onProfileCommit={commitProfile} onReloadProfile={reloadProfile}
      sessionId={id} initialApplication={editor.request.application ?? (editor.request.target.kind === 'project' || editor.request.target.kind === 'benchmark'
        ? assignedTarget(editor.initial, { model: editor.initial.active_model, settings: profileSettingsSnapshot(editor.initial), system_prompt: editor.request.systemPrompt ?? '' }).application : appliedProfile(editor.initial, id))}
      liveApplication={liveApplication}
      executionNotice={stopsOtherSessions ? <p>{copy.stopOthers}</p> : undefined}
      preflightState={preflightState ?? undefined}
      onCancelStart={launching?.editorKey === editor.key ? launching.cancel : undefined} onStop={stopTarget}
      onManageRuntimes={() => {
        if (lock.current) return;
        const event = new Event(MANAGE_MODEL_RUNTIMES, { cancelable: true });
        if (window.dispatchEvent(event)) setSuspended(true);
      }} /></Suspense>}
  </Context.Provider>;
}
