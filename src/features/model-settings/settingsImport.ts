import type { AppConfig } from '../../shared/api/types';
import { ADVANCED_SAMPLING_FIELDS, MTP_FIELDS, REASONING_FIELDS, SAMPLING_FIELDS, SERVER_FIELDS, SERVER_TEXT_FIELDS } from '../tuning/tuningFields';
import { managedServerOption, replaceServerOption, type ServerOption } from '../../shared/config/serverOptions';
import { removeChatOverride, serverAliasesForRequest } from '../../shared/config/tuningDefaults';
import { REQUEST_KEYS } from '../../shared/config/executionSettings';
import { tuningResetValues } from '../../shared/config/tuningResetValues';

/**
 * Reading a llama-server command line back into settings.
 *
 * Model cards and forum posts hand out their configuration as a command, and
 * retyping twenty flags into twenty controls is where mistakes come from. Each
 * flag is matched against the controls this app manages; anything it knows but
 * does not manage becomes an extra server argument, and anything left over is
 * reported rather than dropped, because silently ignoring part of a pasted
 * command is how a model ends up running with settings nobody chose.
 */

export type RejectionReason = 'unknown' | 'value' | 'missing' | 'request';

export interface ImportedSetting {
  flag: string;
  label: string;
  value: string;
}

export interface RejectedSetting {
  flag: string;
  reason: RejectionReason;
  /** The value that could not be used, when there was one. */
  value?: string;
  /** What the control would have accepted, for a value that was out of range. */
  range?: { min: number; allowZero?: boolean; minExclusive?: boolean; max: number; excludedValues?: readonly number[] };
}

export interface ImportedSettings {
  patch: Partial<AppConfig>;
  applied: ImportedSetting[];
  rejected: RejectedSetting[];
}

type Target =
  | { kind: 'number'; key: string; label: string; min: number; allowZero?: boolean; minExclusive?: boolean; max: number; integer: boolean; excludedValues?: readonly number[] }
  | { kind: 'text'; key: string; label: string }
  | { kind: 'chat'; key: string; label: string; min: number; minExclusive?: boolean; max: number; integer?: boolean };

/**
 * Flags this app owns that no field catalog records a command-line name for:
 * the two controls that are not tuning fields, and the request cap whose flag
 * llama.cpp spells three ways.
 */
const EXTRA_TARGETS: Record<string, Target> = {
  '--flash-attn': { kind: 'text', key: 'flash_attn', label: 'Flash attention' },
  '-fa': { kind: 'text', key: 'flash_attn', label: 'Flash attention' },
  '--model': { kind: 'text', key: 'active_model', label: 'Model' },
  '-m': { kind: 'text', key: 'active_model', label: 'Model' },
  '--min-p': { kind: 'chat', key: 'min_p', label: 'Min-p', min: 0, max: 1 },
  '--predict': { kind: 'chat', key: 'max_tokens', label: 'Max tokens', min: -1, max: 1_048_576, integer: true },
  '--n-predict': { kind: 'chat', key: 'max_tokens', label: 'Max tokens', min: -1, max: 1_048_576, integer: true },
  '-n': { kind: 'chat', key: 'max_tokens', label: 'Max tokens', min: -1, max: 1_048_576, integer: true },
};

function buildTargets(): Map<string, Target> {
  const targets = new Map<string, Target>();
  // A field's own aliases are request keys as often as flags, so the
  // command-line names come from the defaults catalogue alongside them.
  const add = (key: string, aliases: readonly string[] | undefined, target: Target) => {
    for (const alias of [...(aliases ?? []), ...serverAliasesForRequest(key)]) {
      if (alias.startsWith('-')) targets.set(alias, target);
    }
  };
  for (const field of [...SERVER_FIELDS, ...MTP_FIELDS, ...REASONING_FIELDS, ...SAMPLING_FIELDS]) {
    add(field.key, field.aliases, { kind: 'number', key: field.key, label: field.label, min: field.min, allowZero: field.allowZero, max: field.max, integer: field.step >= 1, excludedValues: field.excludedValues });
  }
  for (const field of SERVER_TEXT_FIELDS) add(field.key, field.aliases, { kind: 'text', key: field.key, label: field.label });
  for (const field of ADVANCED_SAMPLING_FIELDS) {
    add(field.key, field.aliases, { kind: 'chat', key: field.key, label: field.label, min: field.min, minExclusive: field.minExclusive, max: field.max, integer: field.step >= 1 });
  }
  for (const [flag, target] of Object.entries(EXTRA_TARGETS)) targets.set(flag, target);
  return targets;
}

const TARGETS = buildTargets();
const NEGATIVE_NUMERIC_TOKEN = /^-(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:e[+-]?\d+)?$/i;

function isFlagToken(token: string): boolean {
  // Preserve the original dash boundary for every nonnumeric token; only
  // decimal negative values can be consumed as arguments.
  return token.startsWith('-') && !NEGATIVE_NUMERIC_TOKEN.test(token);
}

/**
 * Split a pasted command into tokens.
 *
 * Handles the line continuations the command was copied with — PowerShell's
 * backtick, the shell's backslash, cmd's caret — and quoted values, which is how
 * a model path with spaces survives the trip.
 */
export function tokenizeCommand(text: string): string[] {
  const joined = text.replace(/[`\\^]\s*\r?\n/g, ' ').replace(/\r?\n/g, ' ');
  const tokens: string[] = [];
  let token = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const character of joined) {
    if (quote) {
      if (character === quote) quote = null;
      else token += character;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; started = true; continue; }
    if (/\s/.test(character)) {
      if (started) { tokens.push(token); token = ''; started = false; }
      continue;
    }
    token += character;
    started = true;
  }
  if (started) tokens.push(token);
  return tokens;
}

function numeric(raw: string, target: { min: number; allowZero?: boolean; minExclusive?: boolean; max: number; integer?: boolean; excludedValues?: readonly number[] }): number | null {
  const value = raw.trim() ? Number(raw) : NaN;
  if (!Number.isFinite(value) || (!(target.allowZero && value === 0) && (target.minExclusive ? value <= target.min : value < target.min)) || value > target.max || target.excludedValues?.includes(value)) return null;
  return target.integer && !Number.isInteger(value) ? null : value;
}

export function parseSettingsText(text: string, options: readonly ServerOption[], base: Pick<AppConfig, 'server_args' | 'chat_options'> & Partial<Pick<AppConfig, 'batch_size' | 'ubatch_size' | 'runtime_defaults'>>, preserveRequest = false): ImportedSettings {
  const tokens = tokenizeCommand(text);
  const patch: Partial<AppConfig> = {};
  const chat: Record<string, number> = {};
  const applied: ImportedSetting[] = [];
  const rejected: RejectedSetting[] = [];
  let serverArgs = base.server_args;
  const byFlag = new Map<string, ServerOption>();
  for (const option of options) {
    byFlag.set(option.id, option);
    for (const alias of option.flags) byFlag.set(alias, option);
  }

  for (let at = 0; at < tokens.length; at += 1) {
    const flag = tokens[at];
    // A bare value with no flag in front of it: the executable name, or a
    // positional argument this app has nowhere to put.
    if (!flag.startsWith('-')) continue;
    const next = tokens[at + 1];
    const value = next !== undefined && !isFlagToken(next) ? next : undefined;

    const target = TARGETS.get(flag);
    if (target) {
      if (value === undefined) { rejected.push({ flag, reason: 'missing' }); continue; }
      at += 1;
      if (preserveRequest && (target.kind === 'chat' || (REQUEST_KEYS as readonly string[]).includes(target.key))) {
        rejected.push({ flag, reason: 'request' });
        continue;
      }
      if (target.kind === 'text') {
        (patch as Record<string, unknown>)[target.key] = value;
      } else {
        const parsed = numeric(value, target);
        if (parsed === null) {
          const range = Number.isFinite(Number(value)) ? { min: target.min, max: target.max, ...('allowZero' in target && target.allowZero ? { allowZero: true } : {}), ...(target.minExclusive ? { minExclusive: true } : {}), ...('excludedValues' in target && target.excludedValues ? { excludedValues: target.excludedValues } : {}) } : undefined;
          rejected.push({ flag, reason: 'value', value, ...(range ? { range } : {}) });
          continue;
        }
        if (target.kind === 'chat') chat[target.key] = parsed;
        else (patch as Record<string, unknown>)[target.key] = parsed;
      }
      applied.push({ flag, label: target.label, value });
      continue;
    }

    const option = byFlag.get(flag);
    if (!option || managedServerOption(option)) { rejected.push({ flag, reason: 'unknown' }); continue; }
    const values: string[] = [];
    for (let taken = 0; taken < option.arity; taken += 1) {
      const argument = tokens[at + 1];
      if (argument === undefined || isFlagToken(argument)) break;
      values.push(argument);
      at += 1;
    }
    if (values.length !== option.arity) { rejected.push({ flag, reason: 'missing' }); continue; }
    serverArgs = replaceServerOption(serverArgs, option, [{ flag: option.id, values }]);
    applied.push({ flag, label: option.id, value: values.join(' ') });
  }

  // Validate the final explicit pair, independent of argument order. Omitted
  // microbatches belong to the runtime, not to the raw inherited placeholder.
  const batch = patch.batch_size ?? (base.runtime_defaults?.includes('batch_size')
    ? tuningResetValues(options).batch_size : base.batch_size);
  const rejectBatchSetting = (key: 'batch_size' | 'ubatch_size', range: NonNullable<RejectedSetting['range']>) => {
    for (let index = applied.length - 1; index >= 0; index -= 1) {
      const entry = applied[index];
      if (TARGETS.get(entry.flag)?.key !== key) continue;
      rejected.push({ flag: entry.flag, value: entry.value, reason: 'value', range });
      applied.splice(index, 1);
    }
    delete patch[key];
  };
  if (batch !== undefined && patch.ubatch_size !== undefined && patch.ubatch_size > batch) {
    rejectBatchSetting('ubatch_size', { min: 1, max: batch });
  }
  const microbatch = patch.ubatch_size ?? (base.runtime_defaults?.includes('ubatch_size') ? undefined : base.ubatch_size);
  if (patch.batch_size !== undefined && microbatch !== undefined && patch.batch_size < microbatch) {
    rejectBatchSetting('batch_size', { min: microbatch, max: 131072 });
  }

  if (Object.keys(chat).length > 0) {
    const options = Object.keys(chat).reduce((current, key) => removeChatOverride(current, key), base.chat_options);
    patch.chat_options = { ...options, ...chat };
  }
  if (serverArgs !== base.server_args) patch.server_args = serverArgs;
  return { patch, applied, rejected };
}
