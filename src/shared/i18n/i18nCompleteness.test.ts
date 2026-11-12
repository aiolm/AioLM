// @vitest-environment node
import { describe, expect, it } from "vitest";
import { messages, type Locale } from "./i18nCatalog";
import { uiText } from "./uiI18n";
import { panelText } from "./panelI18n";
import { extraText } from "./extraI18n";
import { chatText } from "./chatI18n";
import { loadLocale } from "./i18nUnified";
import { untranslated } from "./untranslated";

const catalogs: Record<keyof typeof untranslated.ja, Record<Locale, Record<string, string>>> = {
  messages, ui: uiText, panel: panelText, extra: extraText, chat: chatText,
};

describe("acknowledged English locale fallbacks", () => {
  for (const locale of ["ja", "zh"] as const) {
    it(`keeps the ${locale} untranslated-key lists complete and honest`, async () => {
      await loadLocale(locale);
      const problems: string[] = [];
      const report: string[] = [];
      for (const namespace of Object.keys(catalogs).sort() as (keyof typeof catalogs)[]) {
        const catalog = catalogs[namespace];
        const listed = [...untranslated[locale][namespace]].sort();
        const acknowledged = new Set<string>(listed);
        const actual = Object.keys(catalog.en).filter(key => (catalog[locale][key] ?? catalog.en[key]) === catalog.en[key]).sort();
        const actualKeys = new Set(actual);
        const unlisted = actual.filter(key => !acknowledged.has(key));
        const stale = listed.filter(key => !actualKeys.has(key));
        if (unlisted.length) problems.push(`${locale}.${namespace} unlisted English values: ${unlisted.join(", ")}`);
        if (stale.length) problems.push(`${locale}.${namespace} translated or unknown listed keys: ${stale.join(", ")}`);
        report.push(`${locale}.${namespace}: ${listed.length} acknowledged English values (${listed.join(", ")})`);
      }
      expect(problems, [...report, ...problems].join("\n")).toEqual([]);
    });
  }
});
