import type { OptionSchema } from '../../shared/api/runtimeHelp';
import { ORDER_KEY, readOrder } from './optionOrder';

/** Omission delegates defaults to the engine; never materialize guessed literals.
 * Bindings, positional slots and values absent from this scope stay untouched. */
export function clearRuntimeOptionOverrides(schema: OptionSchema, values: Record<string, unknown>, scope: string[]): Record<string, unknown> {
  const order = readOrder(values);
  if (!order.ok) throw new Error('Review the saved option order before resetting options.');
  const removed = new Set(schema.options.filter(option => !option.managed && option.position == null
    && option.scope.every((segment, index) => scope[index] === segment)).map(option => option.key));
  const next = Object.fromEntries(Object.entries(values).filter(([key]) => !removed.has(key)));
  if (order.order) {
    const remaining = order.order.filter(entry => !removed.has(entry.key));
    if (remaining.length) next[ORDER_KEY] = { version: 1, occurrences: remaining.map(entry => entry.spelling ? entry : { key: entry.key }) };
    else delete next[ORDER_KEY];
  }
  return next;
}
