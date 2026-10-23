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

describe('imported integer values at the JavaScript boundary', () => {
  const typedSchema: OptionSchema = { ...schema, options: [
    option('count', { kind: known('integer') }),
    option('ratio', { kind: known('number') }),
    option('label', { kind: known('text') }),
  ] };
  const transported = (decimal: string) => JSON.parse(
    `{"plan":[{"key":"count","spelling":"--count","values":[${decimal}]}]}`,
  ) as { plan: Array<{ key: string; spelling?: string; values: unknown[] }> };

  it.each(['9007199254740992', '9007199254740993', '-9007199254740993', '9223372036854775807', '-9223372036854775808'])(
    'refuses unsafe native integer %s atomically without replacing saved values or order', decimal => {
      const saved = {
        count: { spelling: null, occurrences: [[7], [8]] }, label: 'kept',
        retained_unknown: { nested: ['original'] },
        [ORDER_KEY]: { version: 1, occurrences: [{ key: 'count' }, { key: 'label' }, { key: 'count' }] },
      };
      const imported = transported(decimal);
      imported.plan.unshift({ key: 'label', spelling: '--label', values: ['new'] });
      const before = structuredClone({ saved, imported });
      expect(() => applyPlan(typedSchema, saved, imported)).toThrow('Review the original pasted command before applying.');
      expect({ saved, imported }).toEqual(before);
    },
  );

  it('keeps safe Integer endpoints exact and preserves Number and literal Text policy', () => {
    for (const [decimal, expected] of [['9007199254740991', 9007199254740991], ['-9007199254740991', -9007199254740991], ['0', 0]] as const) {
      expect(applyPlan(typedSchema, { retained_unknown: 'kept' }, transported(decimal)))
        .toEqual({ retained_unknown: 'kept', count: expected });
    }
    expect(applyPlan(typedSchema, {}, { plan: [
      { key: 'ratio', values: [1e20] }, { key: 'label', values: ['9007199254740993'] },
    ] })).toEqual({ ratio: 1e20, label: '9007199254740993' });
    // An import with unknown arity can retain tentative literal values for
    // native review; the GUI must not guess a different representation.
    expect(applyPlan(typedSchema, {}, { plan: [{ key: 'count', values: ['9007199254740993'] }] }))
      .toEqual({ count: '9007199254740993' });
  });
});

describe('expanded saved occurrences', () => {
  it('keeps complete mixed plans, aliases and moved output while preserving saved input', () => {
    const values = {
      alpha: { spelling: '-a', occurrences: [['A1'], [], ['A3']] },
      beta: 'B', cache: false, port: 999, untouched: { nested: ['kept'] },
      gone: { spelling: null, occurrences: [[null], [{ literal: true }]] },
      [ORDER_KEY]: { version: 1, occurrences: [
        { key: 'alpha', spelling: '-a' }, { key: 'gone' }, { key: 'beta' },
        { key: 'alpha', spelling: '--alpha' }, { key: 'gone', spelling: '--gone' }, { key: 'alpha' },
      ] },
    };
    const before = structuredClone(values);
    const state = readOrder(values);
    expect(state).toEqual({ ok: true, order: [
      { key: 'alpha', spelling: '-a' }, { key: 'gone', spelling: null }, { key: 'beta', spelling: null },
      { key: 'alpha', spelling: '--alpha' }, { key: 'gone', spelling: '--gone' }, { key: 'alpha', spelling: null },
    ] });
    if (!state.ok) throw new Error(state.error);
    const plan = expandPlan(schema, values, state.order);
    expect(plan).toEqual([
      { key: 'cache', spelling: null, values: [false] },
      { key: 'alpha', spelling: '-a', values: ['A1'] },
      { key: 'gone', spelling: null, values: [null] },
      { key: 'beta', spelling: null, values: ['B'] },
      { key: 'alpha', spelling: '--alpha', values: [] },
      { key: 'gone', spelling: '--gone', values: [{ literal: true }] },
      { key: 'alpha', spelling: null, values: ['A3'] },
    ]);
    // This is the form's rowSpellings projection, including every empty row.
    expect(plan.filter(item => item.key === 'alpha').map(item => item.spelling ?? null))
      .toEqual(['-a', '--alpha', null]);
    expect(new Set(plan.map(item => item.values)).size).toBe(plan.length);
    expect(moveOccurrence(schema, values, 1, 1)).toEqual({
      alpha: { spelling: '-a', occurrences: [['A1'], [], ['A3']] },
      beta: 'B', cache: false, port: 999, untouched: { nested: ['kept'] },
      gone: { spelling: null, occurrences: [[null], [{ literal: true }]] },
      [ORDER_KEY]: { version: 1, occurrences: [
        { key: 'cache' }, { key: 'gone' }, { key: 'alpha', spelling: '-a' }, { key: 'beta' },
        { key: 'alpha' }, { key: 'gone', spelling: '--gone' }, { key: 'alpha' },
      ] },
    });
    expect(values).toEqual(before);
  });

  it('keeps schema order and permissive saved shapes for null, empty and direct recorded orders', () => {
    const current: OptionSchema = { ...schema, options: [
      option('absent'), option('alpha'), option('beta'), option('cache'),
      option('position', { position: 0 }), option('request', { target: 'request' }), option('port', { managed: 'port' }),
    ] };
    const scalarArray = ['scalar-array'];
    const scalarObject = { occurrences: 'not-an-array', spelling: '--ignored', extra: true };
    const values = {
      alpha: { occurrences: ['legacy-row', [], ['last']], spelling: 7, extra: true },
      beta: scalarArray, cache: null, position: 'slot', request: 'body', port: 42,
      empty: { occurrences: [] }, ghost: scalarObject,
    };
    const before = structuredClone(values);
    const expected = [
      { key: 'alpha', spelling: null, values: ['legacy-row'] },
      { key: 'alpha', spelling: null, values: [] },
      { key: 'alpha', spelling: null, values: ['last'] },
      { key: 'beta', spelling: null, values: [scalarArray] },
      { key: 'cache', spelling: null, values: [null] },
    ];
    expect(expandPlan(current, values, null)).toEqual(expected);
    expect(expandPlan(current, values, [])).toEqual(expected);
    // expandPlan is also exported directly: do not silently validate or drop
    // unknown keys, legacy rows, missing rows or extra recorded occurrences.
    const plan = expandPlan(current, values, [
      { key: 'alpha', spelling: null }, { key: 'beta', spelling: '--b' },
      { key: 'alpha', spelling: '-legacy' }, { key: 'ghost', spelling: null },
      { key: 'alpha', spelling: null }, { key: 'alpha', spelling: null },
      { key: 'empty', spelling: null }, { key: 'missing', spelling: null },
      { key: 'missing', spelling: null }, { key: 'ghost', spelling: '--ghost' },
    ]);
    expect(plan).toEqual([
      { key: 'cache', spelling: null, values: [null] },
      { key: 'alpha', spelling: null, values: ['legacy-row'] },
      { key: 'beta', spelling: '--b', values: [scalarArray] },
      { key: 'alpha', spelling: '-legacy', values: [] },
      { key: 'ghost', spelling: null, values: [scalarObject] },
      { key: 'alpha', spelling: null, values: ['last'] },
      { key: 'alpha', spelling: null, values: [] },
      { key: 'empty', spelling: null, values: [] },
      { key: 'missing', spelling: null, values: [] },
      { key: 'missing', spelling: null, values: [] },
      { key: 'ghost', spelling: '--ghost', values: [] },
    ]);
    expect(plan[2].values[0]).toBe(scalarArray);
    expect(plan[4].values[0]).toBe(scalarObject);
    expect(new Set(plan.map(item => item.values)).size).toBe(plan.length);
    expect(values).toEqual(before);
  });

  it('isolates equal and aliased source rows and reads changed saved content on the next invocation', () => {
    const shared = ['same'];
    const stored = { spelling: null, occurrences: [shared, shared, [] as unknown[]] };
    const values = { alpha: stored, [ORDER_KEY]: { version: 1, occurrences: [
      { key: 'alpha' }, { key: 'alpha', spelling: '-a' }, { key: 'alpha' },
    ] } };
    const before = structuredClone(values);
    const state = readOrder(values);
    if (!state.ok) throw new Error(state.error);
    const first = expandPlan(schema, values, state.order);
    expect(first).toEqual([
      { key: 'alpha', spelling: null, values: ['same'] },
      { key: 'alpha', spelling: '-a', values: ['same'] },
      { key: 'alpha', spelling: null, values: [] },
    ]);
    expect(new Set(first.map(item => item.values)).size).toBe(3);
    first[0].values[0] = 'output-only';
    first[2].values.push('output-only');
    expect(first[1].values).toEqual(['same']);
    expect(values).toEqual(before);
    shared[0] = 'changed';
    stored.occurrences[2].push('new-input');
    const changed = structuredClone(values);
    const second = expandPlan(schema, values, state.order);
    expect(second).toEqual([
      { key: 'alpha', spelling: null, values: ['changed'] },
      { key: 'alpha', spelling: '-a', values: ['changed'] },
      { key: 'alpha', spelling: null, values: ['new-input'] },
    ]);
    expect(second.every((item, index) => item.values !== first[index].values)).toBe(true);
    expect(new Set(second.map(item => item.values)).size).toBe(3);
    expect(first.map(item => item.values)).toEqual([['output-only'], ['same'], ['output-only']]);
    expect(values).toEqual(changed);
  });
});

describe('imported values without an orderable position', () => {
  it('keeps full mixed launch, request, positional and unknown output with independent shallow rows', () => {
    const current: OptionSchema = { ...schema, options: [
      ...schema.options,
      option('request', { target: 'request', spellings: [{ flag: '--request' }, { flag: '-r' }] }),
      option('position', { position: 0, spellings: [] }), option('noFlag', { spellings: [] }),
    ] };
    const cell = { nested: ['shared-cell'] };
    const shared = [cell];
    const saved = { alpha: 'old-A', beta: 'B', request: 'old-R', position: 'old-slot', port: 99, untouched: { nested: ['kept'] } };
    const imported: Parameters<typeof applyPlan>[2] = { plan: [
      { key: 'request', spelling: '-r', values: ['R1'] },
      { key: 'alpha', spelling: '-a', values: ['A1'] },
      { key: 'position', spelling: null, values: [] },
      { key: 'unknown', spelling: '--first', values: shared },
      { key: 'request', spelling: '--request', values: ['R2'] },
      { key: 'alpha', spelling: '--alpha', values: ['A2'] },
      { key: 'unknown', spelling: '--last', values: shared },
      { key: 'port', spelling: '--port', values: [0] },
      { key: 'noFlag', values: ['literal'] },
      // The helper already accepts an iterable non-array row; do not add validation here.
      { key: 'legacy', spelling: null, values: 'ab' as unknown as unknown[] },
    ] };
    const before = structuredClone({ saved, imported });
    const result = applyPlan(current, saved, imported);
    expect(result).toEqual({
      alpha: { spelling: '-a', occurrences: [['A1'], ['A2']] }, beta: 'B',
      request: { spelling: null, occurrences: [['R1'], ['R2']] },
      position: { spelling: null, occurrences: [[]] }, port: 0, untouched: { nested: ['kept'] },
      unknown: { spelling: '--last', occurrences: [[cell], [cell]] }, noFlag: 'literal',
      legacy: { spelling: null, occurrences: [['a', 'b']] },
      [ORDER_KEY]: { version: 1, occurrences: [{ key: 'beta' }, { key: 'alpha', spelling: '-a' }, { key: 'alpha' }] },
    });
    const request = (result.request as { occurrences: unknown[][] }).occurrences;
    const position = (result.position as { occurrences: unknown[][] }).occurrences;
    const unknownRows = (result.unknown as { occurrences: unknown[][] }).occurrences;
    expect(new Set([...request, ...position, ...unknownRows]).size).toBe(5);
    expect(unknownRows[0]).not.toBe(shared);
    expect(unknownRows[1]).not.toBe(shared);
    expect(unknownRows[0][0]).toBe(cell);
    expect(unknownRows[1][0]).toBe(cell);
    request[0][0] = 'output-only';
    unknownRows[0].push('output-only');
    expect(request[1]).toEqual(['R2']);
    expect(unknownRows[1]).toEqual([cell]);
    expect({ saved, imported }).toEqual(before);
  });

  it('uses the last item spelling normalized against its own polarity and refreshes rows on another call', () => {
    const current: OptionSchema = { ...schema, options: [option('feature', {
      target: 'request', kind: known('boolean'), arity: known({ min: 0, max: 0 }),
      spellings: [{ flag: '--feature', polarity: true }, { flag: '--no-feature', polarity: false }, { flag: '--disable-feature', polarity: false }],
    })] };
    const saved = { untouched: 'kept' };
    const imported: Parameters<typeof applyPlan>[2] = { plan: [
      { key: 'feature', spelling: '--feature', values: [true] },
      { key: 'feature', spelling: '--disable-feature', values: [false] },
    ] };
    const before = structuredClone({ saved, imported });
    const first = applyPlan(current, saved, imported);
    expect(first).toEqual({ untouched: 'kept', feature: { spelling: '--disable-feature', occurrences: [[true], [false]] } });
    expect({ saved, imported }).toEqual(before);
    imported.plan[0].values[0] = false;
    imported.plan[1].values[0] = true;
    imported.plan[1].spelling = '--feature';
    const changed = structuredClone({ saved, imported });
    const second = applyPlan(current, saved, imported);
    expect(second).toEqual({ untouched: 'kept', feature: { spelling: null, occurrences: [[false], [true]] } });
    const firstRows = (first.feature as { occurrences: unknown[][] }).occurrences;
    const secondRows = (second.feature as { occurrences: unknown[][] }).occurrences;
    expect(secondRows.every((row, index) => row !== firstRows[index])).toBe(true);
    secondRows[0].push('output-only');
    expect(secondRows[1]).toEqual([true]);
    expect(first).toEqual({ untouched: 'kept', feature: { spelling: '--disable-feature', occurrences: [[true], [false]] } });
    expect({ saved, imported }).toEqual(changed);
  });

  it('keeps empty and all-orderable plans plus single scalar and empty request rows', () => {
    const current: OptionSchema = { ...schema, options: [...schema.options, option('request', { target: 'request' })] };
    const saved = { alpha: 'old-A', request: 'old-R', untouched: 'kept' };
    const before = structuredClone(saved);
    expect(applyPlan(current, saved, { plan: [] })).toEqual(saved);
    expect(applyPlan(current, saved, { plan: [
      { key: 'alpha', spelling: '--alpha', values: ['new-A'] }, { key: 'beta', spelling: '--beta', values: ['new-B'] },
    ] })).toEqual({ alpha: 'new-A', beta: 'new-B', request: 'old-R', untouched: 'kept' });
    expect(applyPlan(current, saved, { plan: [{ key: 'request', spelling: '--request', values: [null] }] }))
      .toEqual({ alpha: 'old-A', request: null, untouched: 'kept' });
    expect(applyPlan(current, saved, { plan: [{ key: 'request', values: [] }] }))
      .toEqual({ alpha: 'old-A', request: { spelling: null, occurrences: [[]] }, untouched: 'kept' });
    expect(saved).toEqual(before);
  });

  it('keeps refusal, unsafe integer, row-copy and per-item normalization error priority atomic', () => {
    const malformedSwitch = option('switch', {
      target: 'request', kind: known('boolean'), arity: known({ min: 0, max: 0 }),
      spellings: null as unknown as OptionSchemaDefinition['spellings'],
    });
    const current: OptionSchema = { ...schema, options: [malformedSwitch, option('count', { target: 'request', kind: known('integer') })] };
    const saved = { untouched: { nested: ['kept'] } };
    const imported: Parameters<typeof applyPlan>[2] = { plan: [
      { key: 'switch', spelling: '--switch', values: [true] },
      { key: 'other', values: null as unknown as unknown[] },
      { key: 'switch', spelling: '--switch', values: [false] },
    ] };
    const before = structuredClone({ saved, imported });
    // First switch rows copy successfully, then its normalization fails before
    // the later key's malformed row is copied. Eager copying changes this error.
    expect(() => applyPlan(current, saved, imported)).toThrow(/find/);
    expect({ saved, imported }).toEqual(before);
    imported.plan[2].values = null as unknown as unknown[];
    const malformedRows = structuredClone({ saved, imported });
    // All rows of the first key are copied before that first item normalizes.
    expect(() => applyPlan(current, saved, imported)).toThrow(/iterable/);
    expect({ saved, imported }).toEqual(malformedRows);
    imported.plan.push({ key: 'count', values: [9007199254740992] });
    const unsafe = structuredClone({ saved, imported });
    expect(() => applyPlan(current, saved, imported)).toThrow('Review the original pasted command before applying.');
    expect({ saved, imported }).toEqual(unsafe);
    const refused = { ...saved, [ORDER_KEY]: { version: 2, occurrences: [] } };
    const refusedBefore = structuredClone({ refused, imported });
    expect(() => applyPlan(current, refused, imported)).toThrow('saved option order needs review before importing');
    expect({ refused, imported }).toEqual(refusedBefore);
  });
});
