/** Runtime JSON values cross the editor's JavaScript-number boundary before
 * they reach native validation. Refuse numbers that could silently change. */
export class JsonOptionNumberError extends Error {
  constructor() { super('JSON contains a number outside the editor range'); }
}

export function assertJsonOptionNumbers(value: unknown): void {
  const pending = [value];
  while (pending.length) {
    const current = pending.pop();
    if (typeof current === 'number') {
      if (!Number.isFinite(current) || Number.isInteger(current) && !Number.isSafeInteger(current)) {
        throw new JsonOptionNumberError();
      }
    } else if (current !== null && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push(child);
    }
  }
}

export function parseJsonOption(text: string): unknown {
  const value: unknown = JSON.parse(text);
  assertJsonOptionNumbers(value);
  return value;
}
