import { createContext, useContext, type ReactNode } from 'react';
import { useI18n } from '../../shared/i18n/i18n';
import { SERVER_OPTIONS, SERVER_OPTIONS_SOURCE, type ServerOption } from '../../shared/config/serverOptions';
import { serverDefault, type OptionDefault } from '../../shared/config/optionDefaults';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';
import { tuningOptionMetadata } from './tuningOptionInfo';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { optionDefaultText } from '../../shared/i18n/optionDefaultText';
import { defaultScalar } from '../../shared/config/tuningResetValues';
import { settingMetadataCopy } from '../../shared/i18n/settingMetadataCopy';

export const TuningOptionsContext = createContext<{ options: readonly ServerOption[]; verified: boolean }>({ options: SERVER_OPTIONS, verified: false });

function DefaultValue({ defaults, verified }: { defaults: OptionDefault; verified: boolean }) {
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const automatic = /(?:^|:\s*)['"]?auto['"]?(?:\s|$)/.test(defaults.value ?? '');
  return <span className="option-default-value">
    <span>{copy.defaultValue}: </span>
    <code>{normalizeDisplayText(defaults.value === null ? defaults.source === 'command' ? copy.notApplicable : copy.defaultUnknown : optionDefaultText(defaults.value, locale))}</code>
    {defaults.value !== null && (defaults.source === 'app' ? <span className="option-default-source">{copy.defaultApp}</span> : verified && defaults.source === 'help'
      ? <span className="option-default-source">{copy.defaultRuntime}</span>
      : <a className="option-default-source" href={defaults.reference ?? SERVER_OPTIONS_SOURCE} target="_blank" rel="noreferrer">{copy.defaultReference}</a>)}
    {automatic && <span>{copy.defaultAutomatic}</span>}
  </span>;
}

export function ServerOptionDefault({ option, options, verified }: { option: ServerOption; options: readonly ServerOption[]; verified: boolean }) {
  return <DefaultValue defaults={serverDefault(option, options)} verified={verified} />;
}

export default function TuningOptionMetadata({ fieldKey, inherited = false, children }: { fieldKey: string; inherited?: boolean; children?: ReactNode }) {
  const runtime = useContext(TuningOptionsContext);
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const text = settingMetadataCopy[locale];
  const metadata = tuningOptionMetadata(fieldKey, runtime.options, runtime.verified);
  const rawDefault = metadata.defaults.value;
  const scalar = defaultScalar(rawDefault);
  const compactDefault = rawDefault === null ? text.unspecified : scalar === undefined ? text.varies : String(scalar);
  const hasQualifier = rawDefault !== null && rawDefault !== compactDefault;
  const fromReference = metadata.defaults.source !== 'app' && !(metadata.verified && metadata.defaults.source === 'help');
  const automatic = /(?:^|:\s*)['"]?auto['"]?(?:\s|$)/.test(rawDefault ?? '');
  return <div className="tuning-option-metadata" data-option-metadata={fieldKey}>
    <div className="tuning-option-summary">
      <span className="option-default-value">
        <span>{copy.defaultValue}: </span><code>{normalizeDisplayText(compactDefault)}</code>
        {rawDefault !== null && fromReference && <span className="tuning-default-note">{text.reference}</span>}
        {inherited && <span className="tuning-default-active">{text.inUse}</span>}
      </span>
      {children}
    </div>
    <details className="tuning-option-details">
      <summary>{text.details}</summary>
      <dl>
        {metadata.signature && <div><dt>CLI</dt><dd><code>{normalizeDisplayText(metadata.signature)}</code></dd></div>}
        {metadata.requestKey && <div><dt>{copy.requestKey}</dt><dd><code>{normalizeDisplayText(metadata.requestKey)}</code></dd></div>}
        {!metadata.signature && <div><dt>CLI</dt><dd>{metadata.requestKey ? copy.requestOnly : copy.noCliMapping}</dd></div>}
        {hasQualifier && <div><dt>{text.rules}</dt><dd>{normalizeDisplayText(optionDefaultText(rawDefault, locale))}</dd></div>}
        <div><dt>{text.source}</dt><dd>{metadata.defaults.source === 'app' ? copy.defaultApp : metadata.verified && metadata.defaults.source === 'help' ? copy.defaultRuntime
          : rawDefault !== null ? <a href={metadata.defaults.reference ?? SERVER_OPTIONS_SOURCE} target="_blank" rel="noreferrer">{copy.defaultReference}</a> : copy.defaultUnknown}</dd></div>
      </dl>
      {automatic && <p>{copy.defaultAutomatic}</p>}
      {metadata.missing && <p>{copy.notInRuntime}</p>}
    </details>
  </div>;
}
