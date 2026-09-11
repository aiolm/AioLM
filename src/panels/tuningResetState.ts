import type { AppConfig } from '../api';
import type { ServerOption } from '../serverOptions';
import { defaultScalar, tuningResetValues } from '../tuningResetValues';
import { hasChatOverride, usesRuntimeDefault } from '../tuningDefaults';
import { ADVANCED_SAMPLING_FIELDS } from './tuningFields';
import { tuningOptionMetadata } from './tuningOptionInfo';

/** Render inherited controls from defaults, including configs saved by older app versions. */
export function tuningDisplayConfig(cfg: AppConfig, options: readonly ServerOption[]): AppConfig {
  const defaults = tuningResetValues(options);
  const values = Object.fromEntries(Object.entries(defaults).filter(([key]) => usesRuntimeDefault(cfg, key)));
  const chat_options = { ...cfg.chat_options };
  for (const field of ADVANCED_SAMPLING_FIELDS) {
    if (hasChatOverride(cfg, field.key)) continue;
    const scalar = defaultScalar(tuningOptionMetadata(field.key, options, true).defaults.value);
    chat_options[field.key] = typeof scalar === 'number' ? scalar : field.defaultValue;
  }
  if (!hasChatOverride(cfg, 'samplers')) {
    const chain = tuningOptionMetadata('samplers', options, true).defaults.value;
    if (chain) chat_options.samplers = chain.split(';').map(value => value.trim()).filter(Boolean);
  }
  return { ...cfg, ...values, chat_options };
}
