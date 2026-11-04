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

describe("personalization instruction source preferences", () => {
  beforeEach(() => localStorage.clear());

  it("enables both instruction sources for clean installs and existing version 1 settings", () => {
    expect(defaultPreferences().personalization).toEqual({ instructionSources: { agents: true, aiolm: true } });
    expect(loadPreferences().personalization).toEqual({ instructionSources: { agents: true, aiolm: true } });

    localStorage.setItem("aiolm-preferences", JSON.stringify({ version: 1, values: {
      locale: "ja", theme: "dark",
      chat: { enterToSend: false, streamResponses: false, compactMessages: true, lineSpacing: "relaxed" },
    } }));
    expect(loadPreferences()).toMatchObject({
      locale: "ja", theme: "dark",
      chat: { enterToSend: false, streamResponses: false, compactMessages: true, lineSpacing: "relaxed" },
      personalization: { instructionSources: { agents: true, aiolm: true } },
    });

    const imported = importPreferences(JSON.stringify({ schemaVersion: 1, preferences: { locale: "ko", theme: "light" } }));
    expect(imported).toMatchObject({
      locale: "ko", theme: "light",
      personalization: { instructionSources: { agents: true, aiolm: true } },
    });
  });

  it.each([
    { agents: true, aiolm: true },
    { agents: true, aiolm: false },
    { agents: false, aiolm: true },
    { agents: false, aiolm: false },
  ])("preserves agents=$agents and aiolm=$aiolm through storage and backup roundtrips", (instructionSources) => {
    const values: AppPreferences = { ...defaultPreferences(), personalization: { instructionSources } };
    savePreferences(values);
    expect(loadPreferences()).toEqual(values);
    expect(JSON.parse(localStorage.getItem("aiolm-preferences")!).version).toBe(1);

    const backup = exportPreferences(loadPreferences());
    expect(JSON.parse(backup).schemaVersion).toBe(1);
    const imported = importPreferences(backup);
    expect(imported).toEqual(values);
    localStorage.clear();
    savePreferences(imported);
    expect(loadPreferences()).toEqual(values);
  });

  it("restores both sources when resetting preferences", () => {
    savePreferences({ ...defaultPreferences(), personalization: { instructionSources: { agents: false, aiolm: false } } });
    expect(resetPreferences().personalization).toEqual({ instructionSources: { agents: true, aiolm: true } });
    expect(loadPreferences().personalization).toEqual({ instructionSources: { agents: true, aiolm: true } });
  });

  it.each([
    { name: "absent group", personalization: undefined, expected: { agents: true, aiolm: true } },
    { name: "null group", personalization: null, expected: { agents: true, aiolm: true } },
    { name: "string group", personalization: "disabled", expected: { agents: true, aiolm: true } },
    { name: "missing sources", personalization: {}, expected: { agents: true, aiolm: true } },
    { name: "null sources", personalization: { instructionSources: null }, expected: { agents: true, aiolm: true } },
    { name: "boolean sources", personalization: { instructionSources: false }, expected: { agents: true, aiolm: true } },
    { name: "missing aiolm", personalization: { instructionSources: { agents: false } }, expected: { agents: false, aiolm: true } },
    { name: "missing agents", personalization: { instructionSources: { aiolm: false } }, expected: { agents: true, aiolm: false } },
    { name: "string agents", personalization: { instructionSources: { agents: "false", aiolm: false } }, expected: { agents: true, aiolm: false } },
    { name: "string aiolm", personalization: { instructionSources: { agents: false, aiolm: "false" } }, expected: { agents: false, aiolm: true } },
    { name: "numeric agents", personalization: { instructionSources: { agents: 0, aiolm: false } }, expected: { agents: true, aiolm: false } },
    { name: "numeric aiolm", personalization: { instructionSources: { agents: false, aiolm: 0 } }, expected: { agents: false, aiolm: true } },
    { name: "null fields", personalization: { instructionSources: { agents: null, aiolm: null } }, expected: { agents: true, aiolm: true } },
    { name: "object fields", personalization: { instructionSources: { agents: {}, aiolm: [] } }, expected: { agents: true, aiolm: true } },
  ])("defaults malformed $name without replacing valid false selections", ({ personalization, expected }) => {
    const values = { personalization } as unknown as AppPreferences;
    expect(validatePreferences(values).personalization).toEqual({ instructionSources: expected });

    localStorage.setItem("aiolm-preferences", JSON.stringify({ version: 1, values }));
    expect(loadPreferences().personalization).toEqual({ instructionSources: expected });
    expect(importPreferences(JSON.stringify({ schemaVersion: 1, preferences: values })).personalization).toEqual({ instructionSources: expected });
  });

  it("stores and exports only source booleans, not instruction paths or contents", () => {
    const values = {
      ...defaultPreferences(),
      personalization: {
        instructionSources: { agents: false, aiolm: true, path: "/example/AGENTS.md", contents: "private instruction body" },
        path: "/example/AGENTS.md",
        contents: "private instruction body",
      },
    } as unknown as AppPreferences;
    const expected = { instructionSources: { agents: false, aiolm: true } };
    savePreferences(values);
    expect(JSON.parse(localStorage.getItem("aiolm-preferences")!).values.personalization).toEqual(expected);
    expect(JSON.parse(exportPreferences(values)).preferences.personalization).toEqual(expected);
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

  it("drops only retired preferences from older saves and imports, keeping real choices and unrelated keys", () => {
    // Synthetic export written before the frontend unload hook, the developer
    // mode switch, and the timestamp switch were retired. The extra* keys stand
    // in for backup data this version does not know about.
    const legacy = JSON.stringify({ schemaVersion: 1, preferences: {
      locale: "ko", theme: "dark",
      chat: { enterToSend: false, showTimestamps: true, streamResponses: false, extraChat: "kept" },
      server: { autoStart: true, autoStopOnExit: true, pollIntervalMs: 2000, extraServer: { nested: 1 } },
      advanced: { developerMode: true, confirmDestructiveActions: false, extraAdvanced: true },
    } });
    const retired = (values: AppPreferences) => [
      "showTimestamps" in values.chat, "autoStopOnExit" in values.server, "developerMode" in values.advanced,
    ];
    const kept = (values: AppPreferences) => {
      expect(values.chat).toMatchObject({ enterToSend: false, streamResponses: false, extraChat: "kept" });
      expect(values.server).toMatchObject({ autoStart: true, pollIntervalMs: 2000, extraServer: { nested: 1 } });
      expect(values.advanced).toMatchObject({ confirmDestructiveActions: false, extraAdvanced: true });
      expect(retired(values)).toEqual([false, false, false]);
    };

    const imported = importPreferences(legacy);
    kept(imported);
    kept(importPreferences(exportPreferences(imported)));

    localStorage.setItem("aiolm-preferences", JSON.stringify({ version: 1, values: JSON.parse(legacy).preferences }));
    kept(loadPreferences());
    savePreferences(loadPreferences());
    kept(JSON.parse(localStorage.getItem("aiolm-preferences")!).values);
  });
});
