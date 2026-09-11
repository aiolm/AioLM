import { SERVER_OPTIONS, type ServerOption } from '../../shared/config/serverOptions';
import { REQUEST_DEFAULTS, serverDefault, type OptionDefault } from '../../shared/config/optionDefaults';
import { serverAliasesForRequest } from '../../shared/config/tuningDefaults';
import { TUNING_FIELD_CATALOG } from './tuningFields';
import { defaultScalar } from '../../shared/config/tuningResetValues';

export function tuningOptionMetadata(key: string, options: readonly ServerOption[], verified: boolean) {
  const rawServer = key.startsWith('raw-server:');
  const rawRequest = key.startsWith('raw-chat:');
  const name = key.replace(/^raw-(?:server|chat):/, '');
  const field = TUNING_FIELD_CATALOG.find(item => item.key === name || item.requestKey === name);
  const requestKey = !rawServer && (rawRequest || field?.category === 'sampling' || name === 'samplers' || name === 'reasoning_effort')
    ? field?.requestKey ?? name : undefined;
  const aliases = rawServer ? [name] : [...serverAliasesForRequest(field?.key ?? name), ...(field?.aliases ?? []).filter(alias => alias.startsWith('-'))];
  const current = options.find(option => option.flags.some(flag => aliases.includes(flag)));
  const reference = SERVER_OPTIONS.find(option => option.flags.some(flag => aliases.includes(flag)));
  const option = current ?? reference;
  const requestDefault = requestKey && REQUEST_DEFAULTS[requestKey];
  let defaults: OptionDefault = option ? serverDefault(option, current ? options : SERVER_OPTIONS)
    : requestDefault ? { value: requestDefault.value, reference: requestDefault.source, source: 'reference' }
    : { value: null, source: 'unknown' };
  // Dedicated unsigned controls use zero for automatic CPU/slot counts.
  if (!rawServer && (name === 'threads' || name === 'parallel') && defaultScalar(defaults.value) === -1) {
    defaults = { value: '0', source: 'app' };
  }
  return {
    // Only show a CLI mapping that is documented; request-only fields must not invent flags.
    signature: option?.signature ?? (rawServer ? name : undefined), requestKey,
    defaults, verified: verified && !!current, missing: verified && !current && !!reference,
  };
}
