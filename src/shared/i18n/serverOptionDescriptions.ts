import type { ServerOption } from '../config/serverOptions';
import { SERVER_OPTIONS } from '../config/serverOptions';
import type { Locale } from './i18n';
import { serverOptionDescriptionCatalog } from './serverOptionDescriptionCatalog';

export const serverOptionDescriptions = serverOptionDescriptionCatalog;
const languageIndex = { ko: 0, ja: 1, zh: 2 } as const;
const missing: Record<Locale, string> = {
  en: 'This runtime option does not have a description. Use the displayed argument format and consult the runtime documentation for its behavior.',
  ko: '이 런타임 옵션의 번역된 설명은 아직 없습니다. 표시된 입력 형식을 사용하고, 동작은 해당 런타임 문서에서 확인하세요.',
  ja: 'このランタイムオプションには翻訳済みの説明がありません。表示された引数の形式を使い、動作はランタイムのドキュメントで確認してください。',
  zh: '此运行时选项尚无翻译说明。请使用显示的参数格式，并查阅该运行时文档以确认其行为。',
};

const aliases = new Map(SERVER_OPTIONS.flatMap(option => option.flags.map(flag => [flag, option.id] as const)));

/** Descriptions are display text; runtime signatures and argument values keep their protocol spelling. */
export function serverOptionDescription(option: ServerOption, locale: Locale): string {
  if (locale === 'en') return option.description.trim() || SERVER_OPTIONS.find(item => item.flags.some(flag => option.flags.includes(flag)))?.description.trim() || missing.en;
  const keys = [option.id, ...option.flags, ...option.flags.map(flag => aliases.get(flag) ?? '')];
  for (const key of keys) {
    const text = serverOptionDescriptions[key]?.[languageIndex[locale]];
    if (text) return text;
  }
  return missing[locale];
}
