import { validateBenchmarkConfiguration, type RecordedSetting } from '@aiolm/benchmark-contracts';
import { providerOf } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import { runtimeHelpResolvePlan, type EffectiveSchema, type OptionSchemaDefinition, type OptionSchemaFact, type PlannedOccurrence } from '../../shared/api/runtimeHelp';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import type { SettingsProfile } from '../../shared/config/settingsProfiles';
import catalog from '../../shared/config/tuningDefaultsCatalog.json';
import { SERVER_OPTIONS } from '../../shared/config/serverOptions';
import { emptyGpuPlacement } from '../../shared/runtime/sessionUtils';
import { sha256HexText } from '../../shared/contracts/benchmark/publication';
import type { BenchmarkProfileSource } from '../../shared/contracts/benchmark/configuration';
import { parseSettingsText } from '../model-settings/settingsImport';
import { applyPlan } from '../runtimes/optionOrder';

export { validateBenchmarkProfileSource, publicBenchmarkProfileSource, localBenchmarkProfileSource, type BenchmarkProfileSource } from '../../shared/contracts/benchmark/configuration';

const supported = <T,>(fact: OptionSchemaFact<T> | undefined): T | null => fact && fact.certainty !== 'unknown' ? fact.value ?? null : null;

/** A recorded scalar cannot establish missing destination type or syntax facts. */
function occurrences(option: OptionSchemaDefinition, value: NonNullable<RecordedSetting['value']>): PlannedOccurrence[] | null {
  const kind = supported(option.kind);
  const arity = supported(option.arity);
  if (!kind || !arity) return null;
  const typed = (item: unknown) => kind === 'integer' ? typeof item === 'number' && Number.isSafeInteger(item)
    : kind === 'number' ? typeof item === 'number' && Number.isFinite(item)
      : kind === 'boolean' ? typeof item === 'boolean'
        : kind === 'text' ? typeof item === 'string' && !item.startsWith('-')
          : kind === 'json' ? Array.isArray(item) && item.every(part => typeof part === 'number' && Number.isFinite(part)) : false;
  let rows: unknown[][];
  if (kind === 'json') rows = [[value]];
  else if (Array.isArray(value)) {
    if (arity.min === 1 && arity.max === 1 && supported(option.repeatable) === true) rows = value.map(item => [item]);
    else rows = [[...value]];
  } else rows = [[value]];
  if (!rows.length) return null;
  const choices = supported(option.choices);
  const range = supported(option.range);
  for (const row of rows) {
    const count = kind === 'boolean' && arity.max === 0 ? 0 : row.length;
    if (count < arity.min || arity.max != null && count > arity.max) return null;
    for (const item of row) {
      if (!typed(item) || choices?.length && !choices.some(choice => JSON.stringify(choice) === JSON.stringify(item))) return null;
      if (typeof item === 'number' && range && (range.min != null && item < range.min || range.max != null && item > range.max)) return null;
    }
  }
  return rows.map(values => ({ key: option.key, values }));
}

/** Only the native destination's established controls may enter its dedicated
 * config converter. This never parses source argv or reads another profile. */
function nativeSetting(option: OptionSchemaDefinition, value: NonNullable<RecordedSetting['value']>): Partial<ExecutionSettings> | null {
  if (option.scope.length) return null;
  const flags = option.spellings.map(spelling => spelling.flag);
  if (flags.includes('--split-mode') && typeof value === 'string' && ['none', 'single', 'layer', 'row', 'tensor'].includes(value)) {
    return { gpu: { ...emptyGpuPlacement(), split_mode: value as NonNullable<ExecutionSettings['gpu']>['split_mode'] } };
  }
  if (flags.includes('--tensor-split') && Array.isArray(value) && value.every(part => part >= 0) && value.some(part => part > 0)) {
    return { gpu: { ...emptyGpuPlacement(), tensor_split: [...value] } };
  }
  if (Array.isArray(value) || typeof value === 'boolean' || typeof value === 'string' && /["\\\s]/.test(value)) return null;
  const field = catalog.find(entry => entry.args.some(flag => flags.includes(flag)));
  const serverOption = SERVER_OPTIONS.find(entry => entry.flags.some(flag => flags.includes(flag)));
  const flag = field?.args.find(alias => flags.includes(alias)) ?? serverOption?.flags.find(alias => flags.includes(alias));
  if (!flag) return null;
  const parsed = parseSettingsText(`${flag} ${String(value)}`, serverOption ? [serverOption] : [], { server_args: [], chat_options: {} });
  if (parsed.rejected.length || !parsed.applied.length || Object.keys(parsed.patch).some(key => ['active_model', 'chat_options', 'mmproj', 'spec_draft_model'].includes(key))) return null;
  // The dedicated converter must reproduce the value, never round or clamp it.
  if (field && (parsed.patch as Record<string, unknown>)[field.key] !== value) return null;
  return parsed.patch;
}

/** Restore only compatible launch settings into an explicitly chosen checked
 * destination. Source identity is descriptive and never selects a provider. */
export async function benchmarkSettingsProfile(source: BenchmarkProfileSource, id: string, destination: { cfg: AppConfig; effective: EffectiveSchema }): Promise<{ profile: SettingsProfile; omitted: boolean }> {
  if (!/^[A-Za-z0-9_-]{1,110}$/.test(id)) throw new Error('Invalid benchmark profile id.');
  const validated = validateBenchmarkConfiguration({ runtime: source.runtime, execution: source.execution });
  const { cfg, effective } = destination;
  if (effective.help_state === 'stale' || effective.help_state === 'unchecked') throw new Error('Check the destination runtime schema before importing.');
  const provider = providerOf(cfg);
  const native = provider === 'llama.cpp';
  let omitted = source.source_omissions;
  const candidates: Array<{ option: OptionSchemaDefinition; plan: PlannedOccurrence[]; patch?: Partial<ExecutionSettings> }> = [];
  for (const recorded of validated.execution.settings) {
    // Common method request entries explain the measurement, not a launch profile.
    if (recorded.target !== 'launch') continue;
    const matches = effective.schema.options.filter(option => option.target === recorded.target
      && option.scope.length === recorded.scope.length && option.scope.every((part, index) => part === recorded.scope[index])
      && effective.benchmark_names[option.key] === recorded.name);
    if (recorded.value === null || matches.length !== 1) { omitted = true; continue; }
    const option = matches[0];
    if (option.scope.length > effective.scope.length || option.scope.some((part, index) => part !== effective.scope[index]) || supported(option.benchmark_public) !== true
      || supported(option.sensitive) === true || supported(option.local_path) === true
      || supported(option.unit) !== recorded.unit || supported(option.benchmark_role) !== recorded.role
      || effective.conflicts?.some(conflict => conflict.key === option.key && conflict.blocking)) { omitted = true; continue; }
    const plan = occurrences(option, recorded.value);
    if (!plan) { omitted = true; continue; }
    const patch = native && (!option.managed || option.managed === 'discovery') ? nativeSetting(option, recorded.value) : undefined;
    if (option.managed && !patch) { omitted = true; continue; }
    candidates.push({ option, plan, ...(patch ? { patch } : {}) });
  }
  // Native dedicated tuning is app-owned, so validate that same typed value
  // without opening a generic provider_options override for its managed flag.
  const dedicated = new Set(candidates.filter(candidate => candidate.patch).map(candidate => candidate.option.key));
  const schema = dedicated.size ? { ...effective.schema, options: effective.schema.options.map(option => dedicated.has(option.key) ? { ...option, managed: null } : option) } : effective.schema;
  let accepted = candidates;
  while (accepted.length) {
    try {
      await runtimeHelpResolvePlan(schema, effective.scope, accepted.flatMap(candidate => candidate.plan));
      break;
    } catch (cause) {
      // Resolver issue arrays identify incompatible values. IPC/runtime errors
      // remain errors in the confirmation, with an explicit retry.
      if (!Array.isArray(cause)) throw cause;
      const invalid = new Set(cause.map(issue => issue && typeof issue === 'object' && 'key' in issue ? String(issue.key) : ''));
      const retained = accepted.filter(candidate => !invalid.has(candidate.option.key));
      accepted = retained.length === accepted.length || invalid.has('') ? [] : retained;
      omitted = true;
    }
  }
  const settings: Partial<ExecutionSettings> = {};
  const generic = accepted.filter(candidate => !candidate.patch).flatMap(candidate => candidate.plan);
  if (generic.length) settings.provider_options = { [provider]: applyPlan(effective.schema, {}, { plan: generic }) };
  for (const candidate of accepted) {
    if (!candidate.patch) continue;
    const { gpu, server_args, ...fields } = candidate.patch;
    Object.assign(settings, fields);
    if (gpu) settings.gpu = { ...(settings.gpu ?? emptyGpuPlacement()),
      ...(gpu.split_mode !== 'none' ? { split_mode: gpu.split_mode } : {}),
      ...(gpu.tensor_split.length ? { tensor_split: gpu.tensor_split } : {}) };
    if (server_args) settings.server_args = [...(settings.server_args ?? []), ...server_args];
  }
  const digest = await sha256HexText(JSON.stringify([id, provider]));
  return { profile: { id: `profile-benchmark-${digest}`, name: `Benchmark ${id.slice(0, 12)}`, provider, scope: 'global', revision: 1, settings, system_prompt: '' }, omitted };
}
