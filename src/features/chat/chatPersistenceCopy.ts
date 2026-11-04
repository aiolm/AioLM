import type { Locale } from '../../shared/i18n/i18nCatalog';

export const chatPersistenceCopy: Record<Locale, { failed: string; retry: string }> = {
  en: {
    failed: 'Conversation changes could not be saved. They remain available in this session. Check storage space and permissions, then retry before closing AioLM.',
    retry: 'Retry saving',
  },
  ko: {
    failed: '대화 변경 내용을 저장하지 못했습니다. 현재 세션에는 남아 있습니다. 저장 공간과 권한을 확인한 뒤 AioLM을 닫기 전에 다시 저장하세요.',
    retry: '다시 저장',
  },
  ja: {
    failed: '会話の変更を保存できませんでした。現在のセッションには残っています。空き容量とアクセス権を確認し、AioLMを閉じる前に保存を再試行してください。',
    retry: '保存を再試行',
  },
  zh: {
    failed: '无法保存对话更改。更改仍保留在当前会话中。请检查存储空间和权限，并在关闭 AioLM 前重试保存。',
    retry: '重试保存',
  },
};
