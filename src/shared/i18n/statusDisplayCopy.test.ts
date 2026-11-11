// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { memorySourceText, pullRequestStateText } from './statusDisplayCopy';

describe('backend status presentation', () => {
  it('preserves future status and source values instead of guessing their meaning', () => {
    for (const locale of ['en', 'ko', 'ja', 'zh'] as const) {
      expect(pullRequestStateText('future-pr-state', locale)).toBe('future-pr-state');
      expect(memorySourceText('future-estimator', locale)).toBe('future-estimator');
      expect(pullRequestStateText('constructor', locale)).toBe('constructor');
    }
  });
});
