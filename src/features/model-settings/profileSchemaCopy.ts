const en = {
  options: 'Runtime options', app: 'AioLM settings', retained: 'Saved options awaiting verification',
  checking: 'Checking the options available for this engine…', unavailable: 'Could not check this engine’s options. Your saved settings are unchanged; values will appear once they can be checked.',
  stale: 'The engine’s options need to be checked again. Reload its help before using these saved settings.',
  unverified: 'Needs a compatibility check · saved setting kept', empty: 'No options have been changed. Using the engine’s default settings.',
  retry: 'Retry', unknownDefault: 'Engine default (value unavailable)', declared: 'Options listed in the engine’s help or registration. Settings are checked before running.',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  options: '런타임 옵션', app: 'AioLM 설정', retained: '확인이 필요한 저장 옵션',
  checking: '이 엔진에서 사용할 수 있는 옵션을 확인하고 있습니다…', unavailable: '옵션 정보를 확인하지 못했습니다. 저장한 설정은 유지되며, 확인 후 값을 표시합니다.',
  stale: '현재 엔진 버전에서 이 설정을 사용할 수 있는지 다시 확인해야 합니다. 도움말을 다시 불러와 주세요.',
  unverified: '사용 가능 여부 확인 필요 · 기존 설정 유지', empty: '변경한 옵션이 없어 엔진 기본 설정을 사용합니다.',
  retry: '다시 시도', unknownDefault: '엔진 기본값(값을 확인할 수 없음)', declared: '엔진 도움말과 등록 정보에 있는 옵션입니다. 실행 전에 설정을 확인합니다.',
};
const ja: Copy = {
  options: 'ランタイムオプション', app: 'AioLM 設定', retained: '確認が必要な保存済みオプション',
  checking: 'このエンジンで使えるオプションを確認しています…', unavailable: 'オプション情報を確認できませんでした。保存した設定はそのまま保持し、確認でき次第、値を表示します。',
  stale: '現在のエンジンでこの設定を使えるか再確認が必要です。ヘルプを再読み込みしてください。',
  unverified: '使用できるか確認が必要 · 保存した設定を保持', empty: '変更したオプションはありません。エンジンの既定の設定を使用します。',
  retry: '再試行', unknownDefault: 'エンジンの既定値（値を確認できません）', declared: 'エンジンのヘルプや登録情報にあるオプションです。実行前に設定を確認します。',
};
const zh: Copy = {
  options: '运行时选项', app: 'AioLM 设置', retained: '待验证的已保存选项',
  checking: '正在检查此引擎可用的选项…', unavailable: '无法确认选项信息。已保存的设置保持不变，确认后会显示相应的值。',
  stale: '需要重新确认这些设置是否适用于当前引擎版本。请重新加载帮助。',
  unverified: '需要确认是否可用 · 保留原有设置', empty: '未更改任何选项，使用引擎的默认设置。',
  retry: '重试', unknownDefault: '引擎默认值（无法确认具体值）', declared: '引擎帮助或注册信息中列出的选项。运行前会检查设置。',
};
export const profileSchemaCopy = { en, ko, ja, zh };
