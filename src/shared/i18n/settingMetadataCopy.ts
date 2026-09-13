import type { Locale } from './i18n';

export const settingMetadataCopy: Record<Locale, {
  details: string; source: string; rules: string; inUse: string; reference: string; reset: string; varies: string; unspecified: string;
}> = {
  en: { details: 'Technical details', source: 'Source', rules: 'Default behavior', inUse: 'In use', reference: 'Reference value', reset: 'Reset', varies: 'Runtime determined', unspecified: 'Unspecified' },
  ko: { details: '기술 정보', source: '출처', rules: '기본값 동작', inUse: '사용 중', reference: '참고값', reset: '기본값 복원', varies: '런타임에서 결정', unspecified: '명시되지 않음' },
  ja: { details: '技術情報', source: '出典', rules: '既定の動作', inUse: '使用中', reference: '参照値', reset: '既定値に戻す', varies: 'ランタイムが決定', unspecified: '未指定' },
  zh: { details: '技术信息', source: '来源', rules: '默认行为', inUse: '使用中', reference: '参考值', reset: '恢复默认', varies: '由运行时决定', unspecified: '未指定' },
};
