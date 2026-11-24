import type { Locale } from "../i18n/i18n";

export interface ActivityCenterCopy {
  downloadsTitle: string;
  activeCount: (count: number) => string;
  pausedCount: (count: number) => string;
  activeSection: string;
  pausedSection: string;
  completedSection: string;
  failedSection: string;
  emptyDownloads: string;
  closePopover: string;
  configureAction: string;
  launchTitle: string;
  launchLoadingSingle: string;
  launchLoadingMulti: (count: number) => string;
  launchError: string;
  launchReady: string;
  launchEmpty: string;
  activityTitle: string;
  activityEmpty: string;
}

const copy: Record<Locale, ActivityCenterCopy> = {
  en: {
    downloadsTitle: "Downloads",
    activeCount: (count) => `${count} active`,
    pausedCount: (count) => `${count} paused`,
    activeSection: "Downloading",
    pausedSection: "Paused",
    completedSection: "Ready",
    failedSection: "Failed",
    emptyDownloads: "No active or paused downloads.",
    closePopover: "Close",
    configureAction: "Configure",
    launchTitle: "Model loading",
    launchLoadingSingle: "Loading",
    launchLoadingMulti: (count) => `Loading (${count})`,
    launchError: "Load failed",
    launchReady: "Ready",
    launchEmpty: "No model loads in progress.",
    activityTitle: "Activity & notices",
    activityEmpty: "No active tasks or notices.",
  },
  ko: {
    downloadsTitle: "다운로드",
    activeCount: (count) => `${count}개 받는 중`,
    pausedCount: (count) => `${count}개 일시중지`,
    activeSection: "다운로드 중",
    pausedSection: "일시중지됨",
    completedSection: "완료됨",
    failedSection: "실패",
    emptyDownloads: "진행 중이거나 일시중지된 다운로드가 없습니다.",
    closePopover: "닫기",
    configureAction: "설정",
    launchTitle: "모델 로딩",
    launchLoadingSingle: "로딩 중",
    launchLoadingMulti: (count) => `로딩 중 (${count})`,
    launchError: "로딩 실패",
    launchReady: "완료",
    launchEmpty: "진행 중인 모델 로딩이 없습니다.",
    activityTitle: "작업 및 알림",
    activityEmpty: "진행 중인 작업이나 알림이 없습니다.",
  },
  ja: {
    downloadsTitle: "ダウンロード",
    activeCount: (count) => `${count}件進行中`,
    pausedCount: (count) => `${count}件一時停止`,
    activeSection: "ダウンロード中",
    pausedSection: "一時停止中",
    completedSection: "完了",
    failedSection: "失敗",
    emptyDownloads: "進行中または一時停止中のダウンロードはありません。",
    closePopover: "閉じる",
    configureAction: "設定",
    launchTitle: "モデル読み込み",
    launchLoadingSingle: "読み込み中",
    launchLoadingMulti: (count) => `読み込み中 (${count})`,
    launchError: "読み込み失敗",
    launchReady: "完了",
    launchEmpty: "進行中のモデル読み込みはありません。",
    activityTitle: "アクティビティと通知",
    activityEmpty: "進行中のタスクや通知はありません。",
  },
  zh: {
    downloadsTitle: "下载",
    activeCount: (count) => `${count} 项进行中`,
    pausedCount: (count) => `${count} 项已暂停`,
    activeSection: "下载中",
    pausedSection: "已暂停",
    completedSection: "已完成",
    failedSection: "失败",
    emptyDownloads: "没有进行中或已暂停的下载。",
    closePopover: "关闭",
    configureAction: "配置",
    launchTitle: "模型加载",
    launchLoadingSingle: "正在加载",
    launchLoadingMulti: (count) => `正在加载 (${count})`,
    launchError: "加载失败",
    launchReady: "就绪",
    launchEmpty: "当前没有模型加载任务。",
    activityTitle: "活动与通知",
    activityEmpty: "当前没有进行中的任务或通知。",
  },
};

export const activityCenterCopy = (locale: Locale): ActivityCenterCopy => copy[locale];
