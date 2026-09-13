const en = {
  next: 'Save the profile and reload to use these execution options.', request: 'Save the profile to use these settings for the next request.',
  prompt: 'Default system prompt', promptHint: 'Used by new conversations. Existing conversations keep their own prompt.',
  savedFailure: 'Settings were saved, but the following operation failed. You can retry without creating the profile again: ',
};
type Copy = typeof en;
export const profileStatusCopy: Record<'en' | 'ko' | 'ja' | 'zh', Copy> = {
  en,
  ko: { next: '프로필을 저장하고 다시 실행하면 실행 옵션이 반영됩니다.', request: '프로필을 저장하면 다음 요청부터 사용합니다.', prompt: '기본 시스템 프롬프트', promptHint: '새 대화에서 사용합니다. 기존 대화의 프롬프트는 유지됩니다.', savedFailure: '설정은 저장했지만 후속 작업에 실패했습니다. 프로필을 다시 만들지 않고 재시도할 수 있습니다: ' },
  ja: { next: 'プロファイルを保存して再起動すると実行設定が反映されます。', request: 'プロファイルを保存すると次のリクエストから使用します。', prompt: '既定のシステムプロンプト', promptHint: '新しい会話に使用します。既存の会話のプロンプトは保持されます。', savedFailure: '設定は保存されましたが、後続の操作に失敗しました。プロファイルを再作成せずに再試行できます: ' },
  zh: { next: '保存预设并重新运行后，执行选项才会生效。', request: '保存预设后用于下次请求。', prompt: '默认系统提示词', promptHint: '用于新对话。现有对话保留自己的提示词。', savedFailure: '设置已保存，但后续操作失败。无需重新创建预设即可重试：' },
};
