import { createContext, createElement, Suspense, use, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { SurfaceLoading } from "../ui/InitialSurface";
import { storedLocale, type Locale } from "./i18nCatalog";
import { isLocaleLoaded, loadLocale, translate, type TranslationVars, type UnifiedKey } from "./i18nUnified";

/**
 * React context wrapping the i18n catalogs: exposes the current `Locale` and a
 * `t()` bound to `i18nUnified.ts`'s `translate()`. Base app-chrome keys
 * (`i18nCatalog.ts`) are unprefixed; panel, extra, chat, and ui-domain strings
 * use the `panel.`, `extra.`, `chat.`, `ui.` namespaces respectively. Code
 * outside React that only has a `Locale` should call `translate()` directly.
 */

interface I18nValue { locale: Locale; setLocale: (locale: Locale) => void; t: (key: UnifiedKey, vars?: TranslationVars) => string; }
const I18nContext = createContext<I18nValue | null>(null);

function LocaleContent({ value, children }: { value: I18nValue; children: ReactNode }) {
  if (!isLocaleLoaded(value.locale)) use(loadLocale(value.locale));
  return createElement(I18nContext.Provider, { value }, children);
}

export function I18nProvider({ initialLocale, onLocaleChange, children }: { initialLocale?: Locale; onLocaleChange?: (locale: Locale) => void; children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(() => initialLocale ?? storedLocale());
  const request = useRef(0);
  const [loadError, setLoadError] = useState<{ cause: unknown } | null>(null);
  const setLocale = useCallback((next: Locale) => {
    const current = ++request.current;
    const commit = () => {
      if (current !== request.current) return;
      setLocaleState(next);
      onLocaleChange?.(next);
    };
    if (isLocaleLoaded(next)) commit();
    else void loadLocale(next).then(commit, (cause: unknown) => {
      if (current === request.current) setLoadError(cause ? { cause } : null);
    });
  }, [onLocaleChange]);
  const value = useMemo<I18nValue>(() => ({ locale, setLocale, t: (key, vars) => translate(locale, key, vars) }), [locale, setLocale]);
  if (loadError) throw loadError.cause;
  return createElement(Suspense, { fallback: createElement(SurfaceLoading) }, createElement(LocaleContent, { value, children }));
}
export function useI18n(): I18nValue { const value = useContext(I18nContext); if (!value) throw new Error("useI18n must be used inside I18nProvider"); return value; }
export { detectLocale, intlLocales, messages, localeOptions } from "./i18nCatalog";
export type { Locale, TranslationKey } from "./i18nCatalog";
export { loadLocale, translate } from "./i18nUnified";
export type { UnifiedKey, TranslationVars } from "./i18nUnified";
