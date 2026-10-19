const en = {
  journey: 'Runtime, profile and options', runtime: 'Choose runtime', profile: 'Choose profile', options: 'Adjust options',
  runtimeHint: 'Choose the inference engine and its installed runtime first.',
  profileHint: 'These profiles belong to the selected engine. Options are checked against the selected runtime build.',
  optionsHint: 'Adjust the model and options in the selected profile.',
  nextProfile: 'Continue to profile', nextOptions: 'Use this profile and adjust options',
  backRuntime: 'Back to runtime', backProfile: 'Back to profile', choose: 'Not selected',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  journey: '런타임, 프로필, 옵션 설정 순서', runtime: '런타임 선택', profile: '프로필 선택', options: '옵션 조정',
  runtimeHint: '먼저 추론 엔진과 설치된 런타임을 선택하세요.',
  profileHint: '선택한 엔진의 프로필입니다. 옵션은 선택한 런타임 빌드를 기준으로 확인합니다.',
  optionsHint: '선택한 프로필의 모델과 옵션을 조정하세요.',
  nextProfile: '프로필 선택으로', nextOptions: '이 프로필로 옵션 조정',
  backRuntime: '런타임 선택으로 돌아가기', backProfile: '프로필 선택으로 돌아가기', choose: '선택하지 않음',
};
const ja: Copy = {
  journey: 'ランタイム、プロファイル、オプションの設定順序', runtime: 'ランタイムを選択', profile: 'プロファイルを選択', options: 'オプションを調整',
  runtimeHint: '最初に推論エンジンとインストール済みランタイムを選択してください。',
  profileHint: '選択したエンジンのプロファイルです。オプションは選択したランタイムのビルドで確認します。',
  optionsHint: '選択したプロファイルのモデルとオプションを調整してください。',
  nextProfile: 'プロファイルの選択へ', nextOptions: 'このプロファイルでオプションを調整',
  backRuntime: 'ランタイムの選択に戻る', backProfile: 'プロファイルの選択に戻る', choose: '未選択',
};
const zh: Copy = {
  journey: '运行时、预设和选项设置顺序', runtime: '选择运行时', profile: '选择预设', options: '调整选项',
  runtimeHint: '首先选择推理引擎及其已安装的运行时。',
  profileHint: '这些预设属于所选引擎。选项会根据所选运行时版本进行检查。',
  optionsHint: '调整所选预设的模型和选项。',
  nextProfile: '继续选择预设', nextOptions: '使用此预设并调整选项',
  backRuntime: '返回运行时选择', backProfile: '返回预设选择', choose: '未选择',
};
export const settingsFlowCopy = { en, ko, ja, zh };
