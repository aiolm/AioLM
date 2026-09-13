import type { AppConfig } from '../../shared/api/types';
import { applySettingsProfile, MODEL_PROFILE_KEYS } from '../../shared/config/settingsProfiles';

export const BENCHMARK_CONTROLLED_KEYS = new Set(['ctx_size', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds', 'temperature', 'top_p', 'top_k', 'chat_options', 'reasoning_effort']);

/** Reset the draft's full profile scope without changing its model or saved profiles. */
export function resetProfileSettings(cfg: AppConfig, benchmark: boolean): AppConfig {
  return applySettingsProfile(cfg, {
    id: 'profile-defaults', name: 'Defaults', scope: 'model', revision: 1, settings: {},
    ...(benchmark ? { legacy: true, coverage: MODEL_PROFILE_KEYS.filter(key => !BENCHMARK_CONTROLLED_KEYS.has(key)) } : {}),
  });
}
