import type { AppConfig } from '../../shared/api/types';
import { normalizeDisplayPath } from '../../shared/lib/displayPaths';
import { profileSettingsSnapshot, profileTargetKey } from '../../shared/config/settingsProfiles';

export const MODEL_EXECUTION_KEY = 'aiolm-model-execution';
type Snapshot = Partial<AppConfig>;
type Saved = { version: 1; models: Record<string, Snapshot> };
const identity = (path: string) => normalizeDisplayPath(path).replace(/\\/g, '/').toLowerCase();

/** Capture execution fields only; never copy app preferences, ports, keys or sessions. */
export function executionSnapshot(cfg: AppConfig): Snapshot {
  return structuredClone({ ...profileSettingsSnapshot(cfg), runtime_defaults: cfg.runtime_defaults ?? [], lora_adapters: cfg.lora_adapters ?? [] });
}

function read(): Saved {
  const raw = window.localStorage.getItem(MODEL_EXECUTION_KEY);
  if (!raw) return { version: 1, models: {} };
  const value = JSON.parse(raw) as Saved;
  if (value.version !== 1 || !value.models || typeof value.models !== 'object' || Array.isArray(value.models)) throw new Error('Invalid model execution settings.');
  return value;
}

export function rememberExecution(cfg: AppConfig) {
  if (!cfg.active_model) return;
  const value = read();
  value.models[identity(cfg.active_model)] = executionSnapshot(cfg);
  window.localStorage.setItem(MODEL_EXECUTION_KEY, JSON.stringify(value));
}

export function restoreExecution(cfg: AppConfig, path: string): Partial<AppConfig> {
  if (identity(cfg.active_model) === identity(path)) return { ...executionSnapshot(cfg), active_model: path };
  const application = cfg.settings_profiles?.applied[profileTargetKey(path)];
  const persisted = application && identity(application.model) === identity(path) ? application.settings : undefined;
  const saved = persisted ?? read().models[identity(path)];
  // Re-capture through the allowlist even when local storage was manually edited.
  return { ...executionSnapshot({ ...cfg, mmproj: '', spec_draft_model: '', spec_type: 'none', lora_adapters: [], ...saved }), active_model: path };
}

/** Preview a new model without inheriting unrelated model-specific sidecars. */
export function previewExecution(cfg: AppConfig, path: string): Partial<AppConfig> {
  return restoreExecution(cfg, path);
}

export function forgetExecution(path: string) {
  const value = read();
  delete value.models[identity(path)];
  window.localStorage.setItem(MODEL_EXECUTION_KEY, JSON.stringify(value));
}
