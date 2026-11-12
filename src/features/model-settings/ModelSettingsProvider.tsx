import { lazy,Suspense,useCallback,useEffect,useMemo,useRef,useState,type ReactNode } from 'react';
import * as api from '../../shared/api/index';
import { providerOf } from '../../shared/api/providers';
import { executionConfig,executionSettings,REQUEST_KEYS } from '../../shared/config/executionSettings';
import { applyDefaultProfile } from '../../shared/config/profileAssignments';
import { mergeProviderRequestSettings } from '../../shared/config/providerRequestSettings';
import { ensureProfileLibrary,profileSettingsSnapshot,profileTargetKey,settingsEqual,type ProfileApplication } from '../../shared/config/settingsProfiles';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import { useI18n } from '../../shared/i18n/i18n';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { sessionConfig } from '../../shared/runtime/sessionUtils';
import type { AppStore } from '../../shared/state/store';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { modelSettingsContext as Context,MANAGE_MODEL_RUNTIMES,type ModelSettingsRequest } from './modelSettingsContext';
import { assignedTarget,createProfilePersistence,type LaunchCancellation,type SettingsEditor } from './modelSettingsPersistence';
import { appliedProfile,profileLibrary,requestProfileFromApplication,type ModelProfile } from './profileEditor';

export { MANAGE_MODEL_RUNTIMES,useModelSettings } from './modelSettingsContext';
export type { ExecutionTarget,ModelSettingsContext,ModelSettingsRequest } from './modelSettingsContext';

const ModelSettingsDialog = lazy(() => import('./ModelSettingsDialog'));
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
  const [editor, setEditor] = useState<SettingsEditor | null>(null);
  const [suspended, setSuspended] = useState(false);
  const resume = useCallback(() => setSuspended(false), []);
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
  const { apply, commitProfile, reloadProfile } = createProfilePersistence({ latest, editor, lock, persistOwner, startInFlight, liveProfiles, deletedProfileFallbacks, setEditor, setBusy, setLaunching, setPreflightState, copy, locale, targetLabel, open });
  // Stopping this target, whether it is still loading or already serving. The
  // dialog offers it in place of a launch while the model is up, so there is
  // somewhere to stop from without closing the settings first.
  const stopTarget = () => { void (id === 'default' ? latest.current.stop() : api.sessionStop(id)).catch(cause => setError(String(cause))); };
  const contextValue = useMemo(() => ({ open, suspended, resume, getRequestConfig, getRequestProfile }),
    [open, suspended, resume, getRequestConfig, getRequestProfile]);
  return <Context.Provider value={contextValue}>
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
      onCancelStart={launching?.editorKey === editor.key ? () => { void launching.cancel().catch((cause: unknown) => setError(String(cause))); } : undefined} onStop={stopTarget}
      onManageRuntimes={() => {
        if (lock.current) return;
        const event = new Event(MANAGE_MODEL_RUNTIMES, { cancelable: true });
        if (window.dispatchEvent(event)) setSuspended(true);
      }} /></Suspense>}
  </Context.Provider>;
}
