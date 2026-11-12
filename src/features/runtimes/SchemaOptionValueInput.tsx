import { useEffect, useId, useState } from 'react';
import { inNumericRange, type OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { JsonOptionNumberError, parseJsonOption } from '../../shared/runtime/jsonOptionNumbers';
import { display, kindOf, supported } from './optionPresentation';

type Copy = (typeof runtimeOptionsCopy)['en'];

export function isSwitch(option: OptionSchemaDefinition): boolean {
  return kindOf(option) === 'boolean' && supported(option.arity)?.max === 0;
}

export function textual(option: OptionSchemaDefinition): boolean {
  const kind = kindOf(option);
  return kind === undefined || kind === 'text' || kind === 'tokens';
}

/** Parses typed text by the option's documented kind; unknown kinds stay text. */
function parseValue(option: OptionSchemaDefinition, text: string): { ok: true; value: unknown } | { ok: false; jsonNumber?: boolean } {
  const kind = kindOf(option);
  const range = supported(option.range);
  if (kind === 'integer') {
    const value = Number(text);
    return /^\s*-?\d+\s*$/.test(text) && Number.isSafeInteger(value) && (!range || inNumericRange(value, range)) ? { ok: true, value } : { ok: false };
  }
  if (kind === 'number') {
    const value = Number(text);
    return text.trim() !== '' && Number.isFinite(value) && (!range || inNumericRange(value, range)) ? { ok: true, value } : { ok: false };
  }
  if (kind === 'json') {
    try {
      return { ok: true, value: parseJsonOption(text) };
    } catch (cause) {
      return { ok: false, jsonNumber: cause instanceof JsonOptionNumberError };
    }
  }
  return { ok: true, value: text };
}

export function optionName(option: OptionSchemaDefinition) {
  return option.spellings[0]?.flag ?? option.key;
}

/** Compound editors keep their values and row actions together at full width. */
export function needsWideCard(option: OptionSchemaDefinition): boolean {
  const kind = kindOf(option);
  const arity = supported(option.arity);
  return kind === 'json' || kind === 'tokens' || kind === 'path' || supported(option.local_path) === true
    || supported(option.repeatable) === true
    || (!isSwitch(option) && (arity === undefined || arity.min !== 1 || arity.max !== 1));
}

interface ValueInputProps {
  /** Set when a visible label element names this input. */
  inputId?: string;
  option: OptionSchemaDefinition;
  value: unknown;
  label: string;
  disabled: boolean;
  /** What clearing the field means: inherit the default, or an explicit "". */
  emptyMeans: 'inherit' | 'empty';
  copy: Copy;
  describedBy?: string;
  validationDescription?: string;
  onValue: (value: unknown) => void;
  onInvalid: (invalid: boolean) => void;
}

export function ValueInput({ inputId, option, value, label, disabled, emptyMeans, copy, describedBy, validationDescription, onValue, onInvalid }: ValueInputProps) {
  const generated = useId();
  const id = inputId ?? generated;
  const ariaLabel = inputId ? undefined : label;
  const errorId = `${id}-error`;
  const text = kindOf(option) === 'json' && value !== undefined ? JSON.stringify(value) : display(value);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  const [jsonNumberError, setJsonNumberError] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setDraft(text); setInvalid(false); setJsonNumberError(false); }, [text]);
  const kind = kindOf(option);
  const sensitive = supported(option.sensitive) === true;
  const choices = supported(option.choices) ?? [];
  const markInvalid = (next: boolean, jsonNumber = false) => { setInvalid(next); setJsonNumberError(jsonNumber); onInvalid(next); };
  const describedByIds = [describedBy, validationDescription, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const ariaInvalid = invalid || !!validationDescription || undefined;
  if (choices.length > 0) {
    // Choices keep their documented JSON type by position, never via String().
    const index = choices.findIndex(choice => JSON.stringify(choice) === JSON.stringify(value));
    const unlisted = value !== undefined && index < 0;
    return (
      <CustomSelect
        ariaLabel={label}
        ariaDescribedBy={describedByIds}
        ariaInvalid={unlisted || ariaInvalid}
        value={unlisted ? 'saved' : index < 0 ? '' : String(index)}
        disabled={disabled}
        options={[
          { value: '', label: emptyMeans === 'inherit' ? copy.inherit : copy.value },
          ...(unlisted ? [{ value: 'saved', label: sensitive ? '•••' : display(value) || '""', disabled: true }] : []),
          ...choices.map((choice, position) => ({ value: String(position), label: display(choice) })),
        ]}
        onChange={selected => onValue(selected === '' ? undefined : choices[Number(selected)])}
      />
    );
  }
  if (kind === 'boolean') {
    return (
      <CustomSelect
        ariaLabel={label}
        ariaDescribedBy={describedByIds}
        ariaInvalid={ariaInvalid}
        value={value === true ? 'true' : value === false ? 'false' : ''}
        disabled={disabled}
        options={[{ value: '', label: copy.inherit }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
        onChange={selected => onValue(selected === '' ? undefined : selected === 'true')}
      />
    );
  }
  // Change already parses and commits the draft. Recommitting it on blur
  // restarts async option validation between pointer down and the save click.
  const commit = (next: string) => {
    setDraft(next);
    if (next === '' && (emptyMeans === 'inherit' || !textual(option))) {
      markInvalid(emptyMeans === 'empty');
      if (emptyMeans === 'inherit') onValue(undefined);
      return;
    }
    const parsed = parseValue(option, next);
    if (!parsed.ok) { markInvalid(true, parsed.jsonNumber); return; }
    markInvalid(false);
    onValue(parsed.value);
  };
  const hide = sensitive && !revealed;
  return (
    <span className="schema-option__value">
      {kind === 'json' ? (
        hide ? (
          <input id={id} className="app-input" type="password" value={draft} disabled={disabled} aria-label={ariaLabel} aria-describedby={describedByIds} aria-invalid={ariaInvalid} readOnly placeholder={copy.hidden} />
        ) : (
          <textarea id={id} name={label} className="app-textarea" value={draft} disabled={disabled} aria-label={ariaLabel}
            aria-describedby={describedByIds} aria-invalid={ariaInvalid}
            onChange={event => commit(event.target.value)} />
        )
      ) : (
        <input id={id} name={label} className="app-input" value={draft} disabled={disabled} aria-label={ariaLabel}
          type={hide ? 'password' : 'text'} inputMode={kind === 'integer' || kind === 'number' ? 'decimal' : 'text'}
          autoCorrect="off" autoCapitalize="off" spellCheck={false}
          aria-describedby={describedByIds} aria-invalid={ariaInvalid}
          onChange={event => commit(event.target.value)} />
      )}
      {sensitive && (
        <button type="button" className="app-button app-button--secondary" aria-pressed={revealed} disabled={disabled}
          onClick={() => setRevealed(current => !current)}>{revealed ? copy.hide : copy.show}</button>
      )}
      {invalid && <span id={errorId} role="alert">{jsonNumberError ? copy.jsonNumberRange : copy.invalid}</span>}
    </span>
  );
}
