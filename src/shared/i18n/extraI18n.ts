import type { Locale } from "./i18nCatalog.ts";
import english from "./locales/en.ts";

/** Synchronous extra namespace; loadLocale installs non-English data before rendering. */
export type ExtraTextKey = keyof typeof english.extra;
export type ExtraTextCatalog = Record<ExtraTextKey, string>;
export const extraText: Record<Locale, ExtraTextCatalog> = {
  en: english.extra, ko: english.extra, ja: english.extra, zh: english.extra,
};

export function assertExtraCatalogComplete(): void {
  for (const locale of ["en", "ko", "ja", "zh"] as const) {
    for (const key of Object.keys(english.extra) as ExtraTextKey[]) {
      if (!extraText[locale][key]?.trim()) throw new Error(`Missing extra translation: ${locale}.${key}`);
    }
  }
}
