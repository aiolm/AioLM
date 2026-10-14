import type { Locale } from '../../shared/i18n/i18nCatalog';
import type { ChatRetryUnavailableReason } from './chatHistory';

/** Why an unfinished reply restored from history cannot be retried exactly. */
export const chatRetryCopy: Record<Locale, Record<ChatRetryUnavailableReason, string>> = {
  en: {
    'not-saved': 'Retry is unavailable: this reply was saved without the exact original request (by an earlier version or in a format this version cannot read). Send the message again to continue.',
    'local-instructions': 'Retry is unavailable: this reply used local instructions or skills, which are not saved with conversations, so it can only be retried before switching conversations or restarting. Send the message again to use the current files.',
    'too-large': 'Retry is unavailable: the original request was too large to save with the conversation. Send the message again to continue.',
  },
  ko: {
    'not-saved': '재시도할 수 없습니다: 이 응답은 원래 요청의 정확한 사본 없이 저장되었습니다(이전 버전에서 저장했거나 이 버전이 읽을 수 없는 형식). 계속하려면 메시지를 다시 보내세요.',
    'local-instructions': '재시도할 수 없습니다: 이 응답은 대화에 저장되지 않는 로컬 지침이나 스킬을 사용했기 때문에 대화를 전환하거나 앱을 다시 시작하기 전에만 재시도할 수 있습니다. 현재 파일로 계속하려면 메시지를 다시 보내세요.',
    'too-large': '재시도할 수 없습니다: 원래 요청이 너무 커서 대화와 함께 저장하지 못했습니다. 계속하려면 메시지를 다시 보내세요.',
  },
  ja: {
    'not-saved': '再試行できません: この応答は元のリクエストの正確な写しなしで保存されました（以前のバージョン、またはこのバージョンが読めない形式）。続けるにはメッセージを再送信してください。',
    'local-instructions': '再試行できません: この応答は会話に保存されないローカル指示やスキルを使用したため、会話の切り替えや再起動の前にのみ再試行できます。現在のファイルで続けるにはメッセージを再送信してください。',
    'too-large': '再試行できません: 元のリクエストが大きすぎて会話と一緒に保存できませんでした。続けるにはメッセージを再送信してください。',
  },
  zh: {
    'not-saved': '无法重试：此回复保存时未包含原始请求的精确副本（由早期版本保存，或格式无法被此版本读取）。请重新发送消息以继续。',
    'local-instructions': '无法重试：此回复使用了不会随对话保存的本地指令或技能，因此只能在切换对话或重启前重试。请重新发送消息以使用当前文件。',
    'too-large': '无法重试：原始请求过大，无法随对话保存。请重新发送消息以继续。',
  },
};
