import { useEffect, useMemo, useState } from 'react';
import type * as api from '../../shared/api/index';
import type { AppStore } from '../../shared/state/store';
import type { Locale, TranslationVars, UnifiedKey } from '../../shared/i18n/i18n';
import { executionText } from '../../shared/i18n/executionI18n';
import { isServerRunning } from '../../shared/lib/serverLifecycle';
import { sessionConfig, sessionDefinitionFromStatus, sessionPort } from '../../shared/runtime/sessionUtils';
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import { useSessionPolling } from '../../shared/hooks/useSessionPolling';
import type { ModelSettingsContext } from '../model-settings/modelSettingsContext';
import { embeddingSessions, selectEmbeddingSession } from './embeddingTarget';

export interface ChatSessionOptions {
  store: AppStore;
  active: boolean;
  modelSettings: ModelSettingsContext | null;
  t: (key: UnifiedKey, vars?: TranslationVars) => string;
  locale: Locale;
}

export function useChatSession({ store, active, modelSettings, t, locale }: ChatSessionOptions) {
  const [sessions, setSessions] = useState<api.SessionStatus[]>([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [selectedSessionId, setSelectedSessionId] = useState('default');
  const [embeddingSelection, setEmbeddingSelection] = useState('auto');
  const [audioSessionId, setAudioSessionId] = useState('');
  const [videoFrames, setVideoFrames] = useState(false);

  // The shared poller also refreshes on session status changes, and serves an
  // open model settings dialog from the same session_list request.
  useSessionPolling({
    active,
    details: true,
    onData: (items) => {
      setSessions(items.filter((item) => item.id !== 'default'));
      setSessionsLoaded(true);
    },
    onError: () => setSessionsLoaded(true),
  });

  const savedSessions = store.cfg?.sessions;
  const namedSessions = useMemo(() => {
    const savedSessionNames = new Map((savedSessions ?? []).map(definition => [definition.id, definition.name?.trim()]));
    return sessions.map(session => {
      const name = savedSessionNames.get(session.id);
      return name && name !== session.name ? { ...session, name } : session;
    });
  }, [savedSessions, sessions]);
  const availableSessions = useMemo(() => [
    ...namedSessions,
    ...(savedSessions ?? []).filter((definition) => !sessions.some((session) => session.id === definition.id)).map((definition): api.SessionStatus => ({
      id: definition.id, name: definition.name, state: 'stopped', model: definition.models.primary_model,
      mmproj: definition.models.mmproj, draft_model: definition.models.draft_model,
    })),
  ], [namedSessions, savedSessions, sessions]);
  const sessionOptions = useMemo(() => [
    { id: 'default', label: t('ui.defaultSession') },
    ...availableSessions.map((session) => ({ id: session.id, label: `${session.name || session.id} · ${sessionPort(session) || '—'} · ${executionText[locale][session.state] ?? session.state}`, disabled: session.state === 'starting' || session.state === 'stopping' })),
  ], [availableSessions, locale, t]);
  const selectedSession = selectedSessionId === 'default' ? null : availableSessions.find((session) => session.id === selectedSessionId) ?? null;
  const selectedDefinition = savedSessions?.find((definition) => definition.id === selectedSessionId)
    ?? (selectedSession && store.cfg ? sessionDefinitionFromStatus(selectedSession, store.cfg) : undefined);
  const selectedSessionAvailable = selectedSessionId === 'default' || selectedSession !== null;

  useEffect(() => {
    if (sessionsLoaded && !selectedSessionAvailable) setSelectedSessionId('default');
  }, [sessionsLoaded, selectedSessionAvailable]);

  const selectedStatus = selectedSession ?? store.status;
  const embeddingCandidates = [{ ...store.status, id: 'default', name: t('ui.defaultSession') }, ...namedSessions];
  const availableEmbeddingSessions = embeddingSessions(embeddingCandidates);
  const embeddingChoice = selectEmbeddingSession(embeddingCandidates, selectedSessionId, embeddingSelection);
  const serverOn = isServerRunning(selectedStatus.state);
  const modalities = selectedStatus.engine?.modalities;
  const visionReady = serverOn && (modalities?.image ?? !!selectedStatus.mmproj);
  const speechSessions = embeddingCandidates.filter(session => isServerRunning(session.state)
    && session.engine?.tasks?.includes('transcription'));
  const mediaOptions = { audioSessionId: speechSessions.some(session => session.id === audioSessionId) ? audioSessionId : undefined, videoFrames };
  const baseUrl = serverOn && selectedStatus.url ? selectedStatus.url : null;
  const apiKey = serverOn ? selectedStatus.api_key ?? '' : '';
  const targetConfig = store.cfg && selectedDefinition ? sessionConfig(store.cfg, selectedDefinition) : store.cfg;
  const configuredModel = selectedDefinition?.models.primary_model ?? (selectedSessionId === 'default' ? store.cfg?.active_model ?? '' : selectedStatus.model ?? '');
  const model = serverOn ? loadedModelPath(selectedStatus, configuredModel) : selectedSessionId === 'default' ? '' : configuredModel;
  const effectiveConfig = targetConfig
    ? modelSettings?.getRequestConfig(selectedSessionId, targetConfig, selectedStatus)
      ?? { ...targetConfig, ...(serverOn ? selectedStatus.execution : {}), active_model: model }
    : null;

  return {
    selectedSessionId, setSelectedSessionId, selectedSession, selectedDefinition, selectedStatus,
    sessionOptions, embeddingSelection, setEmbeddingSelection, availableEmbeddingSessions, embeddingChoice,
    audioSessionId, setAudioSessionId, videoFrames, setVideoFrames, speechSessions, mediaOptions,
    serverOn, modalities, visionReady, baseUrl, apiKey, targetConfig, configuredModel, model, effectiveConfig,
  };
}
