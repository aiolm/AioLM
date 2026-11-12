import type { Locale } from '../../shared/i18n/i18nCatalog';

/**
 * Copy for the collapsed named-session controls in the model library. Shared
 * session vocabulary (Load, Stop, Unload, session names) stays in the `ui.`
 * catalog.
 */
const en = {
  sessionDetails: 'Session details',
  saved: 'Saved sessions',
  savedEmpty: 'No saved sessions',
  options: 'Load options',
};
type Copy = { [K in keyof typeof en]: string };

export const loadedModelsCopy: Record<Locale, Copy> = {
  en,
  ko: {
    sessionDetails: '세션 상세',
    saved: '저장된 세션',
    savedEmpty: '저장된 세션 없음',
    options: '로드 옵션',
  },
  ja: {
    sessionDetails: 'セッション詳細',
    saved: '保存済みセッション',
    savedEmpty: '保存されたセッションはありません',
    options: 'ロードオプション',
  },
  zh: {
    sessionDetails: '会话详情',
    saved: '已保存的会话',
    savedEmpty: '没有已保存的会话',
    options: '加载选项',
  },
};
