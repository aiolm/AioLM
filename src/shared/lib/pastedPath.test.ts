import { describe, expect, it } from 'vitest';
import { unquotePastedPath, unquotePastedPathArg } from './pastedPath';

// The native launcher applies the same rule (`unquote_pasted_path` in
// runtime_options.rs) to values saved before the field normalized them.
describe('pasted shell-quoted paths', () => {
  it.each([
    ['"C:\\models\\a.gguf"', 'C:\\models\\a.gguf'],
    ['  "D:/models/a.gguf"  ', 'D:/models/a.gguf'],
    ['"\\\\nas\\share\\a.gguf"', '\\\\nas\\share\\a.gguf'],
    ['"\\\\?\\C:\\models\\a.gguf"', '\\\\?\\C:\\models\\a.gguf'],
    ["'/home/user/a.gguf'", '/home/user/a.gguf'],
    ['C:\\models\\a.gguf', 'C:\\models\\a.gguf'],
    ['"models\\a.gguf"', '"models\\a.gguf"'],
    ['"C:\\models\\a.gguf\'', '"C:\\models\\a.gguf\''],
    ['"C:\\a "b" c.gguf"', '"C:\\a "b" c.gguf"'],
    ['""', '""'],
    ['"', '"'],
  ])('removes only one matching quote pair around an absolute path: %s', (pasted, expected) => {
    expect(unquotePastedPath(pasted)).toBe(expected);
  });

  it('unquotes the value of a --flag= token without touching other text', () => {
    expect(unquotePastedPathArg('--mmproj="C:\\m\\a.gguf"')).toBe('--mmproj=C:\\m\\a.gguf');
    expect(unquotePastedPathArg('--label="text"')).toBe('--label="text"');
    expect(unquotePastedPathArg('"C:\\m\\a.gguf"')).toBe('C:\\m\\a.gguf');
  });
});
