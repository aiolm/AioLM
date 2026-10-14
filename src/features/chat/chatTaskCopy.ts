import type { Locale } from '../../shared/i18n/i18nCatalog';

const TASK_NAMES: Record<Locale, Record<string, string>> = {
  en: { embed: 'embeddings', transcription: 'speech transcription' },
  ko: { embed: '임베딩', transcription: '음성 전사' },
  ja: { embed: '埋め込み', transcription: '音声文字起こし' },
  zh: { embed: '嵌入', transcription: '语音转写' },
};

const SEPARATOR: Record<Locale, string> = { en: ', ', ko: ', ', ja: '、', zh: '、' };

const COPY: Record<Locale, { only: (tasks: string) => string; none: string }> = {
  en: {
    only: (tasks) => `This session provides ${tasks} only, not chat or text generation. Select or load a chat model session to send messages.`,
    none: 'This session does not provide chat or text generation. Select or load a chat model session to send messages.',
  },
  ko: {
    only: (tasks) => `이 세션은 ${tasks}만 제공하며 채팅이나 텍스트 생성은 지원하지 않습니다. 메시지를 보내려면 채팅 모델 세션을 선택하거나 로드하세요.`,
    none: '이 세션은 채팅이나 텍스트 생성을 지원하지 않습니다. 메시지를 보내려면 채팅 모델 세션을 선택하거나 로드하세요.',
  },
  ja: {
    only: (tasks) => `このセッションは${tasks}のみを提供し、チャットやテキスト生成には対応していません。メッセージを送るには、チャットモデルのセッションを選択するか読み込んでください。`,
    none: 'このセッションはチャットやテキスト生成に対応していません。メッセージを送るには、チャットモデルのセッションを選択するか読み込んでください。',
  },
  zh: {
    only: (tasks) => `此会话仅提供${tasks}，不支持聊天或文本生成。要发送消息，请选择或加载聊天模型会话。`,
    none: '此会话不支持聊天或文本生成。要发送消息，请选择或加载聊天模型会话。',
  },
};

/** Explains a running session that serves no generation, from the tasks it reports rather than its engine. */
export function chatTaskCopy(locale: Locale, tasks: string[]): string {
  const names = tasks.map((task) => TASK_NAMES[locale][task]).filter((name): name is string => !!name);
  return names.length ? COPY[locale].only(names.join(SEPARATOR[locale])) : COPY[locale].none;
}
