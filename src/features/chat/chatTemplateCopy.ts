import type { Locale } from '../../shared/i18n/i18nCatalog';

export const chatTemplateCopy: Record<Locale, string> = {
  en: 'This model has no chat template. Choose an Instruct/chat model, or set a chat template in its runtime profile. Text completions remain available.',
  ko: '이 모델에는 채팅 템플릿이 없습니다. Instruct/대화용 모델을 선택하거나 런타임 프로필에 채팅 템플릿을 지정하세요. 텍스트 이어쓰기는 계속 사용할 수 있습니다.',
  ja: 'このモデルにはチャットテンプレートがありません。Instruct/チャット用モデルを選択するか、ランタイムプロファイルにテンプレートを指定してください。テキスト補完は引き続き利用できます。',
  zh: '此模型没有聊天模板。请选择 Instruct/对话模型，或在运行时配置中指定聊天模板。文本续写仍然可用。',
};
