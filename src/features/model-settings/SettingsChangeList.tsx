import { useI18n } from '../../shared/i18n/i18n';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { changedSettings } from '../../shared/config/settingsProfiles';
import { settingDefaultInfo } from '../../shared/config/defaultValueDisplay';
import DefaultValue from '../../shared/ui/DefaultValue';
import type { ReactNode } from 'react';
import type { ServerOption } from '../../shared/config/serverOptions';
import { normalizeDisplayPath } from '../../shared/lib/displayPaths';
import { runtimeVersionLabel, useInstalledRuntimes } from '../../shared/runtime/installedRuntimes';
import { profileControlCopy, profileFieldLabel } from './profileControlCopy';

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
  const installedRuntimes = useInstalledRuntimes();
  const renderChange = (value: unknown) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0 ? '{}' : render(value);
  // A build id is storage identity; the person reads the version it names.
  const renderBuild = (key: string, value: unknown, backend: string | undefined) =>
    key === 'active_build' && typeof value === 'string' && value ? runtimeVersionLabel(installedRuntimes, backend ?? '', value) : renderChange(value);
  const changes = changedSettings(saved, current);
  const runtimeChanged = saved.active_backend !== current.active_backend || saved.active_build !== current.active_build;
  const promptChanged = savedPrompt !== currentPrompt;
  const row = (key: string, label: string, before: ReactNode, after: ReactNode) => <div key={key}>
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
      change.beforeInherited ? <DefaultValue info={settingDefaultInfo(change.key, runtimeOptions, runtimeVerified, locale, { selected: true, previousRuntime: runtimeChanged })} /> : renderBuild(change.key, change.before, saved.active_backend),
      change.afterInherited ? <DefaultValue info={settingDefaultInfo(change.key, runtimeOptions, runtimeVerified, locale, { selected: true })} /> : renderBuild(change.key, change.after, current.active_backend)))}
    {promptChanged && row('__prompt', copy.prompt, savedPrompt || copy.empty, currentPrompt || copy.empty)}
  </dl>;
}
