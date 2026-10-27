import { describe, expect, it } from 'vitest';
import { assertJsonOptionNumbers, JsonOptionNumberError, parseJsonOption } from './jsonOptionNumbers';

describe('runtime JSON option numbers', () => {
  it.each([
    '9007199254740992', '9007199254740993', '-9007199254740993',
    '9223372036854775807', '1e400', '-1e400',
  ])('refuses %s at the root and inside arrays and objects', number => {
    for (const json of [number, `[0,{"nested":${number}}]`]) {
      expect(() => parseJsonOption(json)).toThrow(JsonOptionNumberError);
    }
  });

  it('keeps safe endpoints, fractions, primitives, strings and numeric object keys', () => {
    const text = '{"9007199254740993":[9007199254740991,-9007199254740991,0,0.125,1e-7,true,null,"9007199254740993"]}';
    expect(parseJsonOption(text)).toEqual(JSON.parse(text));
    expect(parseJsonOption('"1e400"')).toBe('1e400');
    expect(() => parseJsonOption('{unfinished')).toThrow(SyntaxError);
  });

  it('checks deeply nested transported values without recursive stack growth or mutation', () => {
    let value: unknown = { number: Infinity };
    for (let i = 0; i < 20000; i++) value = [value];
    expect(() => assertJsonOptionNumbers(value)).toThrow(JsonOptionNumberError);
    const safe = { a: [1, 0.5, '9007199254740993'], b: null };
    const original = structuredClone(safe);
    expect(() => assertJsonOptionNumbers(safe)).not.toThrow();
    expect(safe).toEqual(original);
  });
});
