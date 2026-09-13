import type { AppConfig } from '../../shared/api/types';
import { type ExecutionKey } from '../../shared/config/executionSettings';
import { applySettingsProfile, captureProfile, GLOBAL_PROFILE_KEYS, MODEL_PROFILE_KEYS, saveSettingsProfile, type SettingsProfile, type SettingsProfileLibrary } from '../../shared/config/settingsProfiles';
import { BENCHMARK_CONTROLLED_KEYS } from './profileResetState';

export type ProfileChoice = Omit<SettingsProfile, 'scope'> & { scope: SettingsProfile['scope'] | 'preset' };
export const profileCoverage = (profile: SettingsProfile): readonly ExecutionKey[] => profile.legacy
  ? MODEL_PROFILE_KEYS.filter(key => (profile.coverage ?? [...Object.keys(profile.settings), ...(profile.settings.runtime_defaults ?? [])]).includes(key))
  : profile.scope === 'global' ? GLOBAL_PROFILE_KEYS : MODEL_PROFILE_KEYS;

export function benchmarkProfile(profile: SettingsProfile): SettingsProfile {
  const coverage = profileCoverage(profile).filter(key => !BENCHMARK_CONTROLLED_KEYS.has(key));
  const settings = Object.fromEntries(Object.entries(profile.settings).filter(([key]) => key === 'runtime_defaults' || coverage.includes(key as ExecutionKey)));
  if (profile.settings.runtime_defaults) settings.runtime_defaults = profile.settings.runtime_defaults.filter(key => coverage.includes(key as ExecutionKey));
  const partial = { ...profile, legacy: true, coverage, settings };
  delete partial.system_prompt;
  return partial;
}

export function profileForChoice(library: SettingsProfileLibrary, choice: ProfileChoice): SettingsProfile {
  const existing = library.entries.find(entry => entry.id === choice.id);
  if (existing) return existing;
  if (choice.scope !== 'preset') throw new Error('This profile is no longer available.');
  const profile: SettingsProfile = { ...structuredClone(choice), scope: 'global' };
  library.entries.push(profile);
  return profile;
}

export function overwriteProfile(entry: SettingsProfile, cfg: AppConfig, prompt: string, benchmark: boolean): SettingsProfile {
  return saveSettingsProfile(entry, cfg, prompt, benchmark ? BENCHMARK_CONTROLLED_KEYS : undefined, benchmark);
}

/** Saving working values keeps the chosen profile identity across all target types. */
export function overwriteWorkingProfile(entry: SettingsProfile, cfg: AppConfig, prompt: string, benchmark: boolean): SettingsProfile {
  return overwriteProfile(entry, cfg, prompt, benchmark);
}

export function newProfile(cfg: AppConfig, name: string, scope: SettingsProfile['scope'], prompt: string, benchmark: boolean): SettingsProfile {
  const profile = captureProfile(cfg, name, scope, prompt);
  const saved = overwriteProfile(benchmark ? benchmarkProfile(profile) : profile, cfg, prompt, benchmark);
  return { ...saved, revision: 1 };
}

export function applyProfile(cfg: AppConfig, profile: SettingsProfile, benchmark: boolean) {
  return applySettingsProfile(cfg, benchmark ? benchmarkProfile(profile) : profile);
}
