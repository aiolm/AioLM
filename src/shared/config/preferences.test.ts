import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { defaultPreferences, exportPreferences, importPreferences, loadPreferences, resetPreferences, savePreferences, validatePreferences, type AppPreferences } from "./preferences";
import { storedLocale } from '../i18n/i18nCatalog';

describe("preferences persistence", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it('starts in English on a clean installation regardless of the OS language', () => {
    vi.spyOn(navigator, 'language', 'get').mockReturnValue('ko-KR');
    expect(defaultPreferences().locale).toBe('en');
    expect(loadPreferences().locale).toBe('en');
    expect(storedLocale()).toBe('en');
  });

  it('preserves the saved language on upgrade and falls back to English for damaged preferences', () => {
    localStorage.setItem('aiolm-locale', 'ja');
    expect(loadPreferences().locale).toBe('ja');
    expect(storedLocale()).toBe('ja');
    localStorage.clear();
    localStorage.setItem('aiolm-preferences', '{broken');
    expect(loadPreferences().locale).toBe('en');
    expect(storedLocale()).toBe('en');
  });

  it('reports unavailable storage when completing initial setup', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    expect(() => savePreferences(defaultPreferences(), { required: true })).toThrow('storage unavailable');
    expect(() => savePreferences(defaultPreferences())).not.toThrow();
  });

  it('uses the former system locale only when requested for an existing installation', () => {
    expect(loadPreferences('ko').locale).toBe('ko');
    savePreferences({ ...defaultPreferences(), locale: 'ja' });
    expect(loadPreferences('ko').locale).toBe('ja');
  });

  it("round-trips validated preferences through versioned storage", () => {
    const values = { ...defaultPreferences(), locale: "ko" as const, theme: "dark" as const };
    savePreferences(values);
    expect(loadPreferences()).toMatchObject({ locale: "ko", theme: "dark" });
  });

  it("rejects unsupported export envelopes", () => {
    expect(() => importPreferences(JSON.stringify({ schemaVersion: 2, preferences: {} }))).toThrow(/Unsupported/);
  });
});

describe("typography and notification preferences", () => {
  beforeEach(() => localStorage.clear());

  it("starts with the shipped typography and every notification category off", () => {
    expect(loadPreferences()).toMatchObject({
      chat: { lineSpacing: "normal" },
      appearance: { fontFamily: "default", codeFontFamily: "default" },
      notifications: { chat: false, downloads: false, benchmark: false },
    });
  });

  it("upgrades version 1 preferences saved before these settings existed", () => {
    localStorage.setItem("aiolm-preferences", JSON.stringify({ version: 1, values: {
      locale: "ja", theme: "dark",
      chat: { enterToSend: false, showTimestamps: true, streamResponses: true, compactMessages: true },
      appearance: { reduceMotion: true, density: "compact" },
    } }));
    expect(loadPreferences()).toMatchObject({
      locale: "ja", theme: "dark",
      chat: { enterToSend: false, compactMessages: true, lineSpacing: "normal" },
      appearance: { reduceMotion: true, density: "compact", fontFamily: "default", codeFontFamily: "default" },
      notifications: { chat: false, downloads: false, benchmark: false },
    });
  });

  it("replaces unknown or mistyped values with defaults", () => {
    const d = defaultPreferences();
    const parsed = validatePreferences({
      ...d,
      chat: { ...d.chat, lineSpacing: "double" },
      appearance: { ...d.appearance, fontFamily: "Comic Sans MS", codeFontFamily: "serif" },
      notifications: { chat: "true", downloads: 1, benchmark: true },
    } as unknown as AppPreferences);
    expect(parsed.chat.lineSpacing).toBe("normal");
    expect(parsed.appearance).toMatchObject({ fontFamily: "default", codeFontFamily: "default" });
    expect(parsed.notifications).toEqual({ chat: false, downloads: false, benchmark: true });
    expect(validatePreferences({ notifications: "all" } as unknown as AppPreferences).notifications).toEqual(d.notifications);
    expect(validatePreferences({ notifications: null } as unknown as AppPreferences).notifications).toEqual(d.notifications);
  });

  it("persists, exports and imports the new settings", () => {
    const d = defaultPreferences();
    const values: AppPreferences = {
      ...d,
      chat: { ...d.chat, lineSpacing: "relaxed" },
      appearance: { ...d.appearance, fontFamily: "serif", codeFontFamily: "system" },
      notifications: { chat: true, downloads: false, benchmark: true },
    };
    savePreferences(values);
    expect(loadPreferences()).toEqual(values);
    expect(importPreferences(exportPreferences(values))).toEqual(values);
    expect(resetPreferences()).toEqual(d);
    expect(loadPreferences()).toEqual(d);
  });
});
