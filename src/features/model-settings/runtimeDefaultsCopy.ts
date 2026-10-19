const en = {
  reset: 'Reset options to defaults',
  hint: 'Restores options to the engine’s defaults, including those hidden by search. Model and connection settings and saved options that need review are kept.',
  done: 'Options restored to the engine’s defaults. Save the profile to keep this change.',
  order: 'Check the saved option order, then try resetting again.',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  reset: '옵션을 기본값으로 되돌리기',
  hint: '검색으로 가려진 옵션까지 엔진 기본 설정으로 되돌립니다. 모델·연결 설정과 확인이 필요한 기존 설정은 그대로 둡니다.',
  done: '옵션을 기본 설정으로 되돌렸습니다. 이 변경을 유지하려면 프로필을 저장하세요.',
  order: '옵션의 실행 순서를 확인한 후 다시 초기화해 주세요.',
};
const ja: Copy = {
  reset: 'オプションを既定値に戻す',
  hint: '検索で非表示のオプションも含め、エンジンの既定の設定に戻します。モデルや接続の設定、確認が必要な保存済みの設定はそのまま保持します。',
  done: 'オプションを既定の設定に戻しました。変更を保持するにはプロファイルを保存してください。',
  order: '保存したオプションの順序を確認してから、もう一度試してください。',
};
const zh: Copy = {
  reset: '将选项恢复为默认值',
  hint: '将选项恢复为引擎默认设置，包括被搜索隐藏的选项。模型和连接设置，以及需要确认的原有设置会保持不变。',
  done: '选项已恢复为默认设置。请保存预设以保留更改。',
  order: '请检查已保存的选项顺序，然后重试。',
};
export const runtimeDefaultsCopy = { en, ko, ja, zh };
