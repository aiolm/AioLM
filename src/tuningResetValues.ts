import type { AppConfig } from './api';
import catalog from './tuningDefaultsCatalog.json';
import { helpDefault } from './optionDefaults';
import { SERVER_OPTIONS, type ServerOption } from './serverOptions';

/** Fresh values for controls; never read the previous manual configuration. */
const FALLBACKS = {
  ngl: catalog.find(field => field.key === 'ngl')!.resetValue!,
  ctx_size: catalog.find(field => field.key === 'ctx_size')!.resetValue!,
  batch_size: 2048, ubatch_size: 512, keep: 0, cache_type_k: 'f16', cache_type_v: 'f16',
  flash_attn: 'auto', n_cpu_moe: 0, threads: 0, parallel: 0,
  request_timeout_seconds: 3600, sleep_idle_seconds: -1,
  spec_type: 'none', spec_draft_n_max: 3, spec_draft_n_min: 0,
  spec_draft_p_min: 0, spec_draft_p_split: 0.1, spec_draft_ngl: 'auto',
  reasoning: 'auto', reasoning_format: 'auto', reasoning_effort: 'default',
  reasoning_budget: -1, reasoning_budget_message: '', reasoning_preserve: 'auto',
  temperature: 0.8, top_p: 0.95, top_k: 40,
} satisfies Partial<AppConfig>;

export function defaultScalar(value: string | null): string | number | undefined {
  if (value === null) return undefined;
  const text = value.trim();
  const number = text.match(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?(?=$|[,;\s])/i);
  if (number) return Number.isFinite(Number(number[0])) ? Number(number[0]) : undefined;
  if (text.startsWith('"')) {
    const quoted = text.match(/^"(?:[^"\\]|\\.)*"/);
    if (quoted) { try { return JSON.parse(quoted[0]) as string; } catch { return undefined; } }
  }
  const quoted = text.match(/^'([^']*)'/);
  if (quoted) return quoted[1];
  if (/^[\w.+-]+$/.test(text)) return text;
  return undefined;
}

export function tuningResetValues(options: readonly ServerOption[] = SERVER_OPTIONS): Partial<AppConfig> {
  return Object.fromEntries(catalog.map(field => {
    const fallback = FALLBACKS[field.key as keyof typeof FALLBACKS];
    if (field.appDefault) return [field.key, field.resetValue];
    const matches = (option: ServerOption) => option.flags.some(flag => field.args.includes(flag));
    const option = options.find(matches) ?? SERVER_OPTIONS.find(matches);
    const scalar = option ? defaultScalar(helpDefault(option.description)) : undefined;
    let value = typeof scalar === typeof fallback ? scalar : fallback;
    if ((field.key === 'spec_draft_ngl' || field.key === 'reasoning_budget_message') && typeof scalar === 'number') value = String(scalar);
    // The app represents automatic CPU/slot counts as zero (the flags are omitted).
    if ((field.key === 'threads' || field.key === 'parallel') && typeof value === 'number' && value < 0) value = 0;
    if (field.key === 'reasoning_budget_message' && value === 'none') value = '';
    if (field.key === 'reasoning_preserve') value = value === 'enabled' || value === 'true' ? 'on' : value === 'disabled' || value === 'false' ? 'off' : value;
    return [field.key, value];
  })) as Partial<AppConfig>;
}
