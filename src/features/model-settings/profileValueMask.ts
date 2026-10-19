import type { EffectiveSchema } from '../../shared/api/runtimeHelp';
import { readStored } from '../runtimes/optionOrder';
import { sensitiveEntryTokenStrings } from '../runtimes/sensitiveEntryTokens';

/** Text summaries may embed a secret inside a larger rendered value. Mask
 * display copies across both sides of a change without altering storage. */
export function profileValueMask(view: EffectiveSchema | undefined, ...maps: Array<Record<string, unknown>>) {
  const secrets = new Set<string>(view ? sensitiveEntryTokenStrings(view) : []);
  const collect = (value: unknown) => {
    if (typeof value === 'string' && value) secrets.add(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    else if (value !== null && value !== undefined) secrets.add(String(value));
  };
  for (const option of view?.schema.options ?? []) {
    if (option.sensitive.certainty === 'unknown' || option.sensitive.value !== true) continue;
    for (const map of maps) for (const row of readStored(map[option.key])?.rows ?? []) row.forEach(collect);
    collect(option.runtime_default.value?.literal);
  }
  const ordered = [...secrets].filter(Boolean).sort((left, right) => right.length - left.length);
  return (text: string) => ordered.reduce((masked, secret) => masked.split(secret).join('•••'), text);
}
