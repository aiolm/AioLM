import type { Locale } from '../../shared/i18n/i18nCatalog';

export const chatTurnOwnerCopy: Record<Locale, { working: string; approval: string; returnTo: string }> = {
  en: {
    working: 'A response is in progress in “{title}”. Return there to stop it, or wait for it to finish before sending another message.',
    approval: '“{title}” is waiting for tool approval. Return there to review or reject the request before sending another message.',
    returnTo: 'Return to {title}',
  },
  ko: {
    working: '“{title}”에서 응답을 처리 중입니다. 해당 대화로 돌아가 중지하거나, 완료된 뒤 새 메시지를 보내세요.',
    approval: '“{title}”에서 도구 승인을 기다리고 있습니다. 새 메시지를 보내기 전에 해당 대화로 돌아가 요청을 검토하거나 거부하세요.',
    returnTo: '“{title}” 대화로 돌아가기',
  },
  ja: {
    working: '「{title}」で応答を処理中です。その会話に戻って停止するか、完了してから新しいメッセージを送信してください。',
    approval: '「{title}」でツールの承認を待っています。新しいメッセージを送信する前に、その会話に戻ってリクエストを確認または拒否してください。',
    returnTo: '「{title}」に戻る',
  },
  zh: {
    working: '“{title}”中正在处理回复。请返回该对话停止处理，或等待完成后再发送新消息。',
    approval: '“{title}”正在等待工具审批。发送新消息前，请返回该对话审查或拒绝请求。',
    returnTo: '返回“{title}”',
  },
};
