import type { Locale } from './i18nCatalog';

const en = {
  title: 'Run a model', setup: 'Execution setup', setupAction: 'Configure & run',
  hint: 'Choose a model, review its setup, and start it here.', remembered: 'Settings are remembered for each model.',
  runtime: 'Runtime', manageRuntime: 'Manage runtimes', back: 'Back to model', systemRuntime: 'System PATH runtime',
  runtimeMissing: 'This runtime is not installed. Install it or select another runtime.',
  runtimeError: 'Could not load runtimes or devices. Retry before starting.',
  details: 'Advanced settings', adapters: 'LoRA & vision', profiles: 'Execution profiles',
  quick: 'Context & GPU', selectFirst: 'Select a model to configure and run it.',
  switchTitle: 'Stop and switch model?', switchBody: 'The current server will stop. Review the selected model’s setup before starting it.', switchAction: 'Stop & select',
  unsavedTitle: 'Unsaved settings', unsavedBody: 'Save or discard your edits before continuing.', saveContinue: 'Save & continue', discardContinue: 'Discard & continue',
  invalidDraft: 'Some settings could not be saved. Correct the highlighted fields or discard the edits.',
  invalidNumber: 'Enter a number within the allowed range.', saving: 'Saving settings…', ready: 'Ready to start', restartHint: 'Server changes take effect after restart.',
  stopped: 'Stopped', starting: 'Starting', stopping: 'Stopping', running: 'Running', failed: 'Failed', crashed: 'Crashed',
};
type Copy = Record<keyof typeof en, string>;
export const executionText: Record<Locale, Copy> = {
  en,
  ko: {
    title: '모델 실행', setup: '실행 구성', setupAction: '설정 및 실행', hint: '모델을 선택하고 설정을 확인한 뒤 여기서 실행하세요.', remembered: '모델마다 마지막 설정을 기억합니다.',
    runtime: '런타임', manageRuntime: '런타임 관리', back: '모델로 돌아가기', systemRuntime: '시스템 PATH 런타임', runtimeMissing: '설치되지 않은 런타임입니다. 설치하거나 다른 런타임을 선택하세요.', runtimeError: '런타임 또는 장치 정보를 불러오지 못했습니다. 실행 전에 다시 시도하세요.',
    details: '상세 설정', adapters: 'LoRA·비전 설정', profiles: '실행 프로필', quick: '컨텍스트·GPU', selectFirst: '모델을 선택하면 실행 구성을 확인할 수 있습니다.',
    switchTitle: '중지 후 모델을 전환할까요?', switchBody: '현재 서버를 중지합니다. 선택한 모델의 설정을 확인한 뒤 실행하세요.', switchAction: '중지 후 선택',
    unsavedTitle: '저장하지 않은 설정', unsavedBody: '계속하기 전에 편집한 설정을 저장하거나 버리세요.', saveContinue: '저장 후 계속', discardContinue: '버리고 계속', invalidDraft: '일부 설정을 저장하지 못했습니다. 표시된 입력을 수정하거나 변경을 버리세요.',
    invalidNumber: '허용 범위 안의 숫자를 입력하세요.', saving: '설정 저장 중…', ready: '실행 준비', restartHint: '서버 설정 변경은 재시작 후 반영됩니다.', stopped: '중지됨', starting: '시작 중', stopping: '중지 중', running: '실행 중', failed: '실패', crashed: '비정상 종료',
  },
  ja: {
    title: 'モデル実行', setup: '実行設定', setupAction: '設定して実行', hint: 'モデルを選択し、設定を確認して実行します。', remembered: 'モデルごとに最後の設定を記憶します。',
    runtime: 'ランタイム', manageRuntime: 'ランタイム管理', back: 'モデルに戻る', systemRuntime: 'システム PATH ランタイム', runtimeMissing: 'ランタイムが未インストールです。インストールするか別のものを選択してください。', runtimeError: 'ランタイムまたはデバイスを取得できません。実行前に再試行してください。',
    details: '詳細設定', adapters: 'LoRA・ビジョン', profiles: '実行プロファイル', quick: 'コンテキスト・GPU', selectFirst: 'モデルを選択して実行設定を確認してください。', switchTitle: '停止してモデルを切り替えますか？', switchBody: '現在のサーバーを停止します。選択したモデルの設定を確認してから実行してください。', switchAction: '停止して選択',
    unsavedTitle: '未保存の設定', unsavedBody: '編集内容を保存または破棄して続行してください。', saveContinue: '保存して続行', discardContinue: '破棄して続行', invalidDraft: '一部の設定を保存できません。入力を修正するか変更を破棄してください。', invalidNumber: '許容範囲内の数値を入力してください。', saving: '設定を保存中…', ready: '実行準備完了', restartHint: 'サーバーの変更は再起動後に反映されます。', stopped: '停止', starting: '起動中', stopping: '停止中', running: '実行中', failed: '失敗', crashed: '異常終了',
  },
  zh: {
    title: '运行模型', setup: '运行配置', setupAction: '配置并运行', hint: '选择模型，检查配置，然后在此运行。', remembered: '记住每个模型的上次配置。',
    runtime: '运行时', manageRuntime: '管理运行时', back: '返回模型', systemRuntime: '系统 PATH 运行时', runtimeMissing: '尚未安装此运行时。请安装或选择其他运行时。', runtimeError: '无法加载运行时或设备。请在运行前重试。',
    details: '详细设置', adapters: 'LoRA 与视觉', profiles: '运行配置文件', quick: '上下文与 GPU', selectFirst: '选择模型以配置并运行。', switchTitle: '停止并切换模型？', switchBody: '将停止当前服务器。请检查所选模型的配置后再运行。', switchAction: '停止并选择',
    unsavedTitle: '未保存的设置', unsavedBody: '请保存或放弃编辑后继续。', saveContinue: '保存并继续', discardContinue: '放弃并继续', invalidDraft: '部分设置无法保存。请修正输入或放弃更改。', invalidNumber: '请输入允许范围内的数字。', saving: '正在保存设置…', ready: '准备运行', restartHint: '服务器设置将在重启后生效。', stopped: '已停止', starting: '正在启动', stopping: '正在停止', running: '运行中', failed: '失败', crashed: '异常退出',
  },
};
