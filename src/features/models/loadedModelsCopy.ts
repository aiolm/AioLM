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
  removeTitle: 'Remove saved session?',
  removeBody: 'Remove the saved session "{name}"? The model file and its shared profiles are kept.',
};
type Copy = { [K in keyof typeof en]: string };

export const loadedModelsCopy: Record<Locale, Copy> = {
  en,
  ko: {
    sessionDetails: '세션 상세',
    saved: '저장된 세션',
    savedEmpty: '저장된 세션 없음',
    options: '로드 옵션',
    removeTitle: '저장된 세션을 삭제할까요?',
    removeBody: '저장된 세션 "{name}"을(를) 삭제할까요? 모델 파일과 공유 프로필은 유지됩니다.',
  },
  ja: {
    sessionDetails: 'セッション詳細',
    saved: '保存済みセッション',
    savedEmpty: '保存されたセッションはありません',
    options: 'ロードオプション',
    removeTitle: '保存済みセッションを削除しますか？',
    removeBody: '保存済みセッション「{name}」を削除しますか？モデルファイルと共有プロファイルは保持されます。',
  },
  zh: {
    sessionDetails: '会话详情',
    saved: '已保存的会话',
    savedEmpty: '没有已保存的会话',
    options: '加载选项',
    removeTitle: '删除已保存的会话？',
    removeBody: '要删除已保存的会话“{name}”吗？模型文件和共享配置将保留。',
  },
};
