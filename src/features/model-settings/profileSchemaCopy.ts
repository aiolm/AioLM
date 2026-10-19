const en = {
  options: 'Runtime options', app: 'AioLM settings', retained: 'Saved options awaiting verification',
  checking: 'Checking the selected runtime’s option schema…', unavailable: 'The runtime option schema could not be verified. Saved values are preserved and hidden.',
  stale: 'Runtime help needs review. These saved values are not confirmed for the selected build.',
  unverified: 'Support unverified · saved value preserved', empty: 'No runtime option overrides.',
  retry: 'Retry', unknownDefault: 'Runtime default (value unknown)', declared: 'Declared option; execution still requires validation.',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  options: '런타임 옵션', app: 'AioLM 설정', retained: '확인이 필요한 저장 옵션',
  checking: '선택한 런타임의 옵션 schema를 확인하고 있습니다…', unavailable: '런타임 옵션 schema를 확인하지 못했습니다. 저장값은 보존하며 숨깁니다.',
  stale: '런타임 도움말을 검토해야 합니다. 이 저장값이 선택한 빌드에 적용되는지 확인되지 않았습니다.',
  unverified: '지원 미확인 · 저장값 보존', empty: '덮어쓴 런타임 옵션이 없습니다.',
  retry: '다시 시도', unknownDefault: '런타임 기본값(값 미확인)', declared: '선언된 옵션이며 실행 전 검증이 필요합니다.',
};
const ja: Copy = {
  options: 'ランタイムオプション', app: 'AioLM 設定', retained: '確認が必要な保存済みオプション',
  checking: '選択したランタイムのオプション schema を確認中…', unavailable: 'ランタイムの schema を確認できませんでした。保存値は保持し、非表示にします。',
  stale: 'ランタイムのヘルプを確認してください。このビルドに保存値が適用できるかは未確認です。',
  unverified: '対応未確認 · 保存値を保持', empty: 'ランタイムオプションの上書きはありません。',
  retry: '再試行', unknownDefault: 'ランタイムの既定値（値は不明）', declared: '宣言されたオプションです。実行前の検証が必要です。',
};
const zh: Copy = {
  options: '运行时选项', app: 'AioLM 设置', retained: '待验证的已保存选项',
  checking: '正在检查所选运行时的选项 schema…', unavailable: '无法验证运行时的 schema。已保存的值会保留并隐藏。',
  stale: '请检查运行时帮助。尚未确认这些保存值是否适用于所选版本。',
  unverified: '支持情况未确认 · 保留保存值', empty: '没有运行时选项覆盖值。',
  retry: '重试', unknownDefault: '运行时默认值（未知）', declared: '已声明的选项，执行前仍需验证。',
};
export const profileSchemaCopy = { en, ko, ja, zh };
