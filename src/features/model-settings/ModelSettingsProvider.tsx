import { createContext, lazy, Suspense, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';
import { executionChanges, executionConfig, executionSettings, mergeExecutionChanges, serverSettingsChanged, settingsForSession, ExecutionConflictError } from '../../shared/config/executionSettings';
import { sessionConfig, notifySessionStatusChanged } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import { getTaskSnapshot } from '../../shared/state/taskRegistry';
import { useI18n } from '../../shared/i18n/i18n';
import { getActiveModelProfile, loadProfiles, saveProfileSelection, type ModelProfile } from '../profiles/modelProfiles';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';

const ModelSettingsDialog = lazy(() => import('./ModelSettingsDialog'));
export const MANAGE_MODEL_RUNTIMES = 'aiolm:manage-model-runtimes';
export type ExecutionTarget = { kind: 'default' } | { kind: 'session'; sessionId: string } | { kind: 'benchmark' | 'project'; id: string };
export interface ModelSettingsRequest {
  target: ExecutionTarget;
  config?: api.AppConfig;
  definition?: api.SessionDefinition;
  section?: string;
  onApply?: (cfg: api.AppConfig) => Promise<void> | void;
}
type ProfileChoice = { serverProfileId?: string; modelProfileId?: string; systemPrompt?: string };
export interface ModelSettingsContext {
  open: (request: ModelSettingsRequest) => void;
  suspended: boolean;
  resume: () => void;
  getRequestConfig: (sessionId: string, fallback: api.AppConfig, status?: api.ServerStatus | api.SessionStatus) => api.AppConfig;
  getRequestProfile: (sessionId: string, cfg: api.AppConfig) => ModelProfile | null;
}
const Context = createContext<ModelSettingsContext | null>(null);
export const useModelSettings = () => useContext(Context);
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
  const liveProfiles = useRef(new Map<string, { model: string; pid?: number; profile: ModelProfile | null }>());
  const open = useCallback((request: ModelSettingsRequest) => {
    if (lock.current) return;
    const cfg = latest.current.getConfig();
    if (!cfg) return;
    const target = request.target;
    const definition = target.kind === 'session' ? cfg.sessions?.find(item => item.id === target.sessionId) ?? request.definition : undefined;
    if (request.target.kind === 'session' && !definition) { setError(copy.missing); return; }
    const base = definition ? sessionConfig(cfg, definition) : request.target.kind === 'default' ? cfg : request.config ?? cfg;
    const status = latest.current.status;
    const initial = request.config ?? (target.kind === 'default' && status.state === 'running' && status.model !== cfg.active_model
      ? { ...executionConfig(cfg, status.execution ?? {}), active_model: status.model ?? '' }
      : base);
    setEditor({ request, base: structuredClone(base), baseDefinition: definition ? structuredClone(definition) : undefined, initial: structuredClone(initial), key: ++counter.current,
      existingSession: !!definition && !!cfg.sessions?.some(item => item.id === definition.id) });
    setSuspended(false); setError('');
  }, [copy.missing]);
  const editorKey = editor?.key;
  useEffect(() => {
    if (editorKey === undefined || !api.isNativeRuntimeAvailable()) return;
    let disposed = false;
    const refresh = () => { void api.sessionList().then(value => { if (!disposed) setSessions(api.normalizeSessionList(value)); }).catch(() => undefined); };
    refresh(); const timer = window.setInterval(refresh, 1500);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [editorKey]);
  const getRequestConfig = useCallback((id: string, fallback: api.AppConfig, status?: api.ServerStatus | api.SessionStatus) => {
    const cached = liveProfiles.current.get(id);
    if (cached && status?.pid !== undefined && cached.pid !== status.pid) liveProfiles.current.delete(id);
    const live = status?.execution;
    const cfg = executionConfig(fallback, live ?? {});
    if (status?.model) cfg.active_model = status.model;
    if (status?.mmproj !== undefined) cfg.mmproj = status.mmproj;
    return cfg;
  }, []);
  const getRequestProfile = useCallback((id: string, cfg: api.AppConfig): ModelProfile | null => {
    const live = liveProfiles.current.get(id);
    if (live?.model === cfg.active_model) return live.profile;
    const profileId = latest.current.getConfig()?.sessions?.find(item => item.id === id)?.model_profile_id;
    return profileId ? loadProfiles(cfg, cfg.active_model).model.find(item => item.id === profileId) ?? null : getActiveModelProfile(cfg);
  }, []);
  const apply = async (draft: api.AppConfig, intent: 'save' | 'start', profile?: ProfileChoice) => {
    if (!editor || lock.current) return;
    lock.current = true; setBusy(true);
    try {
      const current = latest.current.getConfig();
      if (!current) throw new Error(copy.loading);
      const { target } = editor.request;
      if (target.kind === 'benchmark' || target.kind === 'project') {
        await editor.request.onApply?.(executionConfig(current, executionSettings(draft)));
        setEditor(null); return;
      }
      const id = target.kind === 'session' ? target.sessionId : 'default';
      if (latest.current.busy || getTaskSnapshot().some(task => ['runtime', 'benchmark'].includes(task.kind) && ['running', 'cancelling'].includes(task.state))) throw new Error(copy.busy);
      const list = api.normalizeSessionList(await api.sessionList());
      const status = id === 'default' ? await api.serverStatus() : list.find(item => item.id === id);
      if (status && ['starting', 'stopping'].includes(status.state)) throw new Error(copy.busy);
      const existing = target.kind === 'session' ? current.sessions?.find(item => item.id === id) : undefined;
      const definition = existing ?? editor.request.definition;
      if (target.kind === 'session' && (!definition || (editor.existingSession && !existing))) throw new Error(copy.missing);
      const baseCurrent = definition ? sessionConfig(current, definition) : current;
      let next: api.AppConfig;
      try { next = mergeExecutionChanges(editor.base, draft, baseCurrent); }
      catch (cause) { if (cause instanceof ExecutionConflictError) throw new Error(copy.conflict + cause.fields.join(', ')); throw cause; }
      const live = status?.execution ? executionConfig(current, status.execution) : editor.base;
      const requestOnly = status?.state === 'running' && !serverSettingsChanged(live, next);
      if (intent === 'start' && (sessionHasActivity(id) || (status?.active_requests ?? 0) > 0 || (current.stop_existing_sessions_on_load !== false && (anySessionActivity() || list.some(session => (session.active_requests ?? 0) > 0))))) throw new Error(copy.activity);
      if (status?.state === 'running' && !liveProfiles.current.has(id)) liveProfiles.current.set(id, { model: live.active_model, pid: status.pid, profile: structuredClone(getRequestProfile(id, live)) });
      if (intent === 'start') next = await api.preflightLaunch(next);
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
          const updated = { ...settingsForSession(source, resolved),
            ...metadataPatch,
            ...(profile?.modelProfileId ? { model_profile_id: profile.modelProfileId } : {}) };
          return { sessions: [...(latestCfg.sessions ?? []).filter(item => item.id !== id), updated] };
        });
        saved = sessionConfig(cfg, cfg.sessions!.find(item => item.id === id)!);
      } else {
        saved = await latest.current.updateConfig(latestCfg => executionChanges(latestCfg, mergeExecutionChanges(editor.base, next, latestCfg)));
        if (profile?.modelProfileId || profile?.serverProfileId) {
          const selection = loadProfiles(saved, saved.active_model);
          saveProfileSelection(profile.serverProfileId ?? selection.activeServerId, saved.active_model, profile.modelProfileId ?? selection.activeModelId);
        }
      }
      // A successful save is retained if a subsequent launch fails or is cancelled.
      setEditor(previous => previous ? { ...previous, base: structuredClone(saved), initial: previous.initial, existingSession: true } : null);
      if (intent === 'start') {
        setLaunching(true);
        if (target.kind === 'session') await api.sessionStart(id, saved, saved.stop_existing_sessions_on_load);
        else await latest.current.start(saved, status?.state === 'running');
        liveProfiles.current.delete(id);
      } else if (requestOnly) {
        await api.applyRequestSettings(saved, id);
        liveProfiles.current.delete(id);
      }
      await editor.request.onApply?.(saved);
      await latest.current.refreshStatus(); notifySessionStatusChanged();
      setEditor(null);
    } finally { lock.current = false; setBusy(false); setLaunching(false); }
  };
  const target = editor?.request.target;
  const id = target?.kind === 'session' ? target.sessionId : 'default';
  const liveStatus = target?.kind === 'session' ? sessions.find(item => item.id === id) : target?.kind === 'default' ? store.status : undefined;
  const liveState = liveStatus?.state ?? (target?.kind === 'session' ? 'stopped' : undefined);
  const stopsOtherSessions = (target?.kind === 'session' || target?.kind === 'default') && store.cfg?.stop_existing_sessions_on_load !== false
    && (sessions.some(session => session.id !== id && ['running', 'starting', 'stopping'].includes(session.state))
      || (target.kind === 'session' && ['running', 'starting', 'stopping'].includes(store.status.state)));
  const targetLabel = target ? `${copy[target.kind]}${target.kind === 'session' ? `: ${store.cfg?.sessions?.find(item => item.id === id)?.name || id}` : ''}` : '';
  return <Context.Provider value={{ open, suspended, resume: () => setSuspended(false), getRequestConfig, getRequestProfile }}>
    {children}
    {error && <FeedbackBanner tone="error" onDismiss={() => setError('')}>{normalizeDisplayText(error)}</FeedbackBanner>}
    {editor && <Suspense fallback={<div role="status">{copy.loading}</div>}><ModelSettingsDialog key={editor.key} open={!suspended} initialConfig={editor.initial} targetLabel={targetLabel} mode={editor.request.target.kind}
      requireModelSelection={editor.request.target.kind === 'default' && !editor.request.config && !['running', 'starting', 'stopping'].includes(store.status.state)}
      initialSection={editor.request.section} busy={busy} liveState={liveState} liveConfig={store.cfg && liveStatus?.execution ? executionConfig(store.cfg, liveStatus.execution) : undefined} onApply={apply} onClose={() => { if (!lock.current) setEditor(null); }}
      executionNotice={stopsOtherSessions ? <p>{copy.stopOthers}</p> : undefined}
      onCancelStart={launching ? () => { void (id === 'default' ? latest.current.stop() : api.sessionStop(id)).catch(cause => setError(String(cause))); } : undefined}
      onManageRuntimes={() => { setSuspended(true); window.dispatchEvent(new Event(MANAGE_MODEL_RUNTIMES)); }} /></Suspense>}
  </Context.Provider>;
}
