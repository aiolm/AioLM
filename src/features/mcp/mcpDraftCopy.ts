import type { Locale } from '../../shared/i18n/i18nCatalog';

export const mcpDraftCopy: Record<Locale, { title: string; body: string; keep: string; discard: string }> = {
  en: {
    title: 'Discard unsaved server changes?',
    body: 'This server definition has unsaved changes. Discard them to continue, or keep editing. Nothing will be saved automatically.',
    keep: 'Keep editing',
    discard: 'Discard changes',
  },
  ko: {
    title: '저장하지 않은 서버 변경 내용을 버릴까요?',
    body: '이 서버 정의에 저장하지 않은 변경 내용이 있습니다. 계속하려면 변경 내용을 버리거나 편집을 계속하세요. 자동으로 저장되지 않습니다.',
    keep: '계속 편집',
    discard: '변경 내용 버리기',
  },
  ja: {
    title: '未保存のサーバー変更を破棄しますか？',
    body: 'このサーバー定義には未保存の変更があります。破棄して続行するか、編集を続けてください。自動保存は行われません。',
    keep: '編集を続ける',
    discard: '変更を破棄',
  },
  zh: {
    title: '放弃未保存的服务器更改？',
    body: '此服务器定义有未保存的更改。放弃更改以继续，或继续编辑。更改不会自动保存。',
    keep: '继续编辑',
    discard: '放弃更改',
  },
};
