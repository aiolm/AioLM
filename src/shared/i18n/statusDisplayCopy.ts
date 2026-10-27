import type { Locale } from './i18nCatalog';
import type { CapabilityState } from '../runtime/runtimeUtils';

export const statusDisplayCopy = {
  en: {
    memoryUnavailable: 'Memory estimate unavailable.', automatic: 'Automatic', off: 'Off',
    memorySources: { filesystem: 'estimated from file sizes', metadata: 'estimated from model information', unknown: 'unavailable' },
    capabilities: { available: 'Executable available', 'failed preflight': 'Executable check failed', 'not installed': 'Installation needed', 'unsupported by this runtime build': 'Unavailable in this build', unknown: 'Needs a check' },
    pullRequests: { open: 'Open', closed: 'Closed', merged: 'Merged' },
  },
  ko: {
    memoryUnavailable: '메모리 예상값을 확인할 수 없습니다.', automatic: '자동', off: '사용 안 함',
    memorySources: { filesystem: '파일 크기 기준 추정', metadata: '모델 정보 기준 추정', unknown: '확인 불가' },
    capabilities: { available: '실행 파일 사용 가능', 'failed preflight': '실행 파일 점검 실패', 'not installed': '설치 필요', 'unsupported by this runtime build': '이 빌드에서 사용할 수 없음', unknown: '확인 필요' },
    pullRequests: { open: '열려 있음', closed: '종료됨', merged: '병합됨' },
  },
  ja: {
    memoryUnavailable: 'メモリの推定値を確認できません。', automatic: '自動', off: '使用しない',
    memorySources: { filesystem: 'ファイルサイズから推定', metadata: 'モデル情報から推定', unknown: '確認不可' },
    capabilities: { available: '実行ファイルを使用可能', 'failed preflight': '実行ファイルの確認に失敗', 'not installed': 'インストールが必要', 'unsupported by this runtime build': 'このビルドでは利用不可', unknown: '確認が必要' },
    pullRequests: { open: 'オープン', closed: 'クローズ済み', merged: 'マージ済み' },
  },
  zh: {
    memoryUnavailable: '无法确认内存估算值。', automatic: '自动', off: '不使用',
    memorySources: { filesystem: '根据文件大小估算', metadata: '根据模型信息估算', unknown: '无法确认' },
    capabilities: { available: '可执行文件可用', 'failed preflight': '可执行文件检查失败', 'not installed': '需要安装', 'unsupported by this runtime build': '此构建不可用', unknown: '需要检查' },
    pullRequests: { open: '开放中', closed: '已关闭', merged: '已合并' },
  },
} satisfies Record<Locale, {
  memoryUnavailable: string; automatic: string; off: string;
  memorySources: Record<string, string>;
  capabilities: Record<CapabilityState, string>;
  pullRequests: Record<string, string>;
}>;

/** Keep future backend values visible instead of interpreting them as a known state. */
function knownLabel(labels: Record<string, string>, value: string): string {
  return Object.prototype.hasOwnProperty.call(labels, value) ? labels[value] : value;
}

export const capabilityStateText = (state: string, locale: Locale): string => knownLabel(statusDisplayCopy[locale].capabilities, state);
export const pullRequestStateText = (state: string, locale: Locale): string => knownLabel(statusDisplayCopy[locale].pullRequests, state);
export const memorySourceText = (source: string, locale: Locale): string => knownLabel(statusDisplayCopy[locale].memorySources, source);
