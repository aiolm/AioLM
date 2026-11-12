import type { Locale } from "./i18nCatalog.ts";
import english from "./locales/en.ts";

/** Synchronous panel namespace; loadLocale installs non-English data before rendering. */
export type PanelTextKey = keyof typeof english.panel;
export type PanelTextCatalog = Record<PanelTextKey, string>;
export const panelText: Record<Locale, PanelTextCatalog> = {
  en: english.panel, ko: english.panel, ja: english.panel, zh: english.panel,
};

export function assertPanelCatalogComplete(): void {
  for (const locale of ["en", "ko", "ja", "zh"] as const) {
    for (const key of Object.keys(english.panel) as PanelTextKey[]) {
      if (!panelText[locale][key]?.trim()) throw new Error(`Missing panel translation: ${locale}.${key}`);
    }
  }
}
