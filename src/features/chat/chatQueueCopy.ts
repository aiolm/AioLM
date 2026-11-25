import type { Locale } from '../../shared/i18n/i18nCatalog';

interface ChatQueueCopy {
  queue: string;
  queueTitle: string;
  steer: string;
  steerTitle: string;
  queued: string;
  next: string;
  sendNow: string;
  remove: string;
  paused: string;
  resume: string;
  attachments: string;
  placeholderBusy: string;
  clearQueueFirst: string;
}

/** Copy for messages written while a reply runs, a tool waits for approval, or a model loads. */
export const chatQueueCopy: Record<Locale, ChatQueueCopy> = {
  en: {
    queue: 'Queue',
    queueTitle: 'Send this message after the current reply finishes (Alt+Enter switches between queue and send now)',
    steer: 'Send now',
    steerTitle: 'Stop the current reply and send this message right away',
    queued: 'Queued messages ({count})',
    next: 'Sending next',
    sendNow: 'Send now',
    remove: 'Remove queued message',
    paused: 'The queue is paused because the reply was stopped or failed.',
    resume: 'Resume queue',
    attachments: '{count} attached',
    placeholderBusy: 'Write the next message: queue it, or stop the reply and send it now',
    clearQueueFirst: 'Send or remove the queued messages first.',
  },
  ko: {
    queue: '대기열에 추가',
    queueTitle: '현재 응답이 끝난 뒤 이 메시지를 보냅니다 (Alt+Enter로 대기열/즉시 전송 전환)',
    steer: '즉시 전송',
    steerTitle: '현재 응답을 중지하고 이 메시지를 바로 보냅니다',
    queued: '대기 중인 메시지 ({count})',
    next: '다음 전송',
    sendNow: '즉시 전송',
    remove: '대기 중인 메시지 삭제',
    paused: '응답이 중지되었거나 실패해 대기열을 일시 정지했습니다.',
    resume: '대기열 재개',
    attachments: '첨부 {count}개',
    placeholderBusy: '다음 메시지를 입력하세요: 대기열에 넣거나, 응답을 중지하고 즉시 보낼 수 있습니다',
    clearQueueFirst: '대기 중인 메시지를 먼저 보내거나 삭제하세요.',
  },
  ja: {
    queue: 'キューに追加',
    queueTitle: '現在の応答が終わった後にこのメッセージを送信します（Alt+Enter でキュー/今すぐ送信を切り替え）',
    steer: '今すぐ送信',
    steerTitle: '現在の応答を停止して、このメッセージをすぐに送信します',
    queued: '待機中のメッセージ（{count}）',
    next: '次に送信',
    sendNow: '今すぐ送信',
    remove: '待機中のメッセージを削除',
    paused: '応答が停止または失敗したため、キューを一時停止しました。',
    resume: 'キューを再開',
    attachments: '添付 {count} 件',
    placeholderBusy: '次のメッセージを入力: キューに追加するか、応答を停止して今すぐ送信できます',
    clearQueueFirst: '待機中のメッセージを先に送信するか削除してください。',
  },
  zh: {
    queue: '加入队列',
    queueTitle: '在当前回复结束后发送此消息（Alt+Enter 在加入队列和立即发送之间切换）',
    steer: '立即发送',
    steerTitle: '停止当前回复并立即发送此消息',
    queued: '排队中的消息（{count}）',
    next: '下一条发送',
    sendNow: '立即发送',
    remove: '删除排队中的消息',
    paused: '由于回复已停止或失败，队列已暂停。',
    resume: '恢复队列',
    attachments: '{count} 个附件',
    placeholderBusy: '输入下一条消息：可加入队列，或停止回复后立即发送',
    clearQueueFirst: '请先发送或删除排队中的消息。',
  },
};
