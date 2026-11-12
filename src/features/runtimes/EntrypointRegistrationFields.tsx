import { useEffect, useId, useRef, useState } from 'react';
import { pickRuntimePath } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import type { BindingState, EntrypointRegistrationCopy } from './entrypointRegistrationTypes';

export function PathField({ label, value, kind, disabled, required = false, copy, onChange }: {
  label: string; value: string; kind: 'file' | 'folder'; disabled: boolean; required?: boolean; copy: EntrypointRegistrationCopy; onChange: (next: string) => void;
}) {
  const id = useId();
  const [error, setError] = useState('');
  const pickerGeneration = useRef(0);
  const latest = useRef({ onChange, disabled }); latest.current = { onChange, disabled };
  useEffect(() => {
    pickerGeneration.current += 1;
    return () => { pickerGeneration.current += 1; };
  }, [kind, disabled, value]);
  const choose = () => {
    const generation = ++pickerGeneration.current;
    setError('');
    void pickRuntimePath(kind).then(path => {
      if (generation === pickerGeneration.current && !latest.current.disabled && path) latest.current.onChange(path);
    }).catch(cause => {
      if (generation === pickerGeneration.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  };
  return (
    <div className="entrypoint-field">
      <label htmlFor={id}>{label}</label>
      <span className="entrypoint-path">
        <input id={id} name={label} className="app-input" value={value} disabled={disabled} required={required}
          autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => onChange(event.target.value)} />
        <button type="button" className="app-button app-button--secondary" disabled={disabled}
          onClick={choose}>{copy.choose}</button>
      </span>
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    </div>
  );
}

/** One app-owned binding: a documented help option (or typed name without
 * help), the positional slot, or unused when the binding is optional. */
export function BindingField({ label, state, optional, documented, positionalDocumented, helpChecked, disabled, copy, onChange }: {
  label: string; state: BindingState; optional: boolean; documented: string[]; positionalDocumented: boolean; helpChecked: boolean;
  disabled: boolean; copy: EntrypointRegistrationCopy; onChange: (next: BindingState) => void;
}) {
  const id = useId();
  const modes = [
    ...(optional ? [{ value: 'none', label: copy.none }] : []),
    { value: 'flag', label: helpChecked ? copy.flagChoice : copy.flagText },
    ...(!helpChecked || positionalDocumented ? [{ value: 'positional', label: copy.positional }] : []),
  ];
  return (
    <fieldset>
      <legend>{label}</legend>
      <CustomSelect ariaLabel={label} value={state.mode} disabled={disabled} options={modes}
        onChange={mode => onChange({ ...state, mode: mode as BindingState['mode'] })} />
      {state.mode === 'flag' && (helpChecked ? (
        <CustomSelect ariaLabel={`${label} ${copy.flagChoice}`} value={state.flag} disabled={disabled}
          options={[{ value: '', label: copy.flagChoice }, ...documented.map(flag => ({ value: flag, label: flag }))]}
          onChange={flag => onChange({ ...state, flag })} />
      ) : (
        <span className="entrypoint-field">
          <label htmlFor={`${id}-flag`}>{copy.flagText}</label>
          <input id={`${id}-flag`} name={`${label}-flag`} className="app-input" value={state.flag} disabled={disabled}
            autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => onChange({ ...state, flag: event.target.value })} />
        </span>
      ))}
      {state.mode === 'flag' && (
        <label><input type="checkbox" checked={state.equals} disabled={disabled}
          onChange={event => onChange({ ...state, equals: event.target.checked })} /> {copy.equals}</label>
      )}
    </fieldset>
  );
}
