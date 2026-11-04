import { staticCandidates, type CommandEntry, type ImportedPlan, type OptionSchema, type OptionSchemaDefinition, type OptionSchemaFact } from '../../shared/api/runtimeHelp';
import { readStored } from './optionOrder';

export function supported<T>(fact: OptionSchemaFact<T> | undefined): T | undefined {
  return fact && fact.certainty !== 'unknown' ? (fact.value ?? undefined) : undefined;
}

export function kindOf(option: OptionSchemaDefinition): string | undefined {
  return supported(option.kind);
}

export function display(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Compare JSON display values independently of native key/number formatting. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
}

export function maskPreview(argv: string[], schema: OptionSchema, values: Record<string, unknown>, entrySecrets: Iterable<string> = []): string[] {
  const secrets = new Set<string>();
  const numbers = new Set<number>();
  const json = new Set<string>();
  for (const option of schema.options) {
    if (supported(option.sensitive) !== true) continue;
    const kind = kindOf(option);
    for (const row of readStored(values[option.key])?.rows ?? []) {
      for (const cell of row) {
        const text = display(cell);
        if (text) secrets.add(text);
        if (kind === 'number' && typeof cell === 'number' && Number.isFinite(cell)) numbers.add(cell);
        if (kind === 'json') {
          const canonical = canonicalJson(cell);
          if (canonical !== undefined) json.add(canonical);
        }
      }
    }
  }
  // Literal entry prefix tokens a known-sensitive positional slot holds via
  // an explicit static role. The launch itself keeps the real bytes; only
  // this display projection masks them.
  for (const secret of entrySecrets) {
    if (secret) secrets.add(secret);
  }
  const isSecret = (text: string) => {
    if (secrets.has(text)) return true;
    if (!numbers.size && !json.size) return false;
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'number' && numbers.has(parsed)) return true;
      const canonical = json.size ? canonicalJson(parsed) : undefined;
      return canonical !== undefined && json.has(canonical);
    } catch { return false; }
  };
  return argv.map(token => {
    if (isSecret(token)) return '•••';
    const equals = token.indexOf('=');
    return equals > 0 && isSecret(token.slice(equals + 1)) ? `${token.slice(0, equals + 1)}•••` : token;
  });
}

/** Mask review projections only. The pasted command, plan and stored values
 * keep their exact bytes. A sensitive flag with uncertain arity hides every
 * following review word instead of guessing where its value ends. Known
 * sensitive entry tokens pass through the same projection masking. With a
 * sensitive positional, neither review bucket has reliable ownership unless
 * the actual request entry proves it is a fixed literal. Unsaved draft roles
 * identify display secrets but never establish import ownership. */
export function maskImportReview(imported: ImportedPlan, schema: OptionSchema, values: Record<string, unknown>, entrySecrets: Iterable<string> = [], entry?: CommandEntry | null): Pick<ImportedPlan, 'managed' | 'unrecognized'> {
  const reviewValues: Record<string, unknown> = { ...values };
  const reviewSecrets = [...entrySecrets];
  const staticIndices = new Set(entry ? staticCandidates(entry) : []);
  let sensitivePositional = false;
  for (const option of schema.options) {
    if (supported(option.sensitive) !== true) continue;
    if (option.position !== null && option.position !== undefined) {
      const role = entry?.positional_roles?.[option.key];
      const literal = role?.role === 'static' && staticIndices.has(role.index) ? entry?.prefix[role.index] : undefined;
      if (option.target === 'launch' && typeof literal === 'string') reviewSecrets.push(literal);
      else sensitivePositional = true;
    }
    const rows = [...(readStored(values[option.key])?.rows ?? []), ...imported.plan.filter(item => item.key === option.key).map(item => [...item.values])];
    for (const words of [imported.managed, imported.unrecognized]) {
      for (let index = 0; index < words.length; index += 1) {
        const token = words[index];
        const equals = token.indexOf('=');
        const name = equals < 0 ? token : token.slice(0, equals);
        if (!option.spellings.some(spelling => spelling.flag === name)) continue;
        if (equals >= 0) rows.push([token.slice(equals + 1)]);
        else {
          const arity = supported(option.arity);
          const count = arity && arity.max === arity.min ? arity.min : words.length - index - 1;
          rows.push(words.slice(index + 1, index + 1 + count));
        }
      }
    }
    reviewValues[option.key] = { occurrences: rows };
  }
  return {
    managed: sensitivePositional ? imported.managed.map(() => '•••') : maskPreview(imported.managed, schema, reviewValues, reviewSecrets),
    unrecognized: sensitivePositional ? imported.unrecognized.map(() => '•••') : maskPreview(imported.unrecognized, schema, reviewValues, reviewSecrets),
  };
}
