import type { AppConfig } from '../../shared/api/types';
import { defaultServerProfile, defaultModelProfile, serverProfilePatch, modelProfilePatch, activeProfilesPatch } from '../profiles/modelProfiles';
import { normalizeDisplayPath } from '../../shared/lib/displayPaths';

export const MODEL_EXECUTION_KEY = 'aiolm-model-execution';
type Snapshot = Partial<AppConfig>;
type Saved = { version: 1; models: Record<string, Snapshot> };
const identity = (path: string) => normalizeDisplayPath(path).replace(/\\/g, '/').toLowerCase();

/** Capture execution fields only; never copy app preferences, ports, keys or sessions. */
export function executionSnapshot(cfg: AppConfig): Snapshot {
  return structuredClone({
    ...serverProfilePatch(defaultServerProfile(cfg)), ...modelProfilePatch(defaultModelProfile(cfg)),
    runtime_defaults: cfg.runtime_defaults ?? [], lora_adapters: cfg.lora_adapters ?? [],
  });
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
  const saved = read().models[identity(path)];
  // Re-capture through the allowlist even when local storage was manually edited.
  return { ...(saved ? executionSnapshot({ ...cfg, ...saved }) : activeProfilesPatch(cfg, path)), active_model: path };
}

/** Preview a new model without inheriting unrelated model-specific sidecars. */
export function previewExecution(cfg: AppConfig, path: string): Partial<AppConfig> {
  if (path === cfg.active_model) return executionSnapshot(cfg);
  const remembered = read().models[identity(path)];
  const restored = restoreExecution(cfg, path);
  return remembered ? restored : { ...restored, active_model: path, mmproj: '', spec_draft_model: '', spec_type: 'none', lora_adapters: [] };
}

export function forgetExecution(path: string) {
  const value = read();
  delete value.models[identity(path)];
  window.localStorage.setItem(MODEL_EXECUTION_KEY, JSON.stringify(value));
}
