import type { Locale } from "./i18nCatalog.ts";
import english from "./locales/en.ts";

/** Synchronous chat namespace; loadLocale installs non-English data before rendering. */
export type ChatTextKey = keyof typeof english.chat;
export type ChatTextCatalog = Record<ChatTextKey, string>;
export const chatText: Record<Locale, ChatTextCatalog> = {
  en: english.chat, ko: english.chat, ja: english.chat, zh: english.chat,
};

export function assertChatCatalogComplete(): void {
  for (const locale of ["en", "ko", "ja", "zh"] as const) {
    for (const key of Object.keys(english.chat) as ChatTextKey[]) {
      if (!chatText[locale][key]?.trim()) throw new Error(`Missing chat translation: ${locale}.${key}`);
    }
  }
}
