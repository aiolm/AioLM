import { useI18n } from '../../shared/i18n/i18n';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { changedSettings } from '../../shared/config/settingsProfiles';
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

/** How many settings a save would rewrite, counting the prompt as one. */
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
export default function SettingsChangeList({ saved, current, savedPrompt, currentPrompt }: {
  saved: Partial<ExecutionSettings>; current: Partial<ExecutionSettings>; savedPrompt: string; currentPrompt: string;
}) {
  const { locale } = useI18n();
  const copy = profileControlCopy[locale];
  const render = valueRenderer(locale);
  const changes = changedSettings(saved, current);
  const promptChanged = savedPrompt !== currentPrompt;
  const row = (key: string, label: string, before: string, after: string) => <div key={key}>
    <dt>{label}</dt>
    <dd><span className="settings-profile-change-before">{before}</span>
      <span aria-hidden="true"> → </span><span className="sr-only"> {copy.changeTo} </span>
      <span className="settings-profile-change-after">{after}</span></dd>
  </div>;
  return <dl className="settings-profile-changes">
    {changes.map(change => row(change.key, profileFieldLabel(change.key, locale), render(change.before), render(change.after)))}
    {promptChanged && row('__prompt', copy.prompt, savedPrompt || copy.empty, currentPrompt || copy.empty)}
  </dl>;
}
