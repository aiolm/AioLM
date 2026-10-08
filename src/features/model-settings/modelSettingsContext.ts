import { createContext, useContext } from 'react';
import type { AppConfig, ServerStatus, SessionDefinition, SessionStatus } from '../../shared/api/types';
import type { ProfileApplication } from '../../shared/config/settingsProfiles';
import type { ModelProfile } from './profileEditor';

export const MANAGE_MODEL_RUNTIMES = 'aiolm:manage-model-runtimes';
export type ExecutionTarget = { kind: 'default' } | { kind: 'session'; sessionId: string } | { kind: 'benchmark' | 'project'; id: string };
export interface ModelSettingsRequest {
  target: ExecutionTarget;
  config?: AppConfig;
  definition?: SessionDefinition;
  section?: string;
  systemPrompt?: string;
  application?: ProfileApplication;
  onApply?: (cfg: AppConfig, application?: ProfileApplication) => Promise<void> | void;
}
export interface ModelSettingsContext {
  open: (request: ModelSettingsRequest) => void;
  suspended: boolean;
  resume: () => void;
  getRequestConfig: (sessionId: string, fallback: AppConfig, status?: ServerStatus | SessionStatus) => AppConfig;
  getRequestProfile: (sessionId: string, cfg: AppConfig) => ModelProfile | null;
}

// Provider implementation updates must retain the context used by mounted consumers.
export const modelSettingsContext = createContext<ModelSettingsContext | null>(null);
export const useModelSettings = () => useContext(modelSettingsContext);
