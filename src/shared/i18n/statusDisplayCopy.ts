import type { Locale } from './i18nCatalog';

export const statusDisplayCopy = {
  en: {
    memoryUnavailable: 'Memory estimate unavailable.', automatic: 'Automatic', off: 'Off',
    memorySources: { filesystem: 'estimated from file sizes', metadata: 'estimated from model information', unknown: 'unavailable' },
    pullRequests: { open: 'Open', closed: 'Closed', merged: 'Merged' },
  },
  ko: {
    memoryUnavailable: '메모리 예상값을 확인할 수 없습니다.', automatic: '자동', off: '사용 안 함',
    memorySources: { filesystem: '파일 크기 기준 추정', metadata: '모델 정보 기준 추정', unknown: '확인 불가' },
    pullRequests: { open: '열려 있음', closed: '종료됨', merged: '병합됨' },
  },
  ja: {
    memoryUnavailable: 'メモリの推定値を確認できません。', automatic: '自動', off: '使用しない',
    memorySources: { filesystem: 'ファイルサイズから推定', metadata: 'モデル情報から推定', unknown: '確認不可' },
    pullRequests: { open: 'オープン', closed: 'クローズ済み', merged: 'マージ済み' },
  },
  zh: {
    memoryUnavailable: '无法确认内存估算值。', automatic: '自动', off: '不使用',
    memorySources: { filesystem: '根据文件大小估算', metadata: '根据模型信息估算', unknown: '无法确认' },
    pullRequests: { open: '开放中', closed: '已关闭', merged: '已合并' },
  },
} satisfies Record<Locale, {
  memoryUnavailable: string; automatic: string; off: string;
  memorySources: Record<string, string>;
  pullRequests: Record<string, string>;
}>;

/** Keep future backend values visible instead of interpreting them as a known state. */
function knownLabel(labels: Record<string, string>, value: string): string {
  // An own key in this string-valued record has a label.
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value]! : value;
}

export const pullRequestStateText = (state: string, locale: Locale): string => knownLabel(statusDisplayCopy[locale].pullRequests, state);
export const memorySourceText = (source: string, locale: Locale): string => knownLabel(statusDisplayCopy[locale].memorySources, source);
