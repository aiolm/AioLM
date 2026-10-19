import { describe, expect, it } from 'vitest';
import { capabilityStateText, memorySourceText, pullRequestStateText } from './statusDisplayCopy';

describe('backend status presentation', () => {
  it('keeps unavailable, unchecked and failed checks distinct', () => {
    expect(capabilityStateText('available', 'ko')).toBe('실행 파일 사용 가능');
    expect(capabilityStateText('unknown', 'ko')).toBe('확인 필요');
    expect(capabilityStateText('failed preflight', 'ko')).toBe('실행 파일 점검 실패');
    expect(new Set(['not installed', 'unsupported by this runtime build', 'failed preflight', 'unknown']
      .map(state => capabilityStateText(state, 'ko'))).size).toBe(4);
  });

  it('preserves future status and source values instead of guessing their meaning', () => {
    for (const locale of ['en', 'ko', 'ja', 'zh'] as const) {
      expect(capabilityStateText('future-check', locale)).toBe('future-check');
      expect(pullRequestStateText('future-pr-state', locale)).toBe('future-pr-state');
      expect(memorySourceText('future-estimator', locale)).toBe('future-estimator');
      expect(pullRequestStateText('constructor', locale)).toBe('constructor');
    }
  });
});
