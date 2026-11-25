import type { Locale } from '../../shared/i18n/i18nCatalog';

// The banner shown while browsing another conversation only offers a way back;
// the live conversation's own view explains its busy or approval state.
export const chatTurnOwnerCopy: Record<Locale, { returnTo: string }> = {
  en: { returnTo: 'Return to ongoing conversation' },
  ko: { returnTo: '진행 중인 대화로 돌아가기' },
  ja: { returnTo: '進行中の会話に戻る' },
  zh: { returnTo: '返回进行中的对话' },
};
