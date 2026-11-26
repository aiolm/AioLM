import { describe, expect, it } from 'vitest';
import { isSecretPlaceholder, withoutSecretPlaceholders } from './optionPresentation';

describe('pasting a masked launch preview back', () => {
  it('leaves out occurrences that name a secret only by placeholder', () => {
    const plan = [
      { key: 'token', values: ['•••'] },
      { key: 'label', values: ['fresh'] },
      { key: 'pair', values: ['a', '[REDACTED]'] },
      { key: 'token', values: ['•••'] },
      { key: 'note', values: ['contains ••• inside'] },
    ];
    expect(withoutSecretPlaceholders(plan)).toEqual({
      plan: [{ key: 'label', values: ['fresh'] }, { key: 'note', values: ['contains ••• inside'] }],
      kept: ['token', 'pair'],
    });
    expect(isSecretPlaceholder('•••')).toBe(true);
    expect(isSecretPlaceholder('[REDACTED]')).toBe(true);
    expect(isSecretPlaceholder('x•••')).toBe(false);
  });
});
