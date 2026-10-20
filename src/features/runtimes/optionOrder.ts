import type { OptionSchema, OptionSchemaDefinition, PlannedOccurrence } from '../../shared/api/runtimeHelp';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';

/** Saved key of the command-line order record (see `runtime_ordered.rs`).
 * Grouped values stay the authority for values; the record decides the
 * order of occurrences and each occurrence's alias. */
export const ORDER_KEY = '@option_order';
const ORDER_VERSION = 1;

/** Saved occurrences of one option and the alias they were spelled with. */
export interface StoredOption {
  rows: unknown[][];
  spelling: string | null;
}

/** Reads the saved map shape shared with the backend (scalar or occurrences). */
export function readStored(stored: unknown): StoredOption | undefined {
  if (stored === undefined) return undefined;
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    const candidate = stored as { occurrences?: unknown; spelling?: unknown };
    if (Array.isArray(candidate.occurrences)) {
      return {
        rows: candidate.occurrences.map(row => (Array.isArray(row) ? [...row] : [row])),
        spelling: typeof candidate.spelling === 'string' ? candidate.spelling : null,
      };
    }
  }
  return { rows: [[stored]], spelling: null };
}

/** One occurrence with one value and the default spelling stays a plain
 * scalar so older readers keep working; anything else keeps every row. */
export function writeStored(rows: unknown[][], spelling: string | null): unknown {
  if (rows.length === 0) return undefined;
  if (!spelling && rows.length === 1 && rows[0].length === 1) return rows[0][0];
  return { spelling, occurrences: rows };
}

export interface OrderEntry { key: string; spelling: string | null }
export type SavedOrderState = { ok: true; order: OrderEntry[] | null } | { ok: false; error: string };

// Bounds shared with `runtime_ordered::saved_order`.
const MAX_ORDER_BYTES = 65_536;
const MAX_ORDER_OCCURRENCES = 512;
const MAX_NAME_BYTES = 128;
const encoder = new TextEncoder();
const utf8Bytes = (text: string) => encoder.encode(text).length;

/** A key the backend accepts: ASCII letters, digits and `._-/`, at most 128 bytes. */
function validOrderKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_NAME_BYTES && /^[A-Za-z0-9._/-]+$/.test(key);
}

/** Saved occurrences as the backend reads them (`overrides_from_map`): an
 * object with `occurrences` that is a valid override, or one scalar value. */
function savedRows(value: unknown): { count: number; spelling: string | null } {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'occurrences' in value) {
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).every(key => key === 'occurrences' || key === 'spelling')
      && Array.isArray(candidate.occurrences) && candidate.occurrences.every(row => Array.isArray(row))
      && (candidate.spelling === undefined || candidate.spelling === null || typeof candidate.spelling === 'string')) {
      return { count: candidate.occurrences.length, spelling: typeof candidate.spelling === 'string' ? candidate.spelling : null };
    }
  }
  return { count: 1, spelling: null };
}

/** The saved order record checked against the values it orders, with the
 * backend's refusals and bounds: a newer, malformed, oversized or divergent
 * record is refused (and then kept untouched until explicitly discarded).
 * Size and count are bounded before any per-entry work. */
export function readOrder(values: Record<string, unknown>): SavedOrderState {
  const raw = values[ORDER_KEY];
  if (raw === undefined) return { ok: true, order: null };
  let serialized: string | undefined;
  try { serialized = JSON.stringify(raw); } catch { return { ok: false, error: 'malformed' }; }
  if (serialized === undefined) return { ok: false, error: 'malformed' };
  if (utf8Bytes(serialized) > MAX_ORDER_BYTES) return { ok: false, error: 'too large' };
  const version = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).version : undefined;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 0) return { ok: false, error: 'no valid version' };
  if (version !== ORDER_VERSION) return { ok: false, error: `version ${version}` };
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'version' && key !== 'occurrences') || !Array.isArray(record.occurrences)) return { ok: false, error: 'malformed' };
  const items = record.occurrences as unknown[];
  if (items.length > MAX_ORDER_OCCURRENCES) return { ok: false, error: 'too many occurrences' };
  const order: OrderEntry[] = [];
  for (const item of items) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return { ok: false, error: 'malformed' };
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some(key => key !== 'key' && key !== 'spelling') || typeof entry.key !== 'string'
      || !(entry.spelling === undefined || entry.spelling === null || typeof entry.spelling === 'string')) {
      return { ok: false, error: 'malformed' };
    }
    const spelling = typeof entry.spelling === 'string' ? entry.spelling : null;
    if (!validOrderKey(entry.key) || (spelling !== null && (spelling === '' || utf8Bytes(spelling) > MAX_NAME_BYTES || spelling.includes('\u0000')))) {
      return { ok: false, error: 'invalid entry' };
    }
    order.push({ key: entry.key, spelling });
  }
  const counts = new Map<string, { count: number; first: string | null }>();
  for (const entry of order) {
    const seen = counts.get(entry.key);
    if (seen) seen.count += 1; else counts.set(entry.key, { count: 1, first: entry.spelling });
  }
  for (const [key, listed] of counts) {
    if (!Object.prototype.hasOwnProperty.call(values, key) || key === ORDER_KEY) return { ok: false, error: key };
    const saved = savedRows(values[key]);
    if (saved.count !== listed.count || saved.spelling !== listed.first) return { ok: false, error: key };
  }
  return { ok: true, order };
}

/** Options whose occurrences have a command-line position users can order:
 * launch flags the app does not own. Positional slots keep slot order. */
export function orderable(option: OptionSchemaDefinition | undefined): boolean {
  return !!option && option.target === 'launch' && !option.managed && (option.position === null || option.position === undefined) && option.spellings.length > 0;
}

function supportedValue<T>(fact: { certainty: string; value?: T | null } | undefined): T | undefined {
  return fact && fact.certainty !== 'unknown' ? (fact.value ?? undefined) : undefined;
}

/** The spelling the resolver chooses when none is saved: a switch's first
 * spelling of matching polarity, otherwise the first spelling. */
function defaultSpelling(option: OptionSchemaDefinition, row: unknown[]): string | null {
  const isSwitch = supportedValue(option.kind) === 'boolean' && supportedValue(option.arity)?.max === 0;
  if (isSwitch && typeof row[0] === 'boolean') {
    return option.spellings.find(spelling => (spelling.polarity ?? true) === row[0])?.flag ?? null;
  }
  return option.spellings[0]?.flag ?? null;
}

/** Equivalent spellings are saved as null so grouped values stay plain. */
export function normalizeSpelling(option: OptionSchemaDefinition | undefined, spelling: string | null | undefined, row: unknown[]): string | null {
  if (!spelling || !option) return spelling ?? null;
  return spelling === defaultSpelling(option, row) ? null : spelling;
}

/** Every orderable saved occurrence as one plan, exactly as launch orders
 * it: values without a recorded position first in schema order, then the
 * recorded occurrences with their own alias. */
export function expandPlan(schema: OptionSchema, values: Record<string, unknown>, order: OrderEntry[] | null): PlannedOccurrence[] {
  const recorded = new Set(order?.map(entry => entry.key) ?? []);
  const plan: PlannedOccurrence[] = [];
  for (const option of schema.options) {
    if (!orderable(option) || recorded.has(option.key)) continue;
    const stored = readStored(values[option.key]);
    for (const row of stored?.rows ?? []) plan.push({ key: option.key, spelling: stored?.spelling ?? null, values: row });
  }
  const seen = new Map<string, number>();
  for (const entry of order ?? []) {
    const index = seen.get(entry.key) ?? 0;
    seen.set(entry.key, index + 1);
    plan.push({ key: entry.key, spelling: entry.spelling, values: readStored(values[entry.key])?.rows[index] ?? [] });
  }
  return plan;
}

function same(left: PlannedOccurrence[], right: PlannedOccurrence[]): boolean {
  return JSON.stringify(left.map(item => [item.key, item.spelling ?? null, item.values]))
    === JSON.stringify(right.map(item => [item.key, item.spelling ?? null, item.values]));
}

/** Save a plan of orderable occurrences: grouped values in plan order with
 * the first occurrence's alias, plus an order record only when grouped
 * values alone would launch differently. Other saved values are untouched. */
export function writePlan(schema: OptionSchema, values: Record<string, unknown>, plan: PlannedOccurrence[]): Record<string, unknown> {
  const options = new Map(schema.options.map(option => [option.key, option]));
  const normalized = plan.map(item => ({ key: item.key, spelling: normalizeSpelling(options.get(item.key), item.spelling, item.values), values: item.values }));
  const next = { ...values };
  delete next[ORDER_KEY];
  for (const option of schema.options) if (orderable(option)) delete next[option.key];
  const grouped = new Map<string, StoredOption>();
  for (const item of normalized) {
    const entry = grouped.get(item.key) ?? { rows: [], spelling: item.spelling };
    entry.rows.push([...item.values]);
    grouped.set(item.key, entry);
  }
  for (const [key, entry] of grouped) next[key] = writeStored(entry.rows, entry.spelling);
  if (!same(normalized, expandPlan(schema, next, null))) {
    next[ORDER_KEY] = { version: ORDER_VERSION, occurrences: normalized.map(item => (item.spelling ? { key: item.key, spelling: item.spelling } : { key: item.key })) };
  }
  return next;
}

/** Apply a field edit of one option to the saved plan. `origins[i]` names
 * the previous occurrence a new row came from (null: a new row, added
 * after the option's last occurrence); an occurrence missing from it was
 * removed. A changed shared alias applies to every occurrence. */
export function editOption(schema: OptionSchema, values: Record<string, unknown>, key: string, next: unknown, origins?: Array<number | null>): Record<string, unknown> {
  const state = readOrder(values);
  const option = schema.options.find(item => item.key === key);
  if (!state.ok || !state.order || !orderable(option)) {
    // Without a valid record grouped values are the whole story; a refused
    // record is kept as it is for review instead of being rewritten.
    const copy = { ...values };
    if (next === undefined) delete copy[key]; else copy[key] = next;
    // Removing a value the schema no longer describes also removes its
    // recorded positions, so the remaining record stays consistent.
    if (next === undefined && state.ok && state.order?.some(entry => entry.key === key)) {
      const rest = state.order.filter(entry => entry.key !== key);
      if (rest.length) copy[ORDER_KEY] = { version: ORDER_VERSION, occurrences: rest.map(entry => (entry.spelling ? entry : { key: entry.key })) };
      else delete copy[ORDER_KEY];
    }
    return copy;
  }
  const previous = readStored(values[key]);
  const stored = readStored(next);
  const rows = stored?.rows ?? [];
  const map = origins ?? rows.map((_, index) => (index < (previous?.rows.length ?? 0) ? index : null));
  const sharedChanged = (stored?.spelling ?? null) !== (previous?.spelling ?? null);
  const plan = expandPlan(schema, values, state.order);
  const result: PlannedOccurrence[] = [];
  let seen = 0;
  let last = -1;
  for (const item of plan) {
    if (item.key !== key) { result.push(item); continue; }
    const index = map.indexOf(seen);
    seen += 1;
    if (index < 0) continue;
    result.push({ key, spelling: sharedChanged ? stored?.spelling ?? null : item.spelling, values: rows[index] });
    last = result.length - 1;
  }
  const added = map.flatMap((origin, index) => (origin === null ? [{ key, spelling: stored?.spelling ?? null, values: rows[index] }] : []));
  result.splice(last < 0 ? result.length : last + 1, 0, ...added);
  return writePlan(schema, values, result);
}

/** Give one occurrence its own alias, creating an order record when the
 * grouped values cannot express it. */
export function setOccurrenceSpelling(schema: OptionSchema, values: Record<string, unknown>, key: string, row: number, spelling: string): Record<string, unknown> {
  const state = readOrder(values);
  if (!state.ok) return values;
  const plan = expandPlan(schema, values, state.order);
  let seen = 0;
  return writePlan(schema, values, plan.map(item => {
    if (item.key !== key) return item;
    return seen++ === row ? { ...item, spelling } : item;
  }));
}

/** Move one occurrence of the saved plan up or down. */
export function moveOccurrence(schema: OptionSchema, values: Record<string, unknown>, index: number, offset: -1 | 1): Record<string, unknown> {
  const state = readOrder(values);
  if (!state.ok) return values;
  const plan = expandPlan(schema, values, state.order);
  const target = index + offset;
  if (index < 0 || target < 0 || index >= plan.length || target >= plan.length) return values;
  [plan[index], plan[target]] = [plan[target], plan[index]];
  return writePlan(schema, values, plan);
}

/** The native integer can exceed the exact range of the editor's numbers. */
export class ImportedIntegerPrecisionError extends Error {
  constructor() { super(runtimeOptionsCopy.en.importIntegerPrecision); }
}

/** Merge an imported ordered plan: imported options replace their saved
 * occurrences and follow the existing ones in pasted order. Refuses to
 * rewrite a saved record this app cannot read. */
export function applyPlan(schema: OptionSchema, values: Record<string, unknown>, imported: { plan: PlannedOccurrence[] }): Record<string, unknown> {
  const state = readOrder(values);
  if (!state.ok) throw new Error('saved option order needs review before importing');
  const keys = new Set(imported.plan.map(item => item.key));
  const options = new Map(schema.options.map(option => [option.key, option]));
  // Check before merging any occurrence: IPC numbers may already have lost
  // integer digits, while the original pasted command is still reviewable.
  for (const item of imported.plan) {
    if (supportedValue(options.get(item.key)?.kind) === 'integer'
      && item.values.some(value => typeof value === 'number' && !Number.isSafeInteger(value))) {
      throw new ImportedIntegerPrecisionError();
    }
  }
  const kept = expandPlan(schema, values, state.order).filter(item => !keys.has(item.key));
  const incoming = imported.plan.filter(item => orderable(options.get(item.key)));
  const next = writePlan(schema, values, [...kept, ...incoming]);
  // Imported values without a command-line position (requests, positional
  // slots) are grouped as before.
  for (const item of imported.plan) {
    if (orderable(options.get(item.key))) continue;
    const rows = imported.plan.filter(other => other.key === item.key).map(other => [...other.values]);
    next[item.key] = writeStored(rows, normalizeSpelling(options.get(item.key), item.spelling, item.values));
  }
  return next;
}
