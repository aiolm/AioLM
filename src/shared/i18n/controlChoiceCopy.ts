/** Labels for choosing one way to edit a setting, without changing its stored value. */
export const controlChoiceCopy = {
  en: {
    editor: 'Edit options', guided: 'Individual options', direct: 'Enter arguments directly',
    fixBeforeSwitch: 'Correct the highlighted input before changing editing mode. Your input is kept here.',
    draftMode: 'Draft model device', deviceList: 'Choose a detected GPU', deviceManual: 'Enter device names',
    draftDevice: 'Draft device names', draftDeviceHint: 'Enter engine device names, separated by commas, or none for CPU. An empty value uses the GPU selected in device selection mode.',
    scope: 'Settings to restore', all: 'All app preferences', chat: 'Chat display', server: 'Server behavior', appearance: 'Appearance and theme', advanced: 'Advanced preferences', notifications: 'Notifications',
    resetHint: 'Only the selected app preferences will return to their defaults. Engine profiles, conversation instructions, conversations, projects, and personal instructions are kept.',
  },
  ko: {
    editor: '옵션 입력 방식', guided: '옵션별로 조정', direct: '실행 인자 직접 입력',
    fixBeforeSwitch: '잘못 입력한 값을 먼저 수정해 주세요. 입력 내용은 현재 화면에 보관됩니다.',
    draftMode: '드래프트 모델 실행 장치', deviceList: '감지된 GPU에서 선택', deviceManual: '장치 이름 직접 입력',
    draftDevice: '드래프트 장치 이름', draftDeviceHint: '엔진의 장치 이름을 쉼표로 구분해 입력하세요. CPU는 none으로 지정합니다. 비우면 장치 선택 모드의 GPU 설정을 사용합니다.',
    scope: '기본값으로 되돌릴 설정', all: '앱 환경설정 전체', chat: '채팅 표시', server: '서버 동작', appearance: '화면과 테마', advanced: '고급 환경설정', notifications: '알림',
    resetHint: '선택한 앱 환경설정만 기본값으로 되돌립니다. 엔진 프로필, 대화 지침, 대화, 프로젝트, 개인화 지침은 유지합니다.',
  },
  ja: {
    editor: 'オプションの入力方法', guided: '項目ごとに調整', direct: '起動引数を直接入力',
    fixBeforeSwitch: '入力方法を変える前に、不正な値を修正してください。入力内容はこの画面に保持されます。',
    draftMode: 'ドラフトモデルの実行デバイス', deviceList: '検出したGPUから選択', deviceManual: 'デバイス名を直接入力',
    draftDevice: 'ドラフトのデバイス名', draftDeviceHint: 'エンジンのデバイス名をカンマで区切ります。CPUはnone、空欄はデバイス選択で指定したGPUを使います。',
    scope: '既定値に戻す設定', all: 'アプリ環境設定全体', chat: 'チャット表示', server: 'サーバー動作', appearance: '画面とテーマ', advanced: '詳細環境設定', notifications: '通知',
    resetHint: '選んだアプリ環境設定だけを既定値に戻します。エンジンプロファイル、会話指示、会話、プロジェクト、個人設定の指示は保持します。',
  },
  zh: {
    editor: '选项输入方式', guided: '逐项调整', direct: '直接输入启动参数',
    fixBeforeSwitch: '请先修正无效值，再切换输入方式。输入内容会保留在当前界面。',
    draftMode: '草稿模型运行设备', deviceList: '选择已检测到的GPU', deviceManual: '直接输入设备名称',
    draftDevice: '草稿设备名称', draftDeviceHint: '以逗号分隔引擎的设备名称。CPU使用none，留空则使用设备选择模式中的GPU设置。',
    scope: '要恢复默认值的设置', all: '全部应用偏好', chat: '聊天显示', server: '服务器行为', appearance: '外观和主题', advanced: '高级偏好', notifications: '通知',
    resetHint: '仅恢复所选应用偏好的默认值。引擎配置、对话指令、对话、项目和个性化指令均会保留。',
  },
} as const;
