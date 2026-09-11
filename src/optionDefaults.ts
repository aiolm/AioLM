import type { ServerOption } from './serverOptions';
import tuningCatalog from './tuningDefaultsCatalog.json';

/** Preserve the runtime's qualification (model/automatic/sentinel values), not just a number. */
export function helpDefault(description: string): string | null {
  const text = description.replace(/\(env:[^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const match = /\bdefault:\s*/i.exec(text);
  if (match) {
    const start = match.index + match[0].length;
    let depth = 0;
    let quote = '';
    let end = start;
    for (; end < text.length; end++) {
      const char = text[end];
      if (quote) { if (char === quote && text[end - 1] !== '\\') quote = ''; continue; }
      // Apostrophes in words such as "model's" are not string delimiters.
      if ((char === '"' || char === "'" || char === '`') && (end === start || /[\s(=,]/.test(text[end - 1]))) { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')') { if (!depth) break; depth--; }
    }
    const value = text.slice(start, end).trim();
    return value || '""';
  }
  const choice = description.match(/(?:^|\n)\s*-\s+([\w+-]+)\s+\(default\)/i);
  if (choice) return choice[1];
  const prose = text.match(/\bdefaults? to (.+?)(?:\.(?:\s|$)|$)/i);
  if (prose) return prose[1];
  if (/use model default if unspecified/i.test(text)) return 'model';
  return null;
}

const UPSTREAM = 'https://github.com/ggml-org/llama.cpp/blob/fa6769818708afd9807b22183ccda112fd563427/';
export const REQUEST_DEFAULTS: Readonly<Record<string, { value: string; source: string }>> = {
  n_probs: { value: '0', source: `${UPSTREAM}common/common.h#L228` },
  min_keep: { value: '0', source: `${UPSTREAM}common/common.h#L229` },
  t_max_predict_ms: { value: '-1', source: `${UPSTREAM}tools/server/server-task.h#L68` },
  id_slot: { value: '-1', source: `${UPSTREAM}tools/server/server-task.h#L144` },
};

export const INFORMATION_OPTIONS = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices']);
export interface OptionDefault { value: string | null; source: 'app' | 'help' | 'reference' | 'unknown' | 'command'; reference?: string }

// Values omitted from --help, verified in common_params/common_params_model.
// Keep them explicitly marked as source reference values, never as runtime-probed values.
const PARAMETER_DEFAULTS: Readonly<Record<string, string>> = {
  '--device': '[] (auto)', '--tensor-split': '0,0,…', '--numa': 'disabled',
  '--model': '""', '--mmproj': '""', '--lora': '[]', '--lora-scaled': '[]',
};

export function serverDefault(option: ServerOption, options: readonly ServerOption[]): OptionDefault {
  const appDefault = tuningCatalog.find(field => field.appDefault && field.args.some(flag => option.flags.includes(flag)));
  if (appDefault) return { value: String(appDefault.resetValue), source: 'app' };
  if (INFORMATION_OPTIONS.has(option.id)) return { value: null, source: 'command' };
  const value = helpDefault(option.description);
  if (value !== null) return { value, source: 'help' };
  // Deprecated switches have no independent default in load-mode based runtimes.
  if (['--mmap', '--mlock', '--direct-io'].includes(option.id) && /load-mode/.test(option.description)) {
    const loading = options.find(item => item.flags.includes('--load-mode'));
    const loadingDefault = loading && helpDefault(loading.description);
    if (loadingDefault) return { value: `--load-mode: ${loadingDefault}`, source: 'help' };
  }
  if (option.flags.includes('--n-cpu-moe')) {
    // No CPU tensor placement override is added until this option is supplied.
    return { value: '0', source: 'reference', reference: `${UPSTREAM}common/arg.cpp` };
  }
  const parameterDefault = option.flags.map(flag => PARAMETER_DEFAULTS[flag]).find(value => value !== undefined);
  if (parameterDefault !== undefined) return { value: parameterDefault, source: 'reference', reference: `${UPSTREAM}common/common.h` };
  return { value: null, source: 'unknown' };
}
