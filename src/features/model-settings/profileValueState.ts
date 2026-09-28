import type { AppConfig } from '../../shared/api/types';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { SERVER_OPTIONS, type ServerOption } from '../../shared/config/serverOptions';
import { serverAliasesForRequest, usesRuntimeDefault } from '../../shared/config/tuningDefaults';
import { defaultScalar, tuningResetValues } from '../../shared/config/tuningResetValues';
import { REQUEST_DEFAULTS, serverDefault } from '../../shared/config/optionDefaults';

// Selection and runtime metadata are identity, not tuning; they are never "customized".
const METADATA_KEYS = new Set(['active_model', 'active_backend', 'active_build', 'runtime_defaults']);
const OPTIONAL_TEXT_KEYS = new Set(['mmproj', 'spec_draft_model', 'spec_draft_device']);
const OPTIONAL_LIST_KEYS = new Set(['server_args', 'lora_adapters']);

const text = (value: unknown) => String(value).trim().toLowerCase();
const sameScalar = (left: unknown, right: unknown) =>
  typeof left === 'number' && typeof right === 'number' ? left === right : text(left) === text(right);

/** The app omits these flags so the runtime picks automatically; they are not user overrides. */
function isAutomatic(key: string, value: unknown): boolean {
  if (key === 'threads' || key === 'parallel') return typeof value === 'number' && value <= 0;
  if (key === 'reasoning' || key === 'reasoning_preserve') return text(value) === 'auto';
  if (key === 'reasoning_effort') return text(value) === 'default';
  return false;
}

function customizedGpu(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const gpu = value as Partial<NonNullable<AppConfig['gpu']>>;
  return (gpu.gpu_ids?.length ?? 0) > 0 || (gpu.tensor_split?.length ?? 0) > 0
    || (gpu.main_gpu ?? null) !== null || (gpu.draft_gpu_id ?? null) !== null
    || (gpu.split_mode ?? 'none') !== 'none';
}

/**
 * Whether a profile value differs from what the app would otherwise use, so it can be emphasized.
 * Inherited fields and values that cannot be compared stay muted rather than being guessed.
 */
export function isCustomizedSetting(key: string, value: unknown, settings: Partial<ExecutionSettings>, options: readonly ServerOption[], verified: boolean): boolean {
  if (METADATA_KEYS.has(key) || value === undefined || value === null) return false;
  if (OPTIONAL_TEXT_KEYS.has(key)) return typeof value === 'string' && value.trim() !== '';
  if (OPTIONAL_LIST_KEYS.has(key)) return Array.isArray(value) && value.length > 0;
  if (key === 'chat_options') return typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
  if (key === 'gpu') return customizedGpu(value);
  // A stale scalar beneath an inheritance marker is not what the runtime receives.
  if (usesRuntimeDefault(settings, key) || isAutomatic(key, value)) return false;
  // Only a verified runtime's help supplies runtime defaults; otherwise use the repository reference.
  const defaults = tuningResetValues(verified ? options : SERVER_OPTIONS) as Record<string, unknown>;
  if (!(key in defaults) || defaults[key] === undefined) {
    // The profile details flatten extra request options into individual rows.
    if (Object.prototype.hasOwnProperty.call(settings.chat_options ?? {}, key)) {
      const aliases = serverAliasesForRequest(key);
      const catalogue = verified ? options : SERVER_OPTIONS;
      const option = catalogue.find(item => item.flags.some(flag => aliases.includes(flag)));
      const baseline = defaultScalar(option ? serverDefault(option, catalogue).value : REQUEST_DEFAULTS[key]?.value ?? null);
      return baseline === undefined || !sameScalar(value, baseline);
    }
    return false;
  }
  return !sameScalar(value, defaults[key]);
}
