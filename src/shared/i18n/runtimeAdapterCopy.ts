export const runtimeAdapterCopy = {
  ko: {
    title: '외부 엔진 등록',
    hint: "제공자나 개발자가 준비한 완성된 등록 JSON을 가져옵니다. *.engine.json은 파일 이름의 예이며 앱이 자동 생성하는 파일이 아닙니다. 파일이 없다면 위에서 직접 등록하세요.",
    path: "등록 파일 경로 (manifest)", file: '파일 선택', register: '검사 후 등록',
    refreshError: "등록했지만 목록을 새로고침하지 못했습니다. 다시 등록하기 전에 목록을 새로고침하세요.",
    locked: '다른 작업을 마치고, 실행 중인 모델이 있으면 중지한 뒤 등록해 주세요.',
    capabilities: "AioLM은 추론 엔진이 아닌 GUI 어댑터이며, 지원 기능은 선택한 모델마다 확인합니다. 텍스트 스트리밍을 지원하는 연결된 엔진은 같은 API 벤치마크와 이력·내보내기·공유·관리를 사용합니다. 시간·출력 bytes는 클라이언트 관측값이며 토큰·캐시는 엔진 보고가 없으면 미확인입니다. 이 어댑터의 런타임 묶음 내보내기는 지원하지 않습니다.",
  },
  en: {
    title: 'Register external engine',
    hint: "Import a completed registration JSON prepared by a provider or developer. *.engine.json is an example filename; the app does not generate this file automatically. Without one, use manual registration above.",
    path: "Registration file path (manifest)", file: 'Choose file', register: 'Probe & register',
    refreshError: "Registered, but the list could not be refreshed. Refresh the list before registering again.",
    locked: 'Finish any other task and unload any running models before registering.',
    capabilities: "AioLM is a GUI adapter, not an inference engine; supported features are checked for each selected model. Connected text-streaming engines use the same API benchmark, history, exports, sharing and management. Timing and output bytes are client-observed; tokens and cache remain unknown unless reported by the engine. Portable runtime bundles remain unavailable with this adapter.",
  },
  ja: {
    title: '外部エンジンの登録',
    hint: "提供者や開発者が用意した完成済みの登録JSONを読み込みます。*.engine.jsonはファイル名の例で、アプリが自動生成するファイルではありません。なければ上で手動登録してください。",
    path: "登録ファイルのパス（manifest）", file: 'ファイルを選択', register: '検査して登録',
    refreshError: "登録しましたが一覧を更新できませんでした。再登録する前に一覧を更新してください。",
    locked: '他の作業を終え、実行中のモデルがあれば停止してから登録してください。',
    capabilities: "AioLM は推論エンジンではなく GUI アダプターで、対応機能は選択したモデルごとに確認します。接続済みのテキストストリーミングエンジンは同じ API ベンチマーク、履歴、書き出し、共有・管理を利用できます。時間と出力 bytes はクライアント観測値で、トークン・キャッシュはエンジンの報告がなければ不明です。このアダプターではランタイムの一括書き出しは利用できません。",
  },
  zh: {
    title: '注册外部引擎',
    hint: "导入提供方或开发者准备的完整注册JSON。*.engine.json只是文件名示例，应用不会自动生成此文件。没有文件时，请在上方手动注册。",
    path: "注册文件路径（manifest）", file: '选择文件', register: '检查并注册',
    refreshError: "已注册，但无法刷新列表。再次注册前请先刷新列表。",
    locked: '请先完成其他任务；如有正在运行的模型，请停止后再注册。',
    capabilities: "AioLM 是 GUI 适配器而非推理引擎，按所选模型检查支持的功能。已连接且支持文本流式输出的引擎使用相同的 API 基准测试、历史记录、导出及共享管理。时间和输出 bytes 为客户端观测值；引擎未报告的词元和缓存数据保持未知。此适配器仍不支持运行时打包导出。",
  },
};
