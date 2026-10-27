import type { EffectiveSchema } from '../../shared/api/runtimeHelp';

/** Prefix indices whose literal token a known-sensitive positional slot holds
 *  through an explicit static role in the saved supplement. Current and stale
 *  supplements both count: a stale role never configures launch, but it still
 *  identifies a token already known to be sensitive (the same display-only
 *  rule PositionalLayout applies). Only documented/verified/user-confirmed
 *  sensitivity counts; unknown certainty never masks. The entry program is
 *  not a prefix index and is never included here. */
export function sensitiveStaticIndices(effective: EffectiveSchema): Set<number> {
  const indices = new Set<number>();
  const supplement = effective.supplement;
  if (!supplement) return indices;
  for (const option of effective.schema.options) {
    if (option.position === null || option.position === undefined) continue;
    if (option.target !== 'launch') continue;
    if (!effective.help_keys.includes(option.key)) continue;
    if (option.sensitive.certainty === 'unknown' || option.sensitive.value !== true) continue;
    const role = supplement.options[option.key]?.positional;
    if (role?.role === 'static' && Number.isInteger(role.index) && role.index >= 0) {
      indices.add(role.index);
    }
  }
  return indices;
}

/** Literal entry prefix strings at those indices. Stored values, plans and
 *  launch argv keep their exact bytes; only display/review projections mask
 *  these strings. Out-of-range indices (a changed prefix) contribute nothing. */
export function sensitiveEntryTokenStrings(effective: EffectiveSchema): string[] {
  const prefix = effective.entry?.prefix ?? [];
  const tokens: string[] = [];
  for (const index of sensitiveStaticIndices(effective)) {
    const token = prefix[index];
    if (typeof token === 'string' && token) tokens.push(token);
  }
  return tokens;
}
