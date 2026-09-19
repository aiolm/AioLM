import { describe, expect, it } from 'vitest';
import { parseMarkdown } from './markdown';

/** Model output is untrusted input: a slow parse freezes the chat panel. */
describe('markdown parser on hostile input', () => {
  const within = (label: string, source: string, budgetMs: number) => {
    const started = performance.now();
    parseMarkdown(source);
    const took = performance.now() - started;
    expect(took, `${label} took ${took.toFixed(0)}ms`).toBeLessThan(budgetMs);
  };

  it('parses a long run of unmatched emphasis markers quickly', () => {
    within('asterisks', '*'.repeat(20_000), 1_000);
    within('underscores', '_'.repeat(20_000), 1_000);
    within('mixed', '*_~`['.repeat(5_000), 1_000);
  });

  it('parses a long run of unterminated inline code quickly', () => {
    within('backticks', '`a'.repeat(10_000), 1_000);
  });

  it('parses deeply indented list markers without stalling', () => {
    within('nesting', Array.from({ length: 2_000 }, (_, i) => ' '.repeat(i % 40) + '- item').join('\n'), 1_000);
  });

  it('parses a large ordinary answer quickly', () => {
    const paragraph = 'The quick brown fox jumps over the lazy dog. **Bold** and `code` and [a](https://example.test).\n\n';
    within('prose', paragraph.repeat(2_000), 1_000);
  });
});
