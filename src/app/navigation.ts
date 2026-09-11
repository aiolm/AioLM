import type { UnifiedKey } from '../shared/i18n/i18nUnified';
import type { Locale } from '../shared/i18n/i18nCatalog';
import type { ViewId } from '../shared/types/navigation';
export type { ViewId } from '../shared/types/navigation';
type GroupId = 'workspace' | 'models' | 'execution' | 'integrations' | 'tools';
export interface NavigationItem { id: ViewId; label: UnifiedKey; icon: string }
export const navigationGroups: { id: GroupId; items: NavigationItem[] }[] = [
 { id: 'workspace', items: [
  { id: 'chat', label: 'tab.chat', icon: 'M5 4h14v12H9l-4 4V4Z M9 8h6M9 12h4' },
  { id: 'projects', label: 'section.projects', icon: 'M3 7h7l2-3h9v16H3V7Z M3 9h18' },
 ] },
 { id: 'models', items: [
  { id: 'models', label: 'section.library', icon: 'm12 3 9 5-9 5-9-5 9-5Z M3 12l9 5 9-5M3 16l9 5 9-5' },
  { id: 'discover', label: 'section.discover', icon: 'M21 21l-5-5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z' },
 ] },
 { id: 'execution', items: [
  { id: 'sessions', label: 'ui.sessionsTitle', icon: 'M4 5h16v14H4V5Z m6 4 5 3-5 3V9Z' },
  { id: 'runtimes', label: 'section.runtimes', icon: 'M6 6h12v12H6V6Z M9 1v5M15 1v5M9 18v5M15 18v5M1 9h5M1 15h5M18 9h5M18 15h5' },
  { id: 'benchmark', label: 'section.benchmark', icon: 'M4 3v17h17M8 16v-5M13 16V7M18 16V4' },
 ] },
 { id: 'integrations', items: [
  { id: 'api', label: 'section.api', icon: 'm8 6-6 6 6 6m8-12 6 6-6 6M14 3l-4 18' },
  { id: 'gateways', label: 'section.gateways', icon: 'M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4' },
  { id: 'mcp', label: 'section.mcp', icon: 'M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0V8Zm6 10v4' },
 ] },
 { id: 'tools', items: [
  { id: 'diagnostics', label: 'section.diagnostics', icon: 'M3 12h4l3-8 4 16 3-8h4' },
  { id: 'settings', label: 'tab.settings', icon: 'M4 5h16M4 12h16M4 19h16M8 2v6M16 9v6M10 16v6' },
 ] },
];
export const navigationText: Record<Locale, Record<GroupId | 'openMenu' | 'closeMenu' | 'local', string>> = {
 en: { workspace: 'Workspace', models: 'Models', execution: 'Run & optimize', integrations: 'Integrations', tools: 'Tools', openMenu: 'Open navigation', closeMenu: 'Close navigation', local: 'Your local AI workspace' },
 ko: { workspace: '작업 공간', models: '모델 관리', execution: '실행·성능', integrations: '외부 연동', tools: '공통 도구', openMenu: '메뉴 열기', closeMenu: '메뉴 닫기', local: '나의 로컬 AI 작업 공간' },
 ja: { workspace: 'ワークスペース', models: 'モデル管理', execution: '実行・最適化', integrations: '外部連携', tools: 'ツール', openMenu: 'メニューを開く', closeMenu: 'メニューを閉じる', local: 'ローカル AI ワークスペース' },
 zh: { workspace: '工作空间', models: '模型管理', execution: '运行与优化', integrations: '外部集成', tools: '工具', openMenu: '打开菜单', closeMenu: '关闭菜单', local: '本地 AI 工作空间' },
};
