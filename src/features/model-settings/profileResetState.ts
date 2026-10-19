import type { AppConfig } from '../../shared/api/types';
import { applySettingsProfile, MODEL_PROFILE_KEYS } from '../../shared/config/settingsProfiles';
import { providerOf } from '../../shared/api/providers';
import type { EffectiveSchema } from '../../shared/api/runtimeHelp';
import { clearRuntimeOptionOverrides } from '../runtimes/runtimeOptionDefaults';

export const BENCHMARK_CONTROLLED_KEYS = new Set(['ctx_size', 'parallel', 'request_timeout_seconds', 'sleep_idle_seconds', 'temperature', 'top_p', 'top_k', 'chat_options', 'reasoning_effort']);

/** Reset the draft's full profile scope without changing its model or saved profiles. */
export function resetProfileSettings(cfg: AppConfig, benchmark: boolean): AppConfig {
  return applySettingsProfile(cfg, {
    provider: cfg.active_provider ?? 'llama.cpp',
    id: 'profile-defaults', name: 'Defaults', scope: 'model', revision: 1, settings: {},
    ...(benchmark ? { legacy: true, coverage: MODEL_PROFILE_KEYS.filter(key => !BENCHMARK_CONTROLLED_KEYS.has(key)) } : {}),
  });
}

/** Reset editable options, preserving model bindings and connection settings.
 * Prompts belong to the profile editor and are never part of this operation. */
export function resetProfileOptions(cfg: AppConfig, benchmark: boolean, effective?: EffectiveSchema): AppConfig {
  const provider = providerOf(cfg);
  if (provider !== 'llama.cpp') {
    if (!effective || ['stale', 'unchecked'].includes(effective.help_state)) throw new Error('Runtime options have not been checked.');
    return { ...cfg, provider_options: { ...cfg.provider_options,
      [provider]: clearRuntimeOptionOverrides(effective.schema, cfg.provider_options?.[provider] ?? {}, effective.scope) } };
  }
  const defaults = resetProfileSettings(cfg, benchmark);
  const retained = new Set(['request_timeout_seconds', 'sleep_idle_seconds']);
  const runtimeDefaults = [...new Set([...(defaults.runtime_defaults ?? []).filter(key => !retained.has(key)),
    ...(cfg.runtime_defaults ?? []).filter(key => retained.has(key))])].sort();
  return { ...defaults, runtime_defaults: runtimeDefaults, mmproj: cfg.mmproj, spec_draft_model: cfg.spec_draft_model,
    lora_adapters: structuredClone(cfg.lora_adapters), request_timeout_seconds: cfg.request_timeout_seconds,
    sleep_idle_seconds: cfg.sleep_idle_seconds };
}
