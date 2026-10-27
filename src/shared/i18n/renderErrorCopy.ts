import type { Locale } from './i18nCatalog';

export const renderErrorCopy = {
  en: { title: 'This screen could not be displayed', namedTitle: 'Could not display {screen}', hint: 'Try opening this screen again. If the problem continues, check any running work before closing and reopening AioLM.', retry: 'Try this screen again', details: 'Error details' },
  ko: { title: '화면을 표시하지 못했습니다', namedTitle: '{screen} 화면을 표시하지 못했습니다', hint: '아래 버튼으로 다시 시도하세요. 문제가 반복되면 실행 중인 작업을 확인한 뒤 AioLM을 닫고 다시 열어 주세요.', retry: '이 화면 다시 시도', details: '오류 내용' },
  ja: { title: '画面を表示できませんでした', namedTitle: '{screen}の画面を表示できませんでした', hint: '下のボタンで再試行してください。問題が続く場合は、実行中の作業を確認してからAioLMを閉じて開き直してください。', retry: 'この画面を再試行', details: 'エラーの詳細' },
  zh: { title: '无法显示此页面', namedTitle: '无法显示{screen}页面', hint: '请点击下方按钮重试。如果问题持续，请先检查正在运行的任务，再关闭并重新打开AioLM。', retry: '重试此页面', details: '错误详情' },
} satisfies Record<Locale, { title: string; namedTitle: string; hint: string; retry: string; details: string }>;
