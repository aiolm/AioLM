import type { RuntimeDescriptor } from '../../shared/api/runtimeHelp';

/** Counts a discovery and names the options whose type or value count the
 * help did not establish (they stay text or block launch until metadata). */
export function helpSummary(descriptor: RuntimeDescriptor) {
  const options = descriptor.schema.options.filter(option => !option.managed);
  return {
    total: descriptor.schema.options.length,
    uncertain: options
      .filter(option => option.target === 'launch' && (option.arity.certainty === 'unknown' || (option.kind.certainty === 'unknown' && option.arity.value?.max !== 0)))
      .map(option => option.spellings[0]?.flag ?? option.key),
  };
}
