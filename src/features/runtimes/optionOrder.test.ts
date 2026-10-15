import { describe, expect, it } from 'vitest';
import type { OptionSchema, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { applyPlan, editOption, expandPlan, moveOccurrence, ORDER_KEY, readOrder, setOccurrenceSpelling } from './optionOrder';

const unknown = { value: null, certainty: 'unknown' as const };
const known = <T,>(value: T) => ({ value, certainty: 'verified' as const, source: { kind: 'adapter', id: 't', revision: 'r' } });

const option = (key: string, extra: Partial<OptionSchemaDefinition> = {}): OptionSchemaDefinition => ({
  key, scope: [], spellings: [{ flag: `--${key}` }], position: null, kind: unknown, arity: known({ min: 1, max: 1 }),
  repeatable: known(true), choices: unknown, range: unknown, unit: unknown, runtime_default: unknown, group: 'runtime', help: '',
  target: 'launch', request_field: unknown, restart_required: unknown, sensitive: unknown, local_path: unknown, managed: null, raw_spans: [],
  ...extra,
});

const schema: OptionSchema = {
  schema_version: 1,
  binding: { engine: 'custom.example', runtime: 'build-a', fingerprint: 'a'.repeat(64) },
  options: [
    option('alpha', { spellings: [{ flag: '--alpha' }, { flag: '-a' }] }),
    option('beta'),
    option('cache', { kind: known('boolean'), arity: known({ min: 0, max: 0 }), spellings: [{ flag: '--cache', polarity: true }, { flag: '--no-cache', polarity: false }] }),
    option('port', { managed: 'port' }),
  ],
  constraints: [], raw_help: [], end_of_options: unknown,
};

/** What a profile save and reload does to the saved map. */
const reload = (values: Record<string, unknown>) => JSON.parse(JSON.stringify(values)) as Record<string, unknown>;
const keys = (values: Record<string, unknown>) => {
  const state = readOrder(values);
  if (!state.ok) throw new Error(state.error);
  return expandPlan(schema, values, state.order).map(item => `${item.spelling ?? item.key}=${item.values.join(',')}`);
};

describe('saved command-line order', () => {
  it('keeps A1 B2 A3 and a different alias per occurrence through import, save and reload', () => {
    const values = applyPlan(schema, { untouched: 'kept' }, { plan: [
      { key: 'alpha', spelling: '--alpha', values: ['1'] },
      { key: 'beta', spelling: '--beta', values: ['2'] },
      { key: 'alpha', spelling: '-a', values: ['3'] },
    ] });
    // Grouped values stay the value authority, readable by older code.
    expect(values.alpha).toEqual({ spelling: null, occurrences: [['1'], ['3']] });
    expect(values.beta).toBe('2');
    expect(values.untouched).toBe('kept');
    expect(values[ORDER_KEY]).toEqual({ version: 1, occurrences: [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha', spelling: '-a' }] });
    expect(keys(reload(values))).toEqual(['alpha=1', 'beta=2', '-a=3']);
  });

  it('adds no record when grouped values already launch in the given order', () => {
    const values = applyPlan(schema, {}, { plan: [
      { key: 'alpha', spelling: '--alpha', values: ['1'] },
      { key: 'beta', spelling: '--beta', values: ['2'] },
      // A negative switch is the equivalent default spelling for false.
      { key: 'cache', spelling: '--no-cache', values: [false] },
    ] });
    expect(values).toEqual({ alpha: '1', beta: '2', cache: false });
  });

  it('follows edits, additions, removals, reordering and alias changes', () => {
    let values = applyPlan(schema, {}, { plan: [
      { key: 'alpha', spelling: null, values: ['1'] },
      { key: 'beta', spelling: null, values: ['2'] },
      { key: 'alpha', spelling: null, values: ['3'] },
    ] });
    // Editing a value keeps its position.
    values = editOption(schema, values, 'alpha', { spelling: null, occurrences: [['1'], ['three']] });
    expect(keys(values)).toEqual(['alpha=1', 'beta=2', 'alpha=three']);
    // A new occurrence follows the option's last one.
    values = editOption(schema, values, 'beta', { spelling: null, occurrences: [['2'], ['4']] });
    expect(keys(values)).toEqual(['alpha=1', 'beta=2', 'beta=4', 'alpha=three']);
    // Removing the first alpha keeps the remaining occurrence in place.
    values = editOption(schema, values, 'alpha', 'three', [1]);
    expect(keys(values)).toEqual(['beta=2', 'beta=4', 'alpha=three']);
    // Moving it back to schema order makes the record redundant.
    values = moveOccurrence(schema, values, 2, -1);
    values = moveOccurrence(schema, values, 1, -1);
    expect(keys(values)).toEqual(['alpha=three', 'beta=2', 'beta=4']);
    expect(values[ORDER_KEY]).toBeUndefined();
    // One occurrence's own alias needs a record; the shared alias does not.
    values = setOccurrenceSpelling(schema, values, 'alpha', 0, '-a');
    expect(values.alpha).toEqual({ spelling: '-a', occurrences: [['three']] });
    expect(values[ORDER_KEY]).toBeUndefined();
    values = editOption(schema, values, 'alpha', { spelling: '-a', occurrences: [['three'], ['five']] });
    values = setOccurrenceSpelling(schema, values, 'alpha', 1, '--alpha');
    expect(keys(values)).toEqual(['-a=three', 'alpha=five', 'beta=2', 'beta=4']);
    expect(values[ORDER_KEY]).toEqual({ version: 1, occurrences: [{ key: 'alpha', spelling: '-a' }, { key: 'alpha' }, { key: 'beta' }, { key: 'beta' }] });
    // Clearing an option drops its positions.
    values = editOption(schema, values, 'alpha', undefined);
    expect(values).toEqual({ beta: { spelling: null, occurrences: [['2'], ['4']] } });
  });

  it('refuses newer, malformed and divergent records instead of rewriting them', () => {
    const base = { alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2' };
    const entries = [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha' }];
    for (const [record, reason] of [
      [{ version: 2, occurrences: entries }, 'version 2'],
      [{ version: 1, occurrences: entries, later: true }, 'malformed'],
      [{ version: 1, occurrences: [{ key: 'alpha' }, { key: 'beta' }] }, 'alpha'],
      [{ version: 1, occurrences: [{ key: 'alpha', spelling: '-a' }, { key: 'beta' }, { key: 'alpha' }] }, 'alpha'],
    ] as const) {
      const values = { ...base, [ORDER_KEY]: record };
      expect(readOrder(values)).toEqual({ ok: false, error: reason });
      // Edits keep the refused record for review; imports are refused.
      expect(editOption(schema, values, 'beta', '5')[ORDER_KEY]).toEqual(record);
      expect(moveOccurrence(schema, values, 0, 1)).toBe(values);
      expect(() => applyPlan(schema, values, { plan: [] })).toThrow('review');
    }
  });

  it('applies the backend bounds and keeps a refused record untouched until it is discarded', () => {
    const base = { alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2' };
    const entries = [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha' }];
    const korean = (bytes: number) => '한'.repeat(Math.floor(bytes / 3)) + 'x'.repeat(bytes % 3);
    const cases: Array<[unknown, string]> = [
      [{ version: 1, occurrences: Array.from({ length: 513 }, () => ({ key: 'beta' })) }, 'too many occurrences'],
      [{ version: 1, occurrences: [{ key: 'x'.repeat(70_000) }] }, 'too large'],
      [{ version: '1', occurrences: entries }, 'no valid version'],
      [{ version: 1.5, occurrences: entries }, 'no valid version'],
      [{ occurrences: entries }, 'no valid version'],
      [[], 'no valid version'],
      [{ version: 1, occurrences: [{ key: 'bad key' }] }, 'invalid entry'],
      [{ version: 1, occurrences: [{ key: 'é' }] }, 'invalid entry'],
      [{ version: 1, occurrences: [{ key: 'a'.repeat(129) }] }, 'invalid entry'],
      [{ version: 1, occurrences: [{ key: 'alpha', spelling: '' }] }, 'invalid entry'],
      [{ version: 1, occurrences: [{ key: 'alpha', spelling: '-a\u0000' }] }, 'invalid entry'],
      // 43 three-byte characters are 129 UTF-8 bytes but only 43 UTF-16 units.
      [{ version: 1, occurrences: [{ key: 'alpha', spelling: korean(129) }] }, 'invalid entry'],
      [{ version: 1, occurrences: [{ key: 'alpha', spelling: 7 }] }, 'malformed'],
    ];
    for (const [record, reason] of cases) {
      const values = { ...base, [ORDER_KEY]: record };
      expect(readOrder(values)).toEqual({ ok: false, error: reason });
      // Nothing rewrites a refused record: edits keep it as saved, plan
      // operations leave the values alone and imports are refused.
      expect(editOption(schema, values, 'beta', '5')[ORDER_KEY]).toBe(record);
      expect(editOption(schema, values, 'alpha', undefined)[ORDER_KEY]).toBe(record);
      expect(moveOccurrence(schema, values, 0, 1)).toBe(values);
      expect(setOccurrenceSpelling(schema, values, 'alpha', 0, '-a')).toBe(values);
      expect(() => applyPlan(schema, values, { plan: [] })).toThrow('review');
    }
  });

  it('measures the record size in UTF-8 bytes exactly like the backend', () => {
    // The compact serialization of this record is 59 bytes plus the spelling;
    // runtime_ordered's test pins the same overhead and boundary.
    const at = (bytes: number) => ({ alpha: 'x', [ORDER_KEY]: { version: 1, occurrences: [{ key: 'alpha', spelling: '한'.repeat(Math.floor((bytes - 59) / 3)) + 'x'.repeat((bytes - 59) % 3) }] } });
    expect(new TextEncoder().encode(JSON.stringify(at(65_536)[ORDER_KEY])).length).toBe(65_536);
    // Within the size bound the next refusal is the over-long spelling.
    expect(readOrder(at(65_536))).toEqual({ ok: false, error: 'invalid entry' });
    expect(readOrder(at(65_537))).toEqual({ ok: false, error: 'too large' });
    expect(JSON.stringify(at(65_537)[ORDER_KEY]).length).toBeLessThan(65_536);
  });

  it('accepts null, absent and multibyte spellings within bounds and reads values as the backend does', () => {
    const spelling = '한'.repeat(42) + 'xy';
    const alias = { spelling, occurrences: [['1']] };
    expect(readOrder({ alpha: alias, [ORDER_KEY]: { version: 1, occurrences: [{ key: 'alpha', spelling }] } })).toEqual({ ok: true, order: [{ key: 'alpha', spelling }] });
    for (const entry of [{ key: 'beta', spelling: null }, { key: 'beta' }]) {
      expect(readOrder({ beta: '2', [ORDER_KEY]: { version: 1, occurrences: [entry] } })).toEqual({ ok: true, order: [{ key: 'beta', spelling: null }] });
    }
    // An object the backend cannot read as occurrences is one scalar value.
    const odd = { occurrences: [['1'], ['2']], extra: true };
    expect(readOrder({ alpha: odd, [ORDER_KEY]: { version: 1, occurrences: [{ key: 'alpha' }, { key: 'alpha' }] } })).toEqual({ ok: false, error: 'alpha' });
    expect(readOrder({ alpha: odd, [ORDER_KEY]: { version: 1, occurrences: [{ key: 'alpha' }] } }).ok).toBe(true);
  });

  it('removes the positions of a retained value the schema no longer describes', () => {
    const values = { gone: 'x', beta: '2', [ORDER_KEY]: { version: 1, occurrences: [{ key: 'gone' }, { key: 'beta' }] } };
    expect(editOption(schema, values, 'gone', undefined)).toEqual({ beta: '2', [ORDER_KEY]: { version: 1, occurrences: [{ key: 'beta' }] } });
  });
});
