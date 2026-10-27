import type { ProviderOption } from '../shared/api/providers';
import type { EffectiveSchema, OptionSchemaDefinition } from '../shared/api/runtimeHelp';

const unknown = { value: null, certainty: 'unknown' as const };
const documented = <T,>(value: T) => ({ value, certainty: 'documented' as const, source: { kind: 'adapter', id: 'synthetic.catalog', revision: '1' } });

/** Mirrors the backend catalog mapping (runtime_schema::from_spec) so UI
 * tests can describe a runtime by its legacy catalog options. */
export function schemaOption(option: ProviderOption): OptionSchemaDefinition {
  const kind = option.kind.type;
  const flag = option.flag ? [{ flag: option.flag }] : [];
  const base: OptionSchemaDefinition = {
    key: option.key, scope: [], spellings: option.target === 'launch' ? flag : [], position: null,
    kind: documented(kind === 'flag' || kind === 'toggle' ? 'boolean' : kind === 'integer' || kind === 'number' || kind === 'json' ? kind : 'text'),
    arity: documented(kind === 'flag' || kind === 'toggle' ? { min: 0, max: 0 } : { min: 1, max: 1 }),
    repeatable: unknown, choices: kind === 'choice' ? documented(option.kind.choices ?? []) : unknown,
    range: (kind === 'integer' || kind === 'number') && option.kind.min !== undefined ? documented({ min: option.kind.min, max: option.kind.max ?? null }) : unknown,
    unit: unknown,
    runtime_default: kind === 'flag' ? documented({ literal: false }) : option.runtime_default ? documented({ literal: option.runtime_default }) : unknown,
    group: option.group, help: '', target: option.target,
    request_field: option.target === 'request' ? documented(option.key) : unknown,
    restart_required: unknown, sensitive: unknown, local_path: kind === 'path' ? documented(true) : unknown,
    managed: null, raw_spans: [],
  };
  if (kind === 'toggle' && option.flag) {
    base.spellings = [{ flag: option.flag, polarity: true }, { flag: `--no-${option.flag.slice(2)}`, polarity: false }];
  }
  return base;
}

export function effectiveSchema(options: ProviderOption[], extra: OptionSchemaDefinition[] = [], overrides: Partial<EffectiveSchema> = {}): EffectiveSchema {
  return {
    schema: {
      schema_version: 1,
      binding: { engine: 'synthetic', runtime: 'synthetic', fingerprint: 'a'.repeat(64) },
      options: [...options.map(schemaOption), ...extra],
      constraints: [], raw_help: [], end_of_options: unknown,
    },
    scope: [],
    help_state: extra.length ? 'current' : 'none',
    help_detail: '',
    accepted_fingerprint: extra.length ? 'a'.repeat(64) : null,
    compat_keys: options.map(option => option.key),
    help_keys: extra.map(option => option.key),
    shadowed: [],
    ...overrides,
  };
}
