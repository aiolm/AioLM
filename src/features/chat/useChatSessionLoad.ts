import { useRef, useState } from 'react';
import * as api from '../../shared/api/index';
import type { ChatTextKey } from '../../shared/i18n/chatI18n';
import { isLifecycleCancellation } from '../../shared/lib/serverLifecycle';
import { notifySessionStatusChanged } from '../../shared/runtime/sessionUtils';
import { anySessionActivity, sessionHasActivity } from '../../shared/state/sessionActivity';
import { finishTask, getTaskSnapshot, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { prepareSessionProfile } from '../model-settings/prepareSessionProfile';
import type { ChatSessionOptions } from './useChatSession';

interface ChatSessionLoadOptions extends Pick<ChatSessionOptions, 'store' | 'modelSettings' | 't'> {
  selectedSessionId: string;
  selectedSession: api.SessionStatus | null;
  selectedDefinition: api.SessionDefinition | undefined;
  targetConfig: api.AppConfig | null;
  onOpenModels?: () => void;
  requireIdle: () => boolean;
  setError: (message: string | null) => void;
  ct: (key: ChatTextKey) => string;
}

export function useChatSessionLoad({ store, modelSettings, t, selectedSessionId, selectedSession, selectedDefinition, targetConfig, onOpenModels, requireIdle, setError, ct }: ChatSessionLoadOptions) {
  const [startingSession, setStartingSession] = useState(false);
  const currentSessionLoad = useRef<{ id: string; cancelled: boolean } | null>(null);
  const [sessionLoadNotice, setSessionLoadNotice] = useState(false);

  const openModelSettings = () => {
    if (!requireIdle()) return;
    if (modelSettings) modelSettings.open({
      target: selectedSessionId === 'default' ? { kind: 'default' } : { kind: 'session', sessionId: selectedSessionId },
      ...(selectedDefinition ? { definition: selectedDefinition } : {}),
    });
    else onOpenModels?.();
  };
  const startSelectedSession = async () => {
    if (!requireIdle() || startingSession || !targetConfig) return;
    if (selectedSessionId === 'default') { openModelSettings(); return; }
    const latest = store.getConfig?.() ?? store.cfg;
    if (!latest) return;
    if (sessionHasActivity(selectedSessionId) || ((latest.stop_existing_sessions_on_load ?? true) && anySessionActivity())) {
      setError(ct('stopActiveResponseBeforeLoad'));
      return;
    }
    const sessionId = selectedSessionId;
    const operation = { id: sessionId, cancelled: false };
    currentSessionLoad.current = operation;
    const taskId = `session-load-${sessionId}`;
    setStartingSession(true);
    setError(null);
    setSessionLoadNotice(false);
    registerTask({
      id: taskId, kind: 'other', label: `${t('ui.sessionStart')}: ${selectedSession?.name || sessionId}`,
      phase: t('ui.sessionStarting'), interruptible: true,
      cancel: async () => {
        if (currentSessionLoad.current !== operation) return;
        operation.cancelled = true;
        updateTask(taskId, { state: 'cancelling', phase: t('ui.taskCancelling') });
        try { await api.sessionStop(sessionId); }
        catch (caught) { if (currentSessionLoad.current === operation) throw caught; }
      },
    });
    try {
      const definition = latest.sessions?.find((item) => item.id === sessionId) ?? selectedDefinition;
      if (!definition) throw new Error(ct('saveSessionBeforeStart'));
      const prepared = await prepareSessionProfile(store, definition);
      if (operation.cancelled || getTaskSnapshot().find(task => task.id === taskId)?.state !== 'running') {
        finishTask(taskId, 'cancelled');
        setSessionLoadNotice(true);
        return;
      }
      await api.sessionStart(sessionId, prepared, prepared.stop_existing_sessions_on_load ?? true);
      // A stop can race readiness. Do not leave a late successful launch running
      // after the user cancelled this operation.
      if (operation.cancelled) {
        await api.sessionStop(sessionId);
        finishTask(taskId, 'cancelled');
        setSessionLoadNotice(true);
      } else finishTask(taskId, 'completed');
      notifySessionStatusChanged();
      await store.refreshStatus();
    } catch (caught) {
      if (isLifecycleCancellation(caught)) {
        finishTask(taskId, 'cancelled');
        setSessionLoadNotice(true);
      } else {
        const message = caught instanceof Error ? caught.message : String(caught);
        setError(message);
        finishTask(taskId, 'failed', message);
      }
    } finally {
      if (currentSessionLoad.current === operation) currentSessionLoad.current = null;
      setStartingSession(false);
    }
  };
  const cancelSelectedSessionLoad = async () => {
    const operation = currentSessionLoad.current;
    if (!operation) return;
    const taskId = `session-load-${operation.id}`;
    const task = getTaskSnapshot().find(item => item.id === taskId);
    if (task?.state !== 'running') return;
    try { await task.cancel?.(); }
    catch (caught) {
      if (currentSessionLoad.current !== operation) return;
      const message = caught instanceof Error ? caught.message : String(caught);
      setError(message);
      finishTask(taskId, 'failed', message);
    }
  };

  return { startingSession, sessionLoadNotice, openModelSettings, startSelectedSession, cancelSelectedSessionLoad };
}
