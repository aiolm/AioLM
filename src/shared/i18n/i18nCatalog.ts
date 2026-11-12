import english from "./locales/en.ts";

/** Locale detection and the synchronous base app-chrome catalog. */
export type Locale = "ko" | "en" | "ja" | "zh";
export const intlLocales: Record<Locale, string> = { ko: "ko-KR", en: "en-US", ja: "ja-JP", zh: "zh-CN" };
export type TranslationKey = keyof typeof english.messages;
type MessageCatalog = Record<TranslationKey, string>;

// loadLocale replaces a locale atomically before the provider publishes it.
export const messages: Record<Locale, MessageCatalog> = {
  en: english.messages, ko: english.messages, ja: english.messages, zh: english.messages,
};

export function detectLocale(): Locale { const value = typeof navigator === "undefined" ? "en" : navigator.language.toLowerCase(); return value.startsWith("ko") ? "ko" : value.startsWith("ja") ? "ja" : value.startsWith("zh") ? "zh" : "en"; }
export function storedLocale(): Locale { try { const legacy = window.localStorage.getItem("aiolm-locale"); if (legacy === "ko" || legacy === "ja" || legacy === "zh" || legacy === "en") return legacy; const raw = JSON.parse(window.localStorage.getItem("aiolm-preferences") ?? "null") as { values?: { locale?: unknown } } | null; const value = raw?.values?.locale; return value === "ko" || value === "ja" || value === "zh" || value === "en" ? value : "en"; } catch { return "en"; } }
export const localeOptions: { value: Locale; label: string }[] = [{ value: "ko", label: "한국어" }, { value: "en", label: "English" }, { value: "ja", label: "日本語" }, { value: "zh", label: "简体中文" }];
