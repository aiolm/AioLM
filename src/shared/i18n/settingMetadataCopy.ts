import type { Locale } from './i18n';

export interface SettingMetadataCopy {
  inUse: string; reference: string; reset: string; unspecified: string;
  /** Short markers for where a default came from, sized to sit beside the value. */
  sourceApp: string; sourceRuntime: string;
}
export const settingMetadataCopy: Record<Locale, SettingMetadataCopy> = {
  en: { inUse: 'In use', reference: 'Reference value', reset: 'Reset', unspecified: 'Unspecified', sourceApp: 'App', sourceRuntime: 'Runtime' },
  ko: { inUse: '사용 중', reference: '참고값', reset: '기본값 복원', unspecified: '명시되지 않음', sourceApp: '앱', sourceRuntime: '런타임' },
  ja: { inUse: '使用中', reference: '参照値', reset: '既定値に戻す', unspecified: '未指定', sourceApp: 'アプリ', sourceRuntime: 'ランタイム' },
  zh: { inUse: '使用中', reference: '参考值', reset: '恢复默认', unspecified: '未指定', sourceApp: '应用', sourceRuntime: '运行时' },
};
