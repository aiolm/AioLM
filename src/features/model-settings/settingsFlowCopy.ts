const en = {
  journey: 'Runtime, profile and options', runtime: 'Choose runtime', profile: 'Choose profile', options: 'Adjust options',
  runtimeHint: 'An inference engine is the engine type; a runtime is an installed execution environment. Choose the engine and runtime to use.',
  profileHint: 'These profiles belong to the selected engine. Options are checked against the selected runtime build.',
  optionsHint: 'Adjust the model and options in the selected profile.',
  nextProfile: 'Continue to profile', nextOptions: 'Use this profile and adjust options',
  backRuntime: 'Back to runtime', backProfile: 'Back to profile', choose: 'Not selected',
  noRuntimes: 'No runtime is registered for this engine. Add or install one in runtime management.',
  backSettings: 'Return to model settings',
};
type Copy = { [K in keyof typeof en]: string };
const ko: Copy = {
  journey: '런타임, 프로필, 옵션 설정 순서', runtime: '런타임 선택', profile: '프로필 선택', options: '옵션 조정',
  runtimeHint: '추론 엔진은 엔진의 종류, 런타임은 설치된 실행 환경입니다. 사용할 엔진과 런타임을 선택하세요.',
  profileHint: '선택한 엔진의 프로필입니다. 옵션은 선택한 런타임 빌드를 기준으로 확인합니다.',
  optionsHint: '선택한 프로필의 모델과 옵션을 조정하세요.',
  nextProfile: '프로필 선택으로', nextOptions: '이 프로필로 옵션 조정',
  backRuntime: '런타임 선택으로 돌아가기', backProfile: '프로필 선택으로 돌아가기', choose: '선택하지 않음',
  noRuntimes: '이 엔진에 등록된 런타임이 없습니다. 추론 엔진 관리에서 추가하거나 설치하세요.',
  backSettings: '모델 설정으로 돌아가기',
};
const ja: Copy = {
  journey: 'ランタイム、プロファイル、オプションの設定順序', runtime: 'ランタイムを選択', profile: 'プロファイルを選択', options: 'オプションを調整',
  runtimeHint: '推論エンジンはエンジンの種類、ランタイムはインストール済みの実行環境です。使用するエンジンとランタイムを選択してください。',
  profileHint: '選択したエンジンのプロファイルです。オプションは選択したランタイムのビルドで確認します。',
  optionsHint: '選択したプロファイルのモデルとオプションを調整してください。',
  nextProfile: 'プロファイルの選択へ', nextOptions: 'このプロファイルでオプションを調整',
  backRuntime: 'ランタイムの選択に戻る', backProfile: 'プロファイルの選択に戻る', choose: '未選択',
  noRuntimes: 'このエンジンのランタイムは未登録です。推論エンジン管理で追加またはインストールしてください。',
  backSettings: 'モデル設定に戻る',
};
const zh: Copy = {
  journey: '运行时、预设和选项设置顺序', runtime: '选择运行时', profile: '选择预设', options: '调整选项',
  runtimeHint: '推理引擎是引擎类型，运行时是已安装的运行环境。请选择要使用的引擎和运行时。',
  profileHint: '这些预设属于所选引擎。选项会根据所选运行时版本进行检查。',
  optionsHint: '调整所选预设的模型和选项。',
  nextProfile: '继续选择预设', nextOptions: '使用此预设并调整选项',
  backRuntime: '返回运行时选择', backProfile: '返回预设选择', choose: '未选择',
  noRuntimes: '此引擎尚未注册运行时。请在推理引擎管理中添加或安装。',
  backSettings: '返回模型设置',
};
export const settingsFlowCopy = { en, ko, ja, zh };
