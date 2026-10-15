import type { Locale } from './i18nCatalog';

/**
 * Scoped `DiagnosticDetails` copy (see `../ui/DiagnosticDetails.tsx`) — the
 * toggle, copy-action and copy-feedback labels for collapsed engine
 * diagnostics. Kept out of the shared `ui.`/`panel.` catalogs so the D15 fix
 * adds no global i18n surface; components read it via `useI18n().locale`
 * like `providerCopy`/`runtimeAdapterCopy`.
 */
const en = {
  showDetails: 'Show full diagnostic',
  copy: 'Copy full diagnostic',
  copied: 'Copied',
  copyFailed: 'Copy failed',
  fullDiagnostic: 'Full diagnostic',
};
type Copy = { [K in keyof typeof en]: string };
export const diagnosticDetailsCopy: Record<Locale, Copy> = {
  en,
  ko: {
    showDetails: '전체 진단 보기',
    copy: '전체 진단 복사',
    copied: '복사됨',
    copyFailed: '복사에 실패했습니다',
    fullDiagnostic: '전체 진단',
  },
  ja: {
    showDetails: '詳細な診断を表示',
    copy: '詳細な診断をコピー',
    copied: 'コピーしました',
    copyFailed: 'コピーに失敗しました',
    fullDiagnostic: '詳細な診断',
  },
  zh: {
    showDetails: '显示完整诊断',
    copy: '复制完整诊断',
    copied: '已复制',
    copyFailed: '复制失败',
    fullDiagnostic: '完整诊断',
  },
};
