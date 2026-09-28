import type { Locale } from '../i18n/i18n';
import { optionDefaultText } from '../i18n/optionDefaultText';
import { serverOptionsText } from '../i18n/serverOptionsI18n';
import { settingMetadataCopy } from '../i18n/settingMetadataCopy';
import { normalizeDisplayText } from '../lib/displayPaths';
import { REQUEST_DEFAULTS, serverDefault, type OptionDefault } from './optionDefaults';
import { SERVER_OPTIONS, type ServerOption } from './serverOptions';
import { serverAliasesForRequest } from './tuningDefaults';
import catalog from './tuningDefaultsCatalog.json';
import { defaultScalar } from './tuningResetValues';

const automatic = { en: 'automatic', ko: '자동 선택', ja: '自動選択', zh: '自动选择' };
const usage = {
  en: { app: 'using app default', runtime: 'using runtime default' },
  ko: { app: '앱 기본값 사용 중', runtime: '런타임 기본값 사용 중' },
  ja: { app: 'アプリの既定値を使用中', runtime: 'ランタイムの既定値を使用中' },
  zh: { app: '正在使用应用默认值', runtime: '正在使用运行时默认值' },
};
const compactCopy = {
  en: { badge: 'Default', reference: 'Default · ref.' },
  ko: { badge: '기본', reference: '기본·참고' },
  ja: { badge: '既定', reference: '既定·参照' },
  zh: { badge: '默认', reference: '默认·参考' },
};
type DefaultDisplay = { selected?: boolean; previousRuntime?: boolean; compact?: boolean };
export interface DefaultValueInfo { value: string; badge: string; description: string }

function label(defaults: OptionDefault, verified: boolean, locale: Locale, key?: string, selected = false): string {
  const copy = serverOptionsText[locale];
  if (selected && defaults.source !== 'command' && defaults.value === null) return `${usage[locale].runtime} (${copy.defaultUnknown})`;
  if (defaults.value === null) return `${copy.defaultValue}: ${defaults.source === 'command' ? copy.notApplicable : copy.defaultUnknown}`;
  const source = defaults.source === 'app' ? copy.defaultApp
    : verified && defaults.source === 'help' ? copy.inherited : `${copy.defaultValue} (${copy.defaultReference})`;
  const auto = /^auto$/i.test(defaults.value)
    || ((key === 'threads' || key === 'parallel') && /^-1(?:\b|$)/.test(defaults.value));
  const value = `${normalizeDisplayText(optionDefaultText(defaults.value, locale))}${auto ? ` (${automatic[locale]})` : ''}`;
  if (selected) {
    if (defaults.source === 'app') return `${value} (${usage[locale].app})`;
    if (verified && defaults.source === 'help') return `${value} (${usage[locale].runtime})`;
    // Inheritance is selected, but an unverified reference is not a confirmed active value.
    return `${usage[locale].runtime} (${settingMetadataCopy[locale].reference}: ${value})`;
  }
  return `${source}: ${value}`;
}

function info(defaults: OptionDefault, verified: boolean, locale: Locale, display: DefaultDisplay, key?: string): DefaultValueInfo {
  const scalar = defaultScalar(defaults.value);
  const value = defaults.value === null ? '—' : typeof scalar === 'number' ? String(scalar) : normalizeDisplayText(optionDefaultText(defaults.value, locale));
  const reference = defaults.value !== null && defaults.source !== 'app' && !(verified && defaults.source === 'help');
  return { value, badge: compactCopy[locale][reference ? 'reference' : 'badge'], description: label(defaults, verified, locale, key, display.selected) };
}

/** Compact text keeps provenance in the description for a badge's accessible label/title. */
export function serverDefaultInfo(option: ServerOption, options: readonly ServerOption[], verified: boolean, locale: Locale, display: DefaultDisplay = {}): DefaultValueInfo {
  // server.rs supplies these flags whenever no raw override is selected.
  if (display.selected) {
    const appValue = option.flags.some(flag => ['--webui', '--ui', '--no-webui', '--no-ui'].includes(flag)) ? 'disabled'
      : option.flags.some(flag => ['--cont-batching', '-cb', '--no-cont-batching', '-nocb'].includes(flag)) ? 'enabled' : null;
    if (appValue !== null) return info({ value: appValue, source: 'app' }, true, locale, display);
  }
  const defaults = serverDefault(option, options);
  if (defaults.value !== null || defaults.source === 'command') return info(defaults, verified, locale, display);
  const reference = SERVER_OPTIONS.find(item => item.flags.some(flag => option.flags.includes(flag)));
  return reference ? info(serverDefault(reference, SERVER_OPTIONS), false, locale, display) : info(defaults, verified, locale, display);
}

/** Read documented defaults rather than stale persisted numbers beneath an inheritance marker. */
export function settingDefaultInfo(key: string, options: readonly ServerOption[], verified: boolean, locale: Locale, display: DefaultDisplay = {}): DefaultValueInfo {
  const format = (defaults: OptionDefault, confirmed: boolean) => info(defaults, confirmed, locale, display, key);
  const field = catalog.find(field => field.key === key);
  if (field?.appDefault) return format({ value: String(field.resetValue), source: 'app' }, true);
  const aliases = serverAliasesForRequest(key);
  const matches = (option: ServerOption) => option.flags.some(flag => aliases.includes(flag));
  const current = !display.previousRuntime && verified ? options.find(matches) : undefined;
  if (current) {
    const defaults = serverDefault(current, options);
    if (defaults.value !== null) return format(defaults, true);
  }
  const reference = SERVER_OPTIONS.find(matches);
  if (reference) return format(serverDefault(reference, SERVER_OPTIONS), false);
  const request = REQUEST_DEFAULTS[key];
  return format(request ? { value: request.value, source: 'reference' } : { value: null, source: 'unknown' }, false);
}

export function serverDefaultLabel(option: ServerOption, options: readonly ServerOption[], verified: boolean, locale: Locale, display: DefaultDisplay = {}): string {
  const value = serverDefaultInfo(option, options, verified, locale, display);
  return display.compact ? `${value.value} · ${value.badge}` : value.description;
}

export function settingDefaultLabel(key: string, options: readonly ServerOption[], verified: boolean, locale: Locale, display: DefaultDisplay = {}): string {
  const value = settingDefaultInfo(key, options, verified, locale, display);
  return display.compact ? `${value.value} · ${value.badge}` : value.description;
}
