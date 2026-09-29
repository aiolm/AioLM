import type { Locale } from './i18nCatalog';

const en = {
  prefill: 'Input processing (Prefill / PP)',
  decode: 'Output generation (Decode / TG)',
  estimated: 'estimated',
  standardDeviation: 'Standard deviation',
  rate: 'Rate',
  excludingCached: 'excluding cached tokens',
  includingReasoning: 'including reasoning tokens',
};
type Terms = { [K in keyof typeof en]: string };
const terms: Record<Locale, Terms> = {
  en,
  ko: {
    prefill: '입력 처리 (Prefill / PP)',
    decode: '출력 생성 (Decode / TG)',
    estimated: '추정',
    standardDeviation: '표준편차',
    rate: '속도',
    excludingCached: '캐시 토큰 제외',
    includingReasoning: '추론 토큰 포함',
  },
  ja: {
    prefill: '入力処理 (Prefill / PP)',
    decode: '出力生成 (Decode / TG)',
    estimated: '推定',
    standardDeviation: '標準偏差',
    rate: '速度',
    excludingCached: 'キャッシュトークンを除く',
    includingReasoning: '推論トークンを含む',
  },
  zh: {
    prefill: '输入处理 (Prefill / PP)',
    decode: '输出生成 (Decode / TG)',
    estimated: '估算',
    standardDeviation: '标准差',
    rate: '速度',
    excludingCached: '不含缓存令牌',
    includingReasoning: '包含推理令牌',
  },
};

/** Shared phase names for response metrics, benchmark results, sharing and exports.
 * Qualifiers preserve the difference between client estimates and runtime timings.
 */
export function inferenceMetricCopy(locale: Locale) {
  const text = terms[locale];
  return {
    ...text,
    prefillEstimated: `${text.prefill} · ${text.estimated}`,
    decodeDeviation: `${text.decode} · ${text.standardDeviation}`,
    chatPrefill: `${text.prefill}, ${text.excludingCached}`,
    chatDecode: `${text.decode}, ${text.includingReasoning}`,
  };
}
