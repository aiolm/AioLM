import { describe, expect, it } from 'vitest';
import { translate } from '../../shared/i18n/i18n';
import { TUNING_FIELD_CATALOG, tuningFieldDescription } from './tuningFields';

const locales = ['en', 'ko', 'ja', 'zh'] as const;

describe('concise setting explanations', () => {
  it.each(locales)('explains Min-p and its off value once in %s', locale => {
    const field = TUNING_FIELD_CATALOG.find(entry => entry.key === 'min_p')!;
    const description = tuningFieldDescription(key => translate(locale, key), field);
    const expected = {
      en: "Remove candidates below this fraction of the most likely token's probability. 0 disables filtering.",
      ko: '가장 높은 확률을 기준으로 이 비율 미만인 토큰을 제외합니다. 0이면 끕니다.',
      ja: '最高確率に対して、この比率を下回るトークンを除外します。0 は無効です。',
      zh: '以最高概率为基准，排除低于此比例的 token。0 禁用。',
    };
    expect(description).toBe(expected[locale]);
  });

  it.each(locales)('retains special values when separate hints are omitted in %s', locale => {
    const specialValues: Record<string, string[]> = {
      ngl: ['0'], ctx_size: ['0'], threads: ['0'], parallel: ['0'],
      sleep_idle_seconds: ['−1'], spec_draft_p_min: ['0'], reasoning_budget: ['−1', '0'],
      top_n_sigma: ['−1'], typical_p: ['1'], xtc_probability: ['0'], xtc_threshold: ['1'],
      dynatemp_range: ['0'], repeat_last_n: ['−1', '0'], repeat_penalty: ['1'],
      presence_penalty: ['0'], frequency_penalty: ['0'], dry_multiplier: ['0'],
      dry_penalty_last_n: ['0'], mirostat: ['0'], seed: ['−1'], max_tokens: ['−1'],
      n_probs: ['0'], min_keep: ['0'], t_max_predict_ms: ['−1', '0'], id_slot: ['−1'],
    };
    for (const [key, values] of Object.entries(specialValues)) {
      const field = TUNING_FIELD_CATALOG.find(entry => entry.key === key)!;
      const description = tuningFieldDescription(textKey => translate(locale, textKey), field);
      for (const value of values) expect(description, `${key}: ${value}`).toContain(value);
    }
  });
});
