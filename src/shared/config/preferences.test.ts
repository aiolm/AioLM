import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { defaultPreferences, importPreferences, loadPreferences, savePreferences } from "./preferences";
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
