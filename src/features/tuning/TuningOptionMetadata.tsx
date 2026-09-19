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

export default function TuningOptionMetadata({ fieldKey, inherited = false, value, children }: { fieldKey: string; inherited?: boolean; value?: unknown; children?: ReactNode }) {
  const runtime = useContext(TuningOptionsContext);
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const text = settingMetadataCopy[locale];
  const metadata = tuningOptionMetadata(fieldKey, runtime.options, runtime.verified);
  const rawDefault = metadata.defaults.value;
  const scalar = defaultScalar(rawDefault);
  // The whole documented default, not a scalar with the rest of it hidden behind
  // a disclosure: a bare default reads exactly as it did, and a conditional one
  // no longer has to be looked up to be read.
  const defaultText = rawDefault === null ? text.unspecified : optionDefaultText(rawDefault, locale);
  const fromReference = metadata.defaults.source !== 'app' && !(metadata.verified && metadata.defaults.source === 'help');
  const automatic = /(?:^|:s*)['"]?auto['"]?(?:s|$)/.test(rawDefault ?? '');
  // A field set back to the default is running the default, whether it got there
  // by being left alone or by being typed in again. The badge only knew the first
  // case, so restoring a value looked as though it had not taken.
  const atDefault = inherited || (scalar !== undefined && value !== undefined && value !== null && String(scalar) === String(value));
  const signature = metadata.signature;
  return <div className="tuning-option-metadata" data-option-metadata={fieldKey}>
    <div className="tuning-option-summary">
      {signature
        ? <code className="tuning-option-flag">{normalizeDisplayText(signature)}</code>
        : <span className="tuning-option-flag tuning-option-flag--none">{metadata.requestKey ? copy.requestOnly : copy.noCliMapping}</span>}
      {metadata.requestKey && <code className="tuning-option-flag" title={copy.requestKey}>{normalizeDisplayText(metadata.requestKey)}</code>}
      <span className="option-default-value">
        <span>{copy.defaultValue}: </span><code>{normalizeDisplayText(defaultText)}</code>
        {/* Where the default came from, in one word beside it: whose number is on
            screen took opening a panel to learn. */}
        {rawDefault !== null && (fromReference
          ? <a className="tuning-default-note" href={metadata.defaults.reference ?? SERVER_OPTIONS_SOURCE} target="_blank" rel="noreferrer">{text.reference}</a>
          : <span className="tuning-default-note">{metadata.defaults.source === 'app' ? text.sourceApp : text.sourceRuntime}</span>)}
        {atDefault && <span className="tuning-default-active">{text.inUse}</span>}
      </span>
      {children}
    </div>
    {automatic && <p className="tuning-option-note">{copy.defaultAutomatic}</p>}
    {metadata.missing && <p className="tuning-option-note">{copy.notInRuntime}</p>}
  </div>;
}
