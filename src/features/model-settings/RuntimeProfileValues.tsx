import { providerDisplayName, type ProviderId } from '../../shared/api/providers';
import type { OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import type { ExecutionSettings } from '../../shared/config/executionSettings';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { ORDER_KEY, readStored } from '../runtimes/optionOrder';
import { valueRenderer } from './SettingsChangeList';
import { profileControlCopy, profileFieldLabel } from './profileControlCopy';
import { profileSchemaCopy } from './profileSchemaCopy';
import type { ProfileRuntimeSchema } from './useProfileRuntimeSchema';
import { profileValueMask } from './profileValueMask';
import './settings-profile.css';

export default function RuntimeProfileValues({ settings, provider, prompt, mode, schema, showRuntime = true }: {
  settings: Partial<ExecutionSettings>; provider: ProviderId; prompt?: string;
  mode: 'current' | 'preview' | 'reference'; schema: ProfileRuntimeSchema;
  showRuntime?: boolean;
}) {
  const { locale } = useI18n();
  const copy = profileSchemaCopy[locale];
  const fields = profileControlCopy[locale];
  const optionsCopy = runtimeOptionsCopy[locale];
  const render = valueRenderer(locale);
  const selected = provider === schema.provider && (settings.active_runtime === undefined || settings.active_runtime === schema.runtime);
  const view = selected ? schema.view : undefined;
  const current = view && !['stale', 'unchecked'].includes(view.help_state);
  const applicable = (option: OptionSchemaDefinition) => !!view && option.scope.every((segment, index) => view.scope[index] === segment);
  const known = new Map(current ? view.schema.options.filter(option => !option.managed && applicable(option)).map(option => [option.key, option]) : []);
  const values = settings.provider_options?.[provider] ?? {};
  const mask = profileValueMask(view, values);
  const keys = mode === 'reference' ? [...known.keys()] : Object.keys(values).filter(key => key !== ORDER_KEY);
  const confirmed = keys.filter(key => known.has(key));
  const retained = keys.filter(key => !known.has(key));
  const name = (option: OptionSchemaDefinition) => option.spellings[0]?.flag ?? option.key;
  const shown = (option: OptionSchemaDefinition) => {
    if (option.sensitive.value === true) return '•••';
    if (mode === 'reference') return option.runtime_default.certainty !== 'unknown' && option.runtime_default.value
      ? mask(render(option.runtime_default.value.literal)) : copy.unknownDefault;
    const stored = readStored(values[option.key]);
    const text = stored ? stored.rows.map(row => row.length ? row.map(value => value === '' ? optionsCopy.emptySet : render(value)).join(', ') : fields.on).join(' · ') : fields.empty;
    return mask(text);
  };
  const appKeys = (['request_timeout_seconds', 'sleep_idle_seconds'] as const).filter(key => settings[key] !== undefined);
  return <div className="settings-profile-values">
    {showRuntime && <p><span>{providerDisplayName(provider)}</span>{(settings.active_runtime || selected && schema.runtime) && <> · <span>{settings.active_runtime || schema.runtime}</span></>}</p>}
    {selected && schema.pending ? <p role="status">{copy.checking}</p>
      : !view ? <p role="status">{copy.unavailable} {selected && schema.runtime && <button type="button" className="app-button app-button--secondary app-button--sm" onClick={schema.retry}>{copy.retry}</button>}</p>
        : !current ? <p role="status">{copy.stale}</p> : null}
    {confirmed.length > 0 && <section className="settings-profile-value-group" aria-label={copy.options}>
      <h4>{copy.options}</h4><p className="app-section-hint">{copy.declared}</p>
      <dl>{confirmed.map(key => {
        const option = known.get(key)!;
        const fromHelp = view?.help_keys.includes(key);
        return <div key={key} className="settings-profile-value">
          <dt><span>{name(option)}</span><small> · {option.target === 'request' ? optionsCopy.request : optionsCopy.launch}
            {` · ${fromHelp ? optionsCopy.sourceHelp : optionsCopy.sourceAdapter}`}
            {option.kind.certainty === 'unknown' ? ` · ${optionsCopy.unverifiedType}` : ''}</small></dt>
          <dd>{shown(option)}</dd>
        </div>;
      })}</dl>
    </section>}
    {current && keys.length === 0 && <p>{copy.empty}</p>}
    {retained.length > 0 && <section className="settings-profile-value-group" aria-label={copy.retained}>
      <h4>{copy.retained}</h4><dl>{retained.map(key => <div key={key} className="settings-profile-value">
        <dt>{profileFieldLabel(key, locale)}</dt><dd>{copy.unverified}</dd>
      </div>)}</dl>
    </section>}
    {(appKeys.length > 0 || prompt !== undefined) && <section className="settings-profile-value-group" aria-label={copy.app}>
      <h4>{copy.app}</h4><dl>{appKeys.map(key =>
        <div key={key} className="settings-profile-value"><dt>{profileFieldLabel(key, locale)}</dt><dd>{render(settings[key])}</dd></div>)}</dl>
      {prompt !== undefined && <><h5>{fields.prompt}</h5><p>{prompt || fields.empty}</p></>}
    </section>}
  </div>;
}
