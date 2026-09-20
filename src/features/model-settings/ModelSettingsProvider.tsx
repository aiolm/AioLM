import { createContext, lazy, Suspense, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';
import { executionChanges, executionConfig, executionSettings, mergeExecutionChanges, REQUEST_KEYS, serverSettingsChanged, settingsForSession, ExecutionConflictError } from '../../shared/config/executionSettings';
import { sessionConfig, notifySessionStatusChanged } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import { getTaskSnapshot } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import type { ModelProfile } from '../profiles/modelProfiles';
import { appliedProfile, mergeProfileEditor, profileLibrary, profileLibraryConfigPatch, requestProfileFromApplication, SettingsDeliveryError, type ProfileCommitResult, type ProfileEditorResult } from './profileEditor';
import { ensureProfileLibrary, materializeProfileApplication, profileSettingsSnapshot, profileTargetKey, settingsEqual, type ProfileApplication } from '../../shared/config/settingsProfiles';
import { applyDefaultProfile, resolveProfileApplicationOrDefault, resolveProfileForExecution } from '../../shared/config/profileAssignments';
import { applyProfile } from './profileWorkspaceState';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';

const ModelSettingsDialog = lazy(() => import('./ModelSettingsDialog'));
export const MANAGE_MODEL_RUNTIMES = 'aiolm:manage-model-runtimes';
export type ExecutionTarget = { kind: 'default' } | { kind: 'session'; sessionId: string } | { kind: 'benchmark' | 'project'; id: string };
export interface ModelSettingsRequest {
  target: ExecutionTarget;
  config?: api.AppConfig;
  definition?: api.SessionDefinition;
  section?: string;
  systemPrompt?: string;
  application?: ProfileApplication;
  onApply?: (cfg: api.AppConfig, application?: ProfileApplication) => Promise<void> | void;
}
export interface ModelSettingsContext {
  open: (request: ModelSettingsRequest) => void;
  suspended: boolean;
  resume: () => void;
  getRequestConfig: (sessionId: string, fallback: api.AppConfig, status?: api.ServerStatus | api.SessionStatus) => api.AppConfig;
  getRequestProfile: (sessionId: string, cfg: api.AppConfig) => ModelProfile | null;
}
const Context = createContext<ModelSettingsContext | null>(null);
export const useModelSettings = () => useContext(Context);

function assignedTarget(config: api.AppConfig, application?: ProfileApplication, sessionId = 'default'): ProfileCommitResult {
  const library = application?.profile_id && config.settings_profiles ? ensureProfileLibrary(config.settings_profiles) : profileLibrary(config);
  const resolved = resolveProfileForExecution(config, library, application, profileTargetKey(config.active_model, sessionId));
  return { config: { ...executionConfig(config, resolved.application.settings), settings_profiles: resolved.library }, application: resolved.application };
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
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState('');
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const lock = useRef(false);
  const liveProfiles = useRef(new Map<string, { model: string; pid?: number; application: ProfileApplication }>());
  const deletedProfileFallbacks = useRef(new Map<string, ProfileApplication>());
  const requestFallback = useCallback((id: string, model: string) => {
    const key = profileTargetKey(model, id);
    const fallback = deletedProfileFallbacks.current.get(key);
    if (!fallback || profileTargetKey(fallback.model) !== profileTargetKey(model)) return undefined;
    const current = latest.current.getConfig()?.settings_profiles?.applied[key];
    if (!current || current.profile_id !== fallback.profile_id || !settingsEqual(current.settings, fallback.settings) || current.system_prompt !== fallback.system_prompt) {
      deletedProfileFallbacks.current.delete(key); return undefined;
    }
    return current;
  }, []);
  const open = useCallback((request: ModelSettingsRequest) => {
    if (lock.current) return;
    const cfg = latest.current.getConfig();
    if (!cfg) return;
    const target = request.target;
    const definition = target.kind === 'session' ? cfg.sessions?.find(item => item.id === target.sessionId) ?? request.definition : undefined;
    if (request.target.kind === 'session' && !definition) { setError(copy.missing); return; }
    let base = definition ? sessionConfig(cfg, definition) : request.target.kind === 'default' ? cfg : request.config ? executionConfig(cfg, executionSettings(request.config)) : cfg;
    const status = latest.current.status;
    let initial = request.config ? executionConfig(cfg, executionSettings(request.config)) : (target.kind === 'default' && status.state === 'running' && status.model !== cfg.active_model
      ? { ...executionConfig(cfg, status.execution ?? {}), active_model: status.model ?? '' }
      : base);
    const id = target.kind === 'session' ? target.sessionId : 'default';
    const external = target.kind === 'project' || target.kind === 'benchmark';
    const reference = request.application ?? (external && request.config
      ? { model: initial.active_model, settings: profileSettingsSnapshot(initial), system_prompt: request.systemPrompt ?? '' }
      : appliedProfile({ ...cfg, active_model: initial.active_model }, id));
    const assigned = assignedTarget(initial, reference, id);
    initial = assigned.config;
    if (external) base = assigned.config;
    request = { ...request, application: assigned.application, systemPrompt: assigned.application.system_prompt };
    setEditor({ request, base: structuredClone(base), baseDefinition: definition ? structuredClone(definition) : undefined, initial: structuredClone(initial), key: ++counter.current,
      existingSession: !!definition && !!cfg.sessions?.some(item => item.id === definition.id) });
    setSuspended(false); setError('');
  }, [copy.missing]);
  useSessionPolling({
    active: editor !== null && !suspended && api.isNativeRuntimeAvailable(),
    details: true,
    onData: setSessions,
    intervalMs: 1500,
  });
  const getRequestConfig = useCallback((id: string, fallback: api.AppConfig, status?: api.ServerStatus | api.SessionStatus) => {
    const cached = liveProfiles.current.get(id);
    if (cached && status?.pid !== undefined && cached.pid !== status.pid) liveProfiles.current.delete(id);
    const live = status?.execution;
    const cfg = executionConfig(fallback, live ?? {});
    if (status?.model) cfg.active_model = status.model;
    if (status?.mmproj !== undefined) cfg.mmproj = status.mmproj;
    const replacement = requestFallback(id, cfg.active_model);
    if (replacement) {
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
  const savedTarget = (current: api.AppConfig, modelPath: string, previousApplication?: ProfileApplication): ProfileCommitResult => {
    if (!editor) throw new Error(copy.loading);
    const { target } = editor.request;
    if (target.kind === 'project' || target.kind === 'benchmark') {
      const config = { ...executionConfig(current, executionSettings(editor.base)), active_model: modelPath };
      const application = previousApplication ?? editor.request.application;
      if (application && profileTargetKey(application.model) === profileTargetKey(modelPath)) return assignedTarget(config, application);
      if (!application && profileTargetKey(editor.base.active_model) === profileTargetKey(modelPath)) {
        return assignedTarget(config, { model: config.active_model, settings: profileSettingsSnapshot(config), system_prompt: editor.request.systemPrompt ?? '' });
      }
      const remembered = appliedProfile({ ...current, active_model: modelPath });
      return assignedTarget(config, remembered ?? applyDefaultProfile(config, profileLibrary(current)).application);
    }
    const id = target.kind === 'session' ? target.sessionId : 'default';
    const definition = target.kind === 'session' ? current.sessions?.find(item => item.id === id) ?? (!editor.existingSession ? editor.request.definition : undefined) : undefined;
    if (target.kind === 'session' && !definition) throw new Error(copy.missing);
    const config = definition ? sessionConfig(current, definition) : current;
    const sameModel = profileTargetKey(config.active_model) === profileTargetKey(modelPath);
    const application = appliedProfile({ ...current, active_model: modelPath }, sameModel ? id : 'default');
    if (sameModel) return assignedTarget(config, application, id);
    const selected = executionConfig(current, { ...executionSettings(editor.base), ...(application?.settings ?? {}), active_model: modelPath });
    return assignedTarget(selected, application, id);
  };
  const rebase = (result: ProfileCommitResult) => {
    setEditor(previous => {
      if (!previous) return null;
      const current = latest.current.getConfig() ?? result.config;
      const target = previous.request.target;
      const definition = target.kind === 'session' ? current.sessions?.find(item => item.id === target.sessionId) : undefined;
      const base = target.kind === 'default' ? current : definition ? sessionConfig(current, definition) : result.config;
      return { ...previous, base: structuredClone(base),
        request: { ...previous.request, application: structuredClone(result.application) },
        existingSession: previous.existingSession || !!definition };
    });
  };
  const reloadProfile = async (modelPath: string): Promise<ProfileCommitResult> => {
    if (!editor || lock.current) throw new Error(copy.busy);
    const current = latest.current.getConfig();
    if (!current) throw new Error(copy.loading);
    const result = savedTarget(current, modelPath);
    rebase(result);
    return structuredClone(result);
  };
  const persist = async (draft: api.AppConfig, intent: 'save' | 'start', profile: ProfileEditorResult, close: boolean, applyTarget = true): Promise<ProfileCommitResult> => {
    if (!editor || lock.current) throw new Error(copy.busy);
    lock.current = true; setBusy(true);
    let persisted: api.AppConfig | undefined;
    let application = profile.application;
    // Set once the launch has been issued and left to finish on its own, so the
    // shared cleanup below does not cancel the state that tracks it.
    let handedOff = false;
    try {
      const current = latest.current.getConfig();
      if (!current) throw new Error(copy.loading);
      const { target } = editor.request;
      if (!applyTarget) {
        const previousLibrary = current.settings_profiles;
        const externalApplication = target.kind === 'project' || target.kind === 'benchmark'
          ? savedTarget(current, draft.active_model).application : undefined;
        const saved = await latest.current.updateConfig(latestCfg => profileLibraryConfigPatch(latestCfg, { ...profile, saveMode: undefined }));
        const removed = new Set((previousLibrary?.entries ?? []).filter(entry => !saved.settings_profiles?.entries.some(next => next.id === entry.id)).map(entry => entry.id));
        for (const [key, previous] of Object.entries(previousLibrary?.applied ?? {})) {
          const replacement = saved.settings_profiles?.applied[key];
          if (previous.profile_id && removed.has(previous.profile_id) && replacement) deletedProfileFallbacks.current.set(key, structuredClone(replacement));
        }
        for (const [key, cached] of liveProfiles.current) if (cached.application.profile_id && removed.has(cached.application.profile_id)) liveProfiles.current.delete(key);
        const result = savedTarget(saved, draft.active_model, externalApplication);
        persisted = result.config; application = result.application;
        rebase(result);
        if (externalApplication?.profile_id && removed.has(externalApplication.profile_id)) await editor.request.onApply?.(result.config, result.application);
        return structuredClone(result);
      }
      if (!profile.saveMode) {
        const selected = profile.library.entries.find(entry => entry.id === profile.application.profile_id);
        if (!selected) throw new Error('This profile is no longer available.');
        draft = applyProfile(draft, selected, target.kind === 'benchmark');
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
        draft = applyProfile(draft, entry, target.kind === 'benchmark');
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
      const id = target.kind === 'session' ? target.sessionId : 'default';
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
        application: structuredClone(resolveProfileApplicationOrDefault(live, profileLibrary(live), appliedProfile(live, id), profileTargetKey(live.active_model, id)).application) });
      if (intent === 'start') next = await api.preflightLaunch(next);
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
          const updated = { ...settingsForSession(source, resolved), ...metadataPatch };
          delete updated.model_profile_id;
          application = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
          return { sessions: [...(latestCfg.sessions ?? []).filter(item => item.id !== id), updated], settings_profiles: mergeProfileEditor(latestCfg, { ...edit, application }, id) };
        });
        saved = sessionConfig(cfg, cfg.sessions!.find(item => item.id === id)!);
      } else {
        saved = await latest.current.updateConfig(latestCfg => {
          const resolved = mergeExecutionChanges(editor.base, next, latestCfg);
          application = { ...application, model: resolved.active_model, settings: profileSettingsSnapshot(resolved) };
          return { ...executionChanges(latestCfg, resolved), settings_profiles: mergeProfileEditor(latestCfg, { ...edit, application }, id) };
        });
      }
      application = appliedProfile(saved, id) ?? { ...application, settings: profileSettingsSnapshot(saved) };
      deletedProfileFallbacks.current.delete(profileTargetKey(saved.active_model, id));
      persisted = saved;
      // A successful save is retained if a subsequent launch fails or is cancelled.
      const result = { config: saved, application };
      rebase(result);
      if (intent === 'start') {
        setLaunching(true);
        handedOff = true;
        liveProfiles.current.set(id, { model: saved.active_model, application: structuredClone(application) });
        // Reading a model into VRAM takes minutes. Awaiting it here held a modal
        // dialog over the whole app and kept the lock that gates reopening it, so
        // nothing could be touched until the load finished. The launch is handed
        // off instead; the status badge, the header's stop button and the task
        // strip already report it, and the store records a default-target failure
        // as its own banner rather than one this dialog has to still be open for.
        void (target.kind === 'session'
          ? api.sessionStart(id, saved, saved.stop_existing_sessions_on_load).catch(cause => setError(String(cause)))
          : latest.current.start(saved, status?.state === 'running').catch(() => undefined))
          .finally(() => { setLaunching(false); void latest.current.refreshStatus().catch(() => undefined); notifySessionStatusChanged(); });
      } else if (requestOnly) {
        await api.applyRequestSettings(saved, id);
        liveProfiles.current.set(id, { model: saved.active_model, pid: status?.pid, application: structuredClone(application) });
      }
      await editor.request.onApply?.(saved, application);
      await latest.current.refreshStatus(); notifySessionStatusChanged();
      if (close) setEditor(null);
      return structuredClone(result);
    } catch (cause) {
      if (persisted) throw new SettingsDeliveryError(String(cause), persisted, application);
      throw cause;
    } finally { lock.current = false; setBusy(false); if (!handedOff) setLaunching(false); }
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
  const liveApplication = cachedApplication && cachedApplication.pid === liveStatus?.pid && cachedApplication.model === liveStatus?.model
    ? cachedApplication.application : store.cfg && liveStatus?.model ? appliedProfile({ ...store.cfg, active_model: liveStatus.model }, id) : undefined;
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
      initialSection={editor.request.section} busy={busy} liveState={liveState} liveConfig={store.cfg && liveStatus?.execution ? executionConfig(store.cfg, liveStatus.execution) : undefined} onApply={apply} onClose={() => { if (!lock.current) setEditor(null); }}
      onProfileCommit={commitProfile} onReloadProfile={reloadProfile}
      sessionId={id} initialApplication={editor.request.application ?? (editor.request.target.kind === 'project' || editor.request.target.kind === 'benchmark'
        ? assignedTarget(editor.initial, { model: editor.initial.active_model, settings: profileSettingsSnapshot(editor.initial), system_prompt: editor.request.systemPrompt ?? '' }).application : appliedProfile(editor.initial, id))}
      liveApplication={liveApplication}
      executionNotice={stopsOtherSessions ? <p>{copy.stopOthers}</p> : undefined}
      onCancelStart={launching ? stopTarget : undefined} onStop={stopTarget}
      onManageRuntimes={() => { setSuspended(true); window.dispatchEvent(new Event(MANAGE_MODEL_RUNTIMES)); }} /></Suspense>}
  </Context.Provider>;
}
