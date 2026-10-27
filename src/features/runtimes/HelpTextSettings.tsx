import { useId } from 'react';
import type { HelpEncoding, HelpRequest } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';

export type HelpTextChoice = Pick<HelpRequest, 'encoding' | 'locale'>;

/** Help decoding and child locale are independent of inference protocols. */
export default function HelpTextSettings({ value, disabled, onChange }: {
  value: HelpTextChoice;
  disabled: boolean;
  onChange: (value: HelpTextChoice) => void;
}) {
  const id = useId();
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const raw = value.encoding ?? 'auto';
  const encoding = raw === 'utf16le' ? 'utf16_le' : raw === 'utf16be' ? 'utf16_be' : raw;
  const change = (nextEncoding: HelpEncoding, nextLocale: string) => onChange({
    ...(nextEncoding !== 'auto' ? { encoding: nextEncoding } : {}),
    ...(nextLocale ? { locale: nextLocale } : {}),
  });
  return (
    <fieldset className="mt-3">
      <legend>{copy.helpTextTitle}</legend>
      <label id={`${id}-encoding-label`} htmlFor={`${id}-encoding`}>{copy.helpEncoding}</label>
      <CustomSelect id={`${id}-encoding`} name="help-encoding" value={encoding} disabled={disabled}
        ariaLabelledBy={`${id}-encoding-label`} ariaDescribedBy={`${id}-hint`}
        options={[
          { value: 'auto', label: copy.helpEncodingAuto }, { value: 'utf8', label: 'UTF-8' },
          { value: 'utf16_le', label: 'UTF-16 LE' }, { value: 'utf16_be', label: 'UTF-16 BE' },
          { value: 'cp949', label: copy.helpKorean }, { value: 'cp932', label: copy.helpJapanese },
          { value: 'windows-1252', label: copy.helpWestern },
        ]}
        onChange={next => change(next, value.locale ?? '')} />
      <label htmlFor={`${id}-locale`}>{copy.helpLocale}</label>
      <input id={`${id}-locale`} name="help-locale" className="app-input" value={value.locale ?? ''}
        disabled={disabled} maxLength={64} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        aria-describedby={`${id}-hint`} onChange={event => change(encoding, event.target.value)} />
      <p id={`${id}-hint`} className="app-section-hint">{copy.helpTextHint}</p>
    </fieldset>
  );
}
