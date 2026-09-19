import type { AppConfig, SessionDefinition } from '../api/types';

/** Only model execution fields cross the settings editor boundary. */
export const EXECUTION_KEYS = [
  'active_model', 'active_backend', 'active_build', 'runtime_defaults', 'ngl', 'ctx_size',
  'batch_size', 'ubatch_size', 'keep', 'cache_type_k', 'cache_type_v', 'flash_attn', 'n_cpu_moe',
  'threads', 'temperature', 'top_p', 'top_k', 'spec_type', 'spec_draft_n_max', 'spec_draft_n_min',
  'spec_draft_p_min', 'spec_draft_p_split', 'spec_draft_ngl', 'spec_draft_device', 'spec_draft_model',
  'reasoning', 'reasoning_format', 'reasoning_effort', 'reasoning_budget', 'reasoning_budget_message',
  'reasoning_preserve', 'server_args', 'chat_options', 'mmproj', 'parallel',
  'request_timeout_seconds', 'sleep_idle_seconds', 'lora_adapters', 'gpu',
] as const satisfies readonly (keyof AppConfig)[];
export type ExecutionKey = typeof EXECUTION_KEYS[number];
export type ExecutionSettings = Pick<AppConfig, ExecutionKey>;
export type SessionExecutionSettings = Partial<Omit<ExecutionSettings, 'active_model' | 'mmproj' | 'spec_draft_model' | 'gpu'>>;
const SESSION_BINDING_KEYS: readonly string[] = ['active_model', 'mmproj', 'spec_draft_model', 'gpu'];
export const REQUEST_KEYS = ['temperature', 'top_p', 'top_k', 'reasoning_effort', 'chat_options'] as const;
const requestDefaultKeys: readonly string[] = ['temperature', 'top_p', 'top_k', 'reasoning_effort'];

export function executionSettings(cfg: Partial<AppConfig>): ExecutionSettings {
  return structuredClone(Object.fromEntries(EXECUTION_KEYS.filter(key => cfg[key] !== undefined).map(key => [key, cfg[key]]))) as ExecutionSettings;
}

export function executionConfig(base: AppConfig, settings: Partial<ExecutionSettings>): AppConfig {
  return { ...base, ...executionSettings(settings) };
}

export function sessionExecutionSettings(cfg: AppConfig): SessionExecutionSettings {
  return Object.fromEntries(Object.entries(executionSettings(cfg)).filter(([key]) => !SESSION_BINDING_KEYS.includes(key))) as SessionExecutionSettings;
}

export function settingsForSession(definition: SessionDefinition, cfg: AppConfig): SessionDefinition {
  return { ...definition, models: { primary_model: cfg.active_model, mmproj: cfg.mmproj, draft_model: cfg.spec_draft_model },
    gpu: structuredClone(cfg.gpu ?? { gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null }),
    execution: sessionExecutionSettings(cfg) };
}

const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
const comparableGpu = (gpu: AppConfig['gpu']) => ({ gpu_ids: gpu?.gpu_ids ?? [], main_gpu: gpu?.main_gpu ?? null,
  split_mode: gpu?.split_mode ?? 'none', tensor_split: gpu?.tensor_split ?? [], draft_gpu_id: gpu?.draft_gpu_id ?? null });
const normalizedRuntimeDefaults = (value: unknown) => [...new Set(Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string') : [])].sort();
const equalExecutionValue = (key: ExecutionKey, left: unknown, right: unknown) => {
  if (key === 'runtime_defaults') return equal(normalizedRuntimeDefaults(left), normalizedRuntimeDefaults(right));
  if (key === 'gpu') return equal(comparableGpu(left as AppConfig['gpu']), comparableGpu(right as AppConfig['gpu']));
  return equal(left, right);
};

export function executionChanges(base: AppConfig, draft: AppConfig): Partial<ExecutionSettings> {
  return structuredClone(Object.fromEntries(EXECUTION_KEYS.filter(key => !equalExecutionValue(key, base[key], draft[key])).map(key => [key, draft[key]])));
}

/** Merge an editor's changed fields without replacing unrelated newer configuration. */
export function mergeExecutionChanges(base: AppConfig, draft: AppConfig, current: AppConfig): AppConfig {
  const patch = executionChanges(base, draft);
  const conflicts = (Object.keys(patch) as ExecutionKey[]).filter(key => !equalExecutionValue(key, current[key], base[key]) && !equalExecutionValue(key, current[key], draft[key]));
  if (conflicts.length) throw new ExecutionConflictError(conflicts);
  return { ...current, ...patch };
}

export class ExecutionConflictError extends Error {
  constructor(public readonly fields: ExecutionKey[]) { super(`Execution settings changed elsewhere: ${fields.join(', ')}`); }
}

/** Request defaults can change independently; all server-side defaults require a reload. */
export function serverSettingsChanged(base: AppConfig, draft: AppConfig): boolean {
  return EXECUTION_KEYS.some(key => {
    if ((REQUEST_KEYS as readonly string[]).includes(key)) return false;
    if (key === 'gpu') return !equal(comparableGpu(base.gpu), comparableGpu(draft.gpu));
    if (key === 'runtime_defaults') return !equal((base[key] ?? []).filter(name => !requestDefaultKeys.includes(name)).sort(), (draft[key] ?? []).filter(name => !requestDefaultKeys.includes(name)).sort());
    return !equal(base[key], draft[key]);
  });
}
