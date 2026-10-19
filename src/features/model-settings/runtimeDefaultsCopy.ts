const en = {
  reset: 'Reset runtime options to defaults',
  hint: 'Clears overrides for all declared options, including those hidden by search. The engine supplies its defaults. Model connections, positional arguments and unrecognized saved values are kept.',
  done: 'Runtime option overrides cleared in this draft. Save the profile to keep the change.',
  order: 'Review the saved option order before resetting options.',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  reset: '런타임 옵션 기본값 복원',
  hint: '검색으로 가려진 항목을 포함해 확인된 옵션의 재정의를 해제하고 엔진 기본값을 사용합니다. 모델 연결·위치 인자·미확인 저장값은 유지합니다.',
  done: '편집 초안의 런타임 옵션 재정의를 해제했습니다. 유지하려면 프로필을 저장하세요.',
  order: '저장된 옵션 순서를 검토한 뒤 기본값을 복원하세요.',
};
const ja: Copy = {
  reset: 'ランタイムのオプションを既定値に戻す',
  hint: '検索で非表示の項目も含め、確認済みオプションの上書きを解除し、エンジンの既定値を使用します。モデル接続・位置引数・未確認の保存値は保持します。',
  done: '編集中のオプションの上書きを解除しました。変更を保持するにはプロファイルを保存してください。',
  order: '保存されたオプションの順序を確認してから既定値に戻してください。',
};
const zh: Copy = {
  reset: '恢复运行时选项默认值',
  hint: '清除所有已确认选项的覆盖值，包括被搜索隐藏的选项，并使用引擎默认值。保留模型连接、位置参数和未确认的保存值。',
  done: '已清除编辑草稿中的选项覆盖值。请保存预设以保留更改。',
  order: '请先检查已保存的选项顺序，再恢复默认值。',
};
export const runtimeDefaultsCopy = { en, ko, ja, zh };
