import { useI18n } from '../../shared/i18n/i18n';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { changedSettings } from '../../shared/config/settingsProfiles';
import { helpDefault } from '../../shared/config/optionDefaults';
import type { ServerOption } from '../../shared/config/serverOptions';
import { serverAliasesForRequest } from '../../shared/config/tuningDefaults';
import tuningDefaultsCatalog from '../../shared/config/tuningDefaultsCatalog.json';
import { optionDefaultText } from '../../shared/i18n/optionDefaultText';
import { normalizeDisplayPath } from '../../shared/lib/displayPaths';
import { profileControlCopy, profileFieldLabel } from './profileControlCopy';

const appDefaults = new Map(tuningDefaultsCatalog.filter(field => field.appDefault).map(field => [field.key, field.resetValue]));

function inheritedValue(key: string, options: readonly ServerOption[], verified: boolean,
  previousRuntime: boolean, locale: keyof typeof profileControlCopy): string {
  const copy = profileControlCopy[locale];
  const appValue = appDefaults.get(key);
  if (appValue !== undefined) return `${copy.appDefault}: ${appValue}`;
  if (previousRuntime) return copy.previousRuntimeDefaultUnknown;
  if (!verified) return copy.runtimeDefaultUnknown;
  const aliases = serverAliasesForRequest(key);
  const option = options.find(item => item.flags.some(flag => aliases.includes(flag)));
  const documented = option && helpDefault(option.description);
  if (documented === null || documented === undefined) return copy.runtimeDefaultUnknown;
  const value = optionDefaultText(documented, locale);
  const automatic = ((key === 'threads' || key === 'parallel') && /^-1(?:\b|$)/.test(documented))
    || /^auto$/i.test(documented);
  return `${copy.runtimeDefault}: ${value}${automatic ? ` (${copy.automatic})` : ''}`;
}

/** Renders a stored value the way the profile detail panel does, so the same
 *  value reads identically wherever it is shown. */
export function valueRenderer(locale: keyof typeof profileControlCopy) {
  const copy = profileControlCopy[locale];
  const render = (value: unknown): string => {
    if (value == null || value === '') return copy.empty;
    if (typeof value === 'boolean') return value ? copy.on : copy.off;
    if (Array.isArray(value)) return value.length ? value.map(render).join(', ') : copy.empty;
    if (typeof value === 'object') return Object.entries(value).map(([key, child]) => `${profileFieldLabel(key, locale)}: ${render(child)}`).join(' · ') || copy.empty;
    return String(value);
  };
  return render;
}

/** How many option rows a save would show, counting the prompt as one. */
export function changeCount(saved: Partial<ExecutionSettings>, current: Partial<ExecutionSettings>, savedPrompt: string, currentPrompt: string): number {
  return changedSettings(saved, current).length + (savedPrompt === currentPrompt ? 0 : 1);
}

/**
 * What a save is about to rewrite.
 *
 * A profile is a wide snapshot and the editor gives no sense of how much of it an
 * edit touched, so the save is confirmed against this list rather than taken on
 * trust. Each row names the setting and the value it goes from and to.
 */
export default function SettingsChangeList({ saved, current, savedPrompt, currentPrompt, runtimeOptions, runtimeVerified }: {
  saved: Partial<ExecutionSettings>; current: Partial<ExecutionSettings>; savedPrompt: string; currentPrompt: string;
  runtimeOptions: readonly ServerOption[]; runtimeVerified: boolean;
}) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
  const render = valueRenderer(locale);
  const renderChange = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? '{}' : render(value);
  const changes = changedSettings(saved, current);
  const runtimeChanged = saved.active_backend !== current.active_backend || saved.active_build !== current.active_build;
  const promptChanged = savedPrompt !== currentPrompt;
  const row = (key: string, label: string, before: string, after: string) => <div key={key}>
    <dt>{label}</dt>
    <dd><span className="settings-profile-change-before">{before}</span>
      <span className="settings-profile-change-arrow" aria-hidden="true">→</span><span className="sr-only"> {copy.changeTo} </span>
      <span className="settings-profile-change-after">{after}</span></dd>
  </div>;
  return <dl className="settings-profile-changes">
    {changes.map(change => row(change.path ? JSON.stringify(change.path) : change.key,
      (change.path ?? change.key.split('.')).map((key, index) => {
        if (index === 1 && change.path?.[0] === 'lora_adapters') return normalizeDisplayPath(key);
        if (index === 1 && change.path?.[0] === 'server_args') return key;
        return profileFieldLabel(key, locale);
      }).join(' · '),
      change.beforeInherited ? inheritedValue(change.key, runtimeOptions, runtimeVerified, runtimeChanged, locale) : renderChange(change.before),
      change.afterInherited ? inheritedValue(change.key, runtimeOptions, runtimeVerified, false, locale) : renderChange(change.after)))}
    {promptChanged && row('__prompt', copy.prompt, savedPrompt || copy.empty, currentPrompt || copy.empty)}
  </dl>;
}
