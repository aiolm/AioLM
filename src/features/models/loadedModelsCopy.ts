import type { Locale } from '../../shared/i18n/i18nCatalog';

/**
 * Copy for the loaded-model controls in the model library and the collapsed
 * saved-session editor beside them. Shared session vocabulary (Load, Stop,
 * Unload, session names) stays in the `ui.` catalog.
 */
const en = {
  empty: 'No model is loaded. Choose a model below to load it.',
  details: 'Details',
  sessionDetails: 'Session details',
  saved: 'Saved sessions',
  savedEmpty: 'No saved sessions',
  options: 'Load options',
};
type Copy = { [K in keyof typeof en]: string };

export const loadedModelsCopy: Record<Locale, Copy> = {
  en,
  ko: {
    empty: '로드된 모델이 없습니다. 아래 목록에서 모델을 선택해 로드하세요.',
    details: '상세',
    sessionDetails: '세션 상세',
    saved: '저장된 세션',
    savedEmpty: '저장된 세션 없음',
    options: '로드 옵션',
  },
  ja: {
    empty: '読み込まれているモデルはありません。下の一覧からモデルを選んで読み込んでください。',
    details: '詳細',
    sessionDetails: 'セッション詳細',
    saved: '保存済みセッション',
    savedEmpty: '保存されたセッションはありません',
    options: 'ロードオプション',
  },
  zh: {
    empty: '当前没有已加载的模型。请在下方列表中选择模型并加载。',
    details: '详情',
    sessionDetails: '会话详情',
    saved: '已保存的会话',
    savedEmpty: '没有已保存的会话',
    options: '加载选项',
  },
};
