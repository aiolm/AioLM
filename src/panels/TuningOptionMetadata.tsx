import { createContext, useContext } from 'react';
import { useI18n } from '../i18n';
import { SERVER_OPTIONS, SERVER_OPTIONS_SOURCE, type ServerOption } from '../serverOptions';
import { serverDefault, type OptionDefault } from '../optionDefaults';
import { serverOptionsText } from '../serverOptionsI18n';
import { tuningOptionMetadata } from './tuningOptionInfo';

export const TuningOptionsContext = createContext<{ options: readonly ServerOption[]; verified: boolean }>({ options: SERVER_OPTIONS, verified: false });

function DefaultValue({ defaults, verified }: { defaults: OptionDefault; verified: boolean }) {
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const automatic = /(?:^|:\s*)['"]?auto['"]?(?:\s|$)/.test(defaults.value ?? '');
  return <span className="option-default-value">
    <span>{copy.defaultValue}: </span>
    <code>{defaults.value ?? (defaults.source === 'command' ? copy.notApplicable : copy.defaultUnknown)}</code>
    {defaults.value !== null && (defaults.source === 'app' ? <span className="option-default-source">{copy.defaultApp}</span> : verified && defaults.source === 'help'
      ? <span className="option-default-source">{copy.defaultRuntime}</span>
      : <a className="option-default-source" href={defaults.reference ?? SERVER_OPTIONS_SOURCE} target="_blank" rel="noreferrer">{copy.defaultReference}</a>)}
    {automatic && <span>{copy.defaultAutomatic}</span>}
  </span>;
}

export function ServerOptionDefault({ option, options, verified }: { option: ServerOption; options: readonly ServerOption[]; verified: boolean }) {
  return <DefaultValue defaults={serverDefault(option, options)} verified={verified} />;
}

export default function TuningOptionMetadata({ fieldKey }: { fieldKey: string }) {
  const runtime = useContext(TuningOptionsContext);
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const metadata = tuningOptionMetadata(fieldKey, runtime.options, runtime.verified);
  return <span className="tuning-option-metadata" data-option-metadata={fieldKey}>
    <span className="tuning-option-identifiers">
      {metadata.signature && <span>llama.cpp CLI: <code>{metadata.signature}</code></span>}
      {metadata.requestKey && <span>{copy.requestKey}: <code>{metadata.requestKey}</code></span>}
      {!metadata.signature && <span>{metadata.requestKey ? copy.requestOnly : copy.noCliMapping}</span>}
    </span>
    <DefaultValue defaults={metadata.defaults} verified={metadata.verified} />
    {metadata.missing && <span>{copy.notInRuntime}</span>}
  </span>;
}
