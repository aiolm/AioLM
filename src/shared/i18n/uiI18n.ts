import type { Locale } from "./i18nCatalog.ts";
import english from "./locales/en.ts";

/** Synchronous ui namespace; loadLocale installs non-English data before rendering. */
export type UiTextKey = keyof typeof english.ui;
export type UiTextCatalog = Record<UiTextKey, string>;
export const uiText: Record<Locale, UiTextCatalog> = {
  en: english.ui, ko: english.ui, ja: english.ui, zh: english.ui,
};

export function assertUiCatalogComplete(): void {
  for (const locale of ["en", "ko", "ja", "zh"] as const) {
    for (const key of Object.keys(english.ui) as UiTextKey[]) {
      if (!uiText[locale][key]?.trim()) throw new Error(`Missing ui translation: ${locale}.${key}`);
    }
  }
}
