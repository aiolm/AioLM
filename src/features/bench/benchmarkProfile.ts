import { validatePublicBenchmark, type PublicBenchmarkSubmission } from '@aiolm/benchmark-contracts';
import type { AppConfig } from '../../shared/api/types';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { MODEL_PROFILE_KEYS, type SettingsProfile } from '../../shared/config/settingsProfiles';
import { RUNTIME_DEFAULT_KEYS } from '../../shared/config/tuningDefaults';
import catalog from '../../shared/config/tuningDefaultsCatalog.json';
import { tuningResetValues } from '../../shared/config/tuningResetValues';
import { CACHE_TYPE_OPTIONS, SPEC_TYPE_OPTIONS } from '../../shared/config/tuningValidation';
import { effectiveArguments } from '../../shared/contracts/benchmark/publicBenchmark';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

export type BenchmarkProfileSource = Pick<PublicBenchmarkSubmission, 'runtime' | 'execution'>;
const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid benchmark settings.');
  return value as Record<string, unknown>;
};

/** Validate the metadata projection without inventing measurements or trusting
 * arbitrary configuration fields from a public API response. */
export function validateBenchmarkProfileSource(value: unknown): BenchmarkProfileSource {
  const source = record(value);
  const validated = validatePublicBenchmark({
    schema_version: 1, submission_id: '00000000-0000-4000-8000-000000000001', app_version: null, method: null,
    workload: { corpus: 'code_python', corpus_version: null, corpus_sha256: null,
      prompt_lengths: [1], generation_length: 1, batch_sizes: [], repetitions: 1, warmup: false },
    model: { status: 'unidentified', sha256: null, size_bytes: null }, environment: null,
    runtime: source.runtime, execution: source.execution, measurements: { status: 'complete', rows: [] },
  });
  if (validated.execution.context_size <= 0 || validated.execution.parallel <= 0) {
    throw new Error('This benchmark did not record its execution settings.');
  }
  return { runtime: structuredClone(validated.runtime), execution: structuredClone(validated.execution) };
}

export function publicBenchmarkProfileSource(value: unknown, id: string): BenchmarkProfileSource {
  const detail = record(value);
  if (detail.id !== id) throw new Error('The public benchmark id does not match.');
  return validateBenchmarkProfileSource(detail.benchmark);
}

// TODO(runtime support): Persist the measured runtime name in local records
// when adding vLLM or MLX; only existing llama.cpp records may use this fallback.
export function localBenchmarkProfileSource(value: PerformanceBenchmarkRecord): BenchmarkProfileSource {
  return validateBenchmarkProfileSource({
    runtime: { name: 'llama.cpp', version: null, backend: value.backend || null, build: value.build || null },
    execution: { context_size: value.result.context_size, parallel: value.result.parallel,
      settings: value.result.provenance?.execution_config ?? null,
      effective_args: effectiveArguments(value.result.args) },
  });
}

const choices: Record<string, readonly string[]> = {
  cache_type_k: CACHE_TYPE_OPTIONS, cache_type_v: CACHE_TYPE_OPTIONS, flash_attn: ['auto', 'on', 'off'],
  spec_type: SPEC_TYPE_OPTIONS, reasoning: ['auto', 'on', 'off'], reasoning_format: ['auto', 'none', 'deepseek', 'deepseek-legacy'],
  reasoning_effort: ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'auto'], reasoning_preserve: ['auto', 'on', 'off'],
};
// Raw options are deliberately limited to portable tuning controls. An option
// from a newer server can name a file or remote endpoint even with a plain value.
const rawNumbers = new Set(['--threads-batch', '-tb', '--threads-draft', '-td', '--threads-batch-draft', '-tbd',
  '--poll', '--poll-batch', '--rope-freq-base', '--rope-freq-scale', '--yarn-orig-ctx', '--yarn-ext-factor',
  '--yarn-attn-factor', '--yarn-beta-fast', '--yarn-beta-slow']);
const rawSwitches = new Set(['--cont-batching', '--no-cont-batching', '-cb', '-nocb', '--webui', '--no-webui',
  '--mmap', '--no-mmap', '--mlock', '--no-mlock', '--cpu-moe', '--no-warmup', '--warmup', '--no-context-shift', '--context-shift']);
const isOption = (token: string | undefined) => token !== undefined && /^--?[a-zA-Z]/.test(token);
const emptyGpu = (): NonNullable<ExecutionSettings['gpu']> => ({ gpu_ids: [], main_gpu: null, split_mode: 'none', tensor_split: [], draft_gpu_id: null });

// TODO(runtime support): Dispatch by the validated source.runtime.name when
// adding vLLM or MLX. Each importer must create a profile for that same runtime,
// retain its engine identifier and validate its own settings/options/defaults.
// Keep the llama.cpp catalog and allowlists below specific to llama.cpp; do not
// translate another engine's settings into these fields. Profile application
// must require a matching runtime, with installation/version compatibility
// checked before execution. Unsupported settings must be reported explicitly.
export function benchmarkSettingsProfile(source: BenchmarkProfileSource, id: string): { profile: SettingsProfile; omitted: boolean } {
  if (!/^[A-Za-z0-9_-]{1,110}$/.test(id)) throw new Error('Invalid benchmark profile id.');
  const validated = validateBenchmarkProfileSource(source);
  const settings: Partial<ExecutionSettings> = { server_args: [] };
  const defaults = tuningResetValues();
  let omitted = false;
  const args = validated.execution.effective_args ?? [];
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    const equal = token.indexOf('=');
    const flag = equal >= 0 ? token.slice(0, equal) : token;
    const hasValue = equal >= 0 || (args[index + 1] !== undefined && !isOption(args[index + 1]));
    const value = equal >= 0 ? token.slice(equal + 1) : hasValue ? args[++index] : undefined;
    const field = catalog.find(entry => entry.args.includes(flag));
    if (field) {
      let parsed: string | number | undefined;
      if (field.key === 'reasoning_preserve' && value === undefined) parsed = flag === '--no-reasoning-preserve' ? 'off' : 'on';
      else if (typeof defaults[field.key as keyof AppConfig] === 'number') {
        if (value !== undefined && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value) && Number.isFinite(Number(value))) {
          parsed = Number(value);
          if (!['temperature', 'top_p', 'spec_draft_p_min', 'spec_draft_p_split'].includes(field.key) && !Number.isSafeInteger(parsed)) parsed = undefined;
        }
      } else if (value !== undefined && (!choices[field.key] || choices[field.key].includes(value))) parsed = value;
      if (parsed === undefined) omitted = true;
      else Object.assign(settings, { [field.key]: parsed });
    } else if (['--split-mode', '-sm'].includes(flag) && value && ['none', 'layer', 'row'].includes(value)) {
      settings.gpu = { ...(settings.gpu ?? emptyGpu()), split_mode: value as 'none' | 'layer' | 'row' };
    } else if (['--tensor-split', '-ts'].includes(flag) && value) {
      const split = value.split(',');
      if (split.length <= 64 && split.every(part => /^\d+(?:\.\d+)?$/.test(part) && Number.isFinite(Number(part)))) {
        settings.gpu = { ...(settings.gpu ?? emptyGpu()), tensor_split: split.map(Number) };
      } else omitted = true;
    } else if (rawNumbers.has(flag) && value !== undefined && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) && Number.isFinite(Number(value))) {
      settings.server_args!.push(flag, value);
    } else if (rawSwitches.has(flag) && value === undefined) settings.server_args!.push(flag);
    else if (flag === '--rope-scaling' && value && ['none', 'linear', 'yarn'].includes(value)) settings.server_args!.push(flag, value);
    else omitted = true;
  }
  const execution = validated.execution;
  // The measured allocation/slots and structured settings are authoritative.
  settings.ctx_size = execution.context_size;
  settings.parallel = execution.parallel;
  const captured = execution.settings;
  if (captured) {
    const pairs = { ngl: captured.gpu_layers, threads: captured.threads, flash_attn: captured.flash_attention,
      cache_type_k: captured.cache_type_k, cache_type_v: captured.cache_type_v };
    for (const [key, value] of Object.entries(pairs)) {
      if (value === null) continue;
      if (typeof value === 'string' && !choices[key]?.includes(value)) { omitted = true; continue; }
      Object.assign(settings, { [key]: value });
    }
    if (captured.threads_batch !== null) {
      settings.server_args = settings.server_args!.filter((arg, index, args) =>
        arg !== '--threads-batch' && arg !== '-tb' && args[index - 1] !== '--threads-batch' && args[index - 1] !== '-tb');
      settings.server_args!.push('--threads-batch', String(captured.threads_batch));
    }
    if (captured.split_mode && ['none', 'layer', 'row'].includes(captured.split_mode)) {
      settings.gpu = { ...emptyGpu(), split_mode: captured.split_mode as 'none' | 'layer' | 'row',
        tensor_split: captured.tensor_split ?? settings.gpu?.tensor_split ?? [] };
    } else if (captured.split_mode) omitted = true;
  }
  if (validated.runtime.backend && validated.runtime.build) {
    settings.active_backend = validated.runtime.backend;
    settings.active_build = validated.runtime.build;
  } else if (validated.runtime.backend || validated.runtime.build) omitted = true;
  settings.runtime_defaults = RUNTIME_DEFAULT_KEYS.filter(key => settings[key as keyof ExecutionSettings] === undefined);
  return { profile: { id: `profile-benchmark-${id}`, name: `Benchmark ${id.slice(0, 12)}`, scope: 'global',
    revision: 1, settings, system_prompt: '', legacy: true, coverage: [...MODEL_PROFILE_KEYS] }, omitted };
}
