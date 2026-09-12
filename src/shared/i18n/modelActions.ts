import type { Locale } from './i18n';
const copy = {
  en: { choose: 'Choose model', settings: 'Model settings', resume: 'Return to model settings', configure: 'Configure and run', current: 'Running model', next: 'Selected for next run', stopSessions: 'Stop model sessions', sessionsHint: 'Stop these model sessions before benchmarking:', sessionsError: 'Model session status could not be loaded.', retry: 'Retry', importDefault: 'Use default execution settings', defaultScope: 'Default execution' },
  ko: { choose: '모델 선택', settings: '모델 설정', resume: '모델 설정으로 돌아가기', configure: '설정하고 실행', current: '실행 중인 모델', next: '다음 실행 모델', stopSessions: '모델 세션 중지', sessionsHint: '벤치마크를 시작하기 전에 다음 모델 세션을 중지해 주세요:', sessionsError: '모델 세션 상태를 불러오지 못했습니다.', retry: '다시 시도', importDefault: '기본 실행 설정 불러오기', defaultScope: '기본 실행' },
  ja: { choose: 'モデルを選択', settings: 'モデル設定', resume: 'モデル設定に戻る', configure: '設定して実行', current: '実行中のモデル', next: '次回の実行モデル', stopSessions: 'モデルセッションを停止', sessionsHint: 'ベンチマーク前に次のセッションを停止してください:', sessionsError: 'セッション状態を取得できませんでした。', retry: '再試行', importDefault: '既定の実行設定を読み込む', defaultScope: '既定の実行' },
  zh: { choose: '选择模型', settings: '模型设置', resume: '返回模型设置', configure: '设置并运行', current: '正在运行的模型', next: '下次运行的模型', stopSessions: '停止模型会话', sessionsHint: '基准测试前请停止以下模型会话：', sessionsError: '无法加载模型会话状态。', retry: '重试', importDefault: '载入默认运行设置', defaultScope: '默认运行' },
};
export const modelActions = (locale: Locale) => copy[locale];
