import type { SessionStatus } from '../../shared/api/types';
import { isServerRunning } from '../../shared/lib/serverLifecycle';

export function embeddingSessions(sessions: SessionStatus[]): SessionStatus[] {
  return sessions.filter(session => isServerRunning(session.state) && session.engine?.embedding_model && session.url);
}

/** Prefer the answering engine; ambiguous other sessions require an explicit selection. */
export function selectEmbeddingSession(sessions: SessionStatus[], answeringSessionId: string, selection: string): SessionStatus | undefined {
  const candidates = embeddingSessions(sessions);
  if (selection !== 'auto') return candidates.find(session => session.id === selection);
  return candidates.find(session => session.id === answeringSessionId) ?? (candidates.length === 1 ? candidates[0] : undefined);
}
