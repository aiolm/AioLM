import type { ThemeMode } from "./theme";
import { type Locale } from "../i18n/i18nCatalog";

export type ChatLineSpacing = "compact" | "normal" | "relaxed";
export type AppFontFamily = "default" | "system" | "serif";
export type CodeFontFamily = "default" | "system";
/** Which finished tasks may raise an operating-system notification. */
export interface NotificationPreferences { chat: boolean; downloads: boolean; benchmark: boolean }

export interface AppPreferences {
  locale: Locale;
  theme: ThemeMode;
  chat: { enterToSend: boolean; streamResponses: boolean; compactMessages: boolean; lineSpacing: ChatLineSpacing };
  server: { autoStart: boolean; pollIntervalMs: number };
  appearance: { reduceMotion: boolean; density: "comfortable" | "compact"; fontFamily: AppFontFamily; codeFontFamily: CodeFontFamily };
  advanced: { confirmDestructiveActions: boolean };
  notifications: NotificationPreferences;
  personalization: { instructionSources: { agents: boolean; aiolm: boolean } };
}

interface StoredPreferences { version: 1; values: AppPreferences }
const KEY = "aiolm-preferences";

export const defaultPreferences = (): AppPreferences => ({
  locale: "en", theme: "system",
  chat: { enterToSend: true, streamResponses: true, compactMessages: false, lineSpacing: "normal" },
  server: { autoStart: false, pollIntervalMs: 1000 },
  // "default" keeps the bundled typography the app shipped with.
  appearance: { reduceMotion: false, density: "comfortable", fontFamily: "default", codeFontFamily: "default" },
  advanced: { confirmDestructiveActions: true },
  // Off until the user opts in, so an upgrade never starts raising OS alerts.
  notifications: { chat: false, downloads: false, benchmark: false },
  personalization: { instructionSources: { agents: true, aiolm: true } },
});

const isLocale = (v: unknown): v is Locale => v === "ko" || v === "en" || v === "ja" || v === "zh";
const isTheme = (v: unknown): v is ThemeMode => v === "light" || v === "dark" || v === "system";
const oneOf = <T extends string>(values: readonly T[], v: unknown, fallback: T): T => values.includes(v as T) ? v as T : fallback;
const strictBool = (v: unknown, fallback: boolean): boolean => typeof v === "boolean" ? v : fallback;
/**
 * Removes one retired setting from a freshly built group copy. Other keys a
 * group carries, including ones this version does not know, stay untouched.
 */
const withoutRetired = <T extends object>(group: T, key: string): T => {
  delete (group as Record<string, unknown>)[key];
  return group;
};

export function validatePreferences(input: Partial<AppPreferences> | null | undefined): AppPreferences {
  const d = defaultPreferences();
  const p = input ?? {};
  return {
    locale: isLocale(p.locale) ? p.locale : d.locale,
    theme: isTheme(p.theme) ? p.theme : d.theme,
    // Retired settings from older saves or imports (timestamps, the frontend
    // unload hook, developer mode) are dropped so they cannot ride along into
    // state or future exports.
    chat: withoutRetired({ ...d.chat, ...(p.chat ?? {}), enterToSend: Boolean(p.chat?.enterToSend ?? d.chat.enterToSend), streamResponses: Boolean(p.chat?.streamResponses ?? d.chat.streamResponses), compactMessages: Boolean(p.chat?.compactMessages ?? d.chat.compactMessages), lineSpacing: oneOf(["compact", "normal", "relaxed"], p.chat?.lineSpacing, d.chat.lineSpacing) }, "showTimestamps"),
    server: withoutRetired({ ...d.server, ...(p.server ?? {}), autoStart: Boolean(p.server?.autoStart ?? d.server.autoStart), pollIntervalMs: [500, 1000, 2000, 5000].includes(Number(p.server?.pollIntervalMs)) ? Number(p.server?.pollIntervalMs) : d.server.pollIntervalMs }, "autoStopOnExit"),
    appearance: { ...d.appearance, ...(p.appearance ?? {}), reduceMotion: Boolean(p.appearance?.reduceMotion ?? d.appearance.reduceMotion), density: p.appearance?.density === "compact" ? "compact" : "comfortable", fontFamily: oneOf(["default", "system", "serif"], p.appearance?.fontFamily, d.appearance.fontFamily), codeFontFamily: oneOf(["default", "system"], p.appearance?.codeFontFamily, d.appearance.codeFontFamily) },
    advanced: withoutRetired({ ...d.advanced, ...(p.advanced ?? {}), confirmDestructiveActions: Boolean(p.advanced?.confirmDestructiveActions ?? d.advanced.confirmDestructiveActions) }, "developerMode"),
    // Built field by field: preferences saved before this group existed, or a
    // hand-edited import, can only enable a category with a real boolean.
    notifications: { chat: strictBool(p.notifications?.chat, d.notifications.chat), downloads: strictBool(p.notifications?.downloads, d.notifications.downloads), benchmark: strictBool(p.notifications?.benchmark, d.notifications.benchmark) },
    personalization: {
      instructionSources: {
        agents: strictBool(p.personalization?.instructionSources?.agents, d.personalization.instructionSources.agents),
        aiolm: strictBool(p.personalization?.instructionSources?.aiolm, d.personalization.instructionSources.aiolm),
      },
    },
  };
}

export function loadPreferences(fallbackLocale: Locale = 'en'): AppPreferences {
  const defaults = { ...defaultPreferences(), locale: fallbackLocale };
  if (typeof window === "undefined") return defaults;
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? "null") as StoredPreferences | null;
    if (raw?.version === 1) return validatePreferences({ ...raw.values, locale: isLocale(raw.values?.locale) ? raw.values.locale : fallbackLocale });
    const legacyTheme = window.localStorage.getItem("aiolm-theme");
    const legacyLocale = window.localStorage.getItem("aiolm-locale");
    return validatePreferences({
      theme: isTheme(legacyTheme) ? legacyTheme : "system",
      locale: isLocale(legacyLocale) ? legacyLocale : fallbackLocale,
    });
  } catch { return defaults; }
}

/**
 * Whether a destructive action should stop for confirmation.
 *
 * Read at click time rather than captured in a prop so every panel honours the
 * current setting without threading preferences through the whole tree.
 */
export function shouldConfirmDestructive(): boolean {
  return loadPreferences().advanced.confirmDestructiveActions;
}

export function savePreferences(values: AppPreferences, options: { required?: boolean } = {}): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ version: 1, values: validatePreferences(values) } satisfies StoredPreferences));
  } catch (error) {
    // Initial setup must not be marked complete if its preferences were lost.
    if (options.required) throw error;
  }
}
export function resetPreferences(): AppPreferences { const next = defaultPreferences(); savePreferences(next); return next; }

export function exportPreferences(values: AppPreferences): string {
  return JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), preferences: validatePreferences(values) }, null, 2);
}

export function importPreferences(raw: string): AppPreferences {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid settings export.");
  const envelope = parsed as { schemaVersion?: unknown; preferences?: unknown };
  if (envelope.schemaVersion !== 1 || !envelope.preferences || typeof envelope.preferences !== "object") throw new Error("Unsupported settings export format.");
  return validatePreferences(envelope.preferences as Partial<AppPreferences>);
}
