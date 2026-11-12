import { memo, useEffect, useId, useRef, useState } from 'react';
import type { ConfirmedSyntax, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { readStored, writeStored } from './optionOrder';
import { display, supported } from './optionPresentation';
import { isSwitch, optionName, textual, ValueInput } from './SchemaOptionValueInput';

type Copy = (typeof runtimeOptionsCopy)['en'];

export interface SchemaOptionFieldProps {
  option: OptionSchemaDefinition;
  stored: unknown;
  disabled: boolean;
  /** Preserve a saved value while still allowing an explicit clear. */
  readOnly?: boolean;
  applicable?: boolean;
  /** Label for "no saved value" (e.g. an automatic capability default). */
  inheritLabel?: string;
  hint?: string;
  /** IDs of native validation messages for this option. */
  validationDescription?: string;
  /** `origins[i]` is the saved occurrence a new row came from (null: new). */
  onStore: (next: unknown, origins?: Array<number | null>) => void;
  onInvalid?: (key: string, invalid: boolean) => void;
  /** Each saved occurrence's own alias, when a saved order records it. */
  rowSpellings?: Array<string | null>;
  onRowSpelling?: (row: number, flag: string) => void;
  /** Offered for reviewed help options whose help left syntax unknown. */
  onConfirmSyntax?: (syntax: ConfirmedSyntax) => void;
}

/** One schema option: the same editor for catalog, manifest and help options. */
export const SchemaOptionField = memo(function SchemaOptionField({ option, stored, disabled, readOnly = false, applicable = true, inheritLabel, hint, validationDescription, onStore, onInvalid, rowSpellings, onRowSpelling, onConfirmSyntax }: SchemaOptionFieldProps) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const helpId = `${id}-help`;
  const rangeId = `${id}-range`;
  // Literal bounds can disclose a secret just as its documented default can.
  const range = supported(option.sensitive) === true ? undefined : supported(option.range);
  const minimum = typeof range?.min === 'number' && Number.isFinite(range.min) ? range.min : undefined;
  const maximum = typeof range?.max === 'number' && Number.isFinite(range.max) ? range.max : undefined;
  const interval = minimum !== undefined && maximum !== undefined
    ? (range?.min_exclusive || range?.max_exclusive
      ? `${range.min_exclusive ? '(' : '['}${minimum}, ${maximum}${range.max_exclusive ? ')' : ']'}`
      : `${minimum}–${maximum}`)
    : minimum !== undefined ? `${range?.min_exclusive ? '>' : '≥'} ${minimum}`
      : maximum !== undefined ? `${range?.max_exclusive ? '<' : '≤'} ${maximum}` : undefined;
  const sentinels = range?.sentinel_values?.length ? `{${range.sentinel_values.join(', ')}}` : undefined;
  const bounds = [interval, sentinels].filter(Boolean).join(' ∪ ') || undefined;
  const rangeHint = bounds === undefined ? null : <p id={rangeId} className="app-section-hint">{copy.field_range}: {bounds}</p>;
  const describedBy = [option.help ? helpId : undefined, bounds === undefined ? undefined : rangeId].filter(Boolean).join(' ') || undefined;
  const name = optionName(option);
  const current = readStored(stored);
  const arity = supported(option.arity);
  const repeatable = supported(option.repeatable) === true;
  const locked = disabled || readOnly || !applicable || !!option.managed;
  const spellings = option.spellings.filter(spelling => spelling.polarity === undefined || spelling.polarity === null);
  const [firstSpelling] = spellings;
  const invalidCells = useRef(new Set<string>());
  const report = (cell: string, invalid: boolean) => {
    if (invalid) invalidCells.current.add(cell); else invalidCells.current.delete(cell);
    onInvalid?.(`schema:${option.key}`, invalidCells.current.size > 0);
  };
  useEffect(() => () => onInvalid?.(`schema:${option.key}`, false), [option.key, onInvalid]);
  const store = (rows: unknown[][], spelling = current?.spelling ?? null, origins?: Array<number | null>) => onStore(writeStored(rows, spelling), origins);
  const defaultValue = supported(option.runtime_default);
  const defaultDescription = inheritLabel ?? (defaultValue
    ? (supported(option.sensitive) === true ? '•••' : display(defaultValue.literal)) : undefined);
  const facts = [
    option.target === 'request' ? copy.request : undefined,
    // A secret option's documented default is a secret too; it is never shown.
    defaultDescription === undefined ? undefined : `${copy.inherit}: ${defaultDescription}`,
    supported(option.unit),
    supported(option.restart_required) === true ? copy.restartRequired : undefined,
    supported(option.sensitive) === true ? copy.secretValue : undefined,
    option.arity.certainty === 'unknown' && option.target === 'launch' ? copy.unconfirmedArity : undefined,
  ].filter(Boolean).join(' · ');
  const header = <code id={`${id}-name`} className="schema-option__name">{name}</code>;
  const metadata = facts ? <p className="schema-option__facts">{facts}</p> : null;
  const description = option.help && <p id={helpId} className="app-section-hint">{option.help}</p>;
  const syntaxUnknown = option.target === 'launch' && !option.managed
    && (option.arity.certainty === 'unknown' || option.repeatable.certainty === 'unknown');
  const help = (
    <>
      {hint && <small>{hint}</small>}
      {readOnly && !option.managed && stored !== undefined && (
        <button type="button" className="app-button app-button--secondary" disabled={disabled}
          onClick={() => onStore(undefined)}>{copy.useDefault}</button>
      )}
      {!applicable && <p className="app-section-hint">{copy.notApplicable}</p>}
      {onConfirmSyntax && syntaxUnknown && <ConfirmSyntax option={option} name={name} disabled={disabled} copy={copy} onConfirm={onConfirmSyntax} />}
    </>
  );
  if (option.managed) {
    return (
      <div className="schema-option">
        {header}
        <p className="schema-option__facts">{option.managed === 'entry_point' ? copy.managedEntryPoint : option.managed === 'reserved' ? copy.managedReserved
          : option.managed === 'discovery' && option.position !== null && option.position !== undefined ? copy.managedPositional : copy.managed}</p>
        {description}
        {help}
      </div>
    );
  }
  const aliasSelect = firstSpelling && spellings.length > 1 && (
    <CustomSelect
      ariaLabel={`${name} ${copy.spelling}`}
      value={current?.spelling ?? firstSpelling.flag}
      disabled={locked || !current}
      options={spellings.map(spelling => ({ value: spelling.flag, label: spelling.flag }))}
      onChange={flag => current && store(current.rows, flag === firstSpelling.flag ? null : flag)}
    />
  );
  if (isSwitch(option)) {
    // False is offered only when the runtime documents how to say it: a
    // negative spelling, or a sourced false default that omission expresses.
    const falseAllowed = option.spellings.some(spelling => spelling.polarity === false) || defaultValue?.literal === false;
    const value = current?.rows[0]?.[0];
    return (
      <div className="schema-option">
        {header}
        {metadata}
        {description}
        {rangeHint}
        <CustomSelect
          ariaLabel={name}
          ariaDescribedBy={[describedBy, validationDescription].filter(Boolean).join(' ') || undefined}
          ariaInvalid={!!validationDescription || undefined}
          value={value === true ? 'true' : value === false ? 'false' : ''}
          disabled={locked}
          options={[
            { value: '', label: inheritLabel ?? copy.inherit },
            { value: 'true', label: 'true' },
            ...(falseAllowed || value === false ? [{ value: 'false', label: 'false' }] : []),
          ]}
          onChange={selected => onStore(selected === '' ? undefined : selected === 'true')}
        />
        {help}
      </div>
    );
  }
  const single = !repeatable && (arity === undefined || (arity.min === 1 && arity.max === 1));
  if (single) {
    const value = current?.rows[0]?.[0];
    const explicitEmpty = value === '' && textual(option);
    return (
      <div className="schema-option">
        <label htmlFor={`${id}-single`}>{header}</label>
        {metadata}
        {description}
        {rangeHint}
        {explicitEmpty ? (
          <span className="schema-option__value">
            <span>{copy.emptySet}</span>
            {!readOnly && <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => onStore(undefined)}>{copy.useDefault}</button>}
          </span>
        ) : (
          <SingleValue option={option} value={value} label={name} disabled={locked} copy={copy} describedBy={describedBy} validationDescription={validationDescription}
            inputId={`${id}-single`}
            onValue={next => onStore(next === undefined ? undefined : writeStored([[next]], current?.spelling ?? null))}
            onInvalid={invalid => report('single', invalid)} />
        )}
        {!explicitEmpty && value === undefined && textual(option) && !supported(option.choices) && (
          <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => onStore('')}>{copy.useEmpty}</button>
        )}
        {aliasSelect}
        {help}
      </div>
    );
  }
  const rows = current?.rows ?? [];
  const fixed = arity && arity.max !== null && arity.max !== undefined && arity.min === arity.max ? arity.min : undefined;
  const canAddValue = (row: unknown[]) => fixed === undefined && (arity?.max === null || arity?.max === undefined || row.length < arity.max);
  const canRemoveValue = (row: unknown[]) => fixed === undefined && row.length > (arity?.min ?? 0);
  const emptyRow = (): unknown[] => Array.from({ length: fixed ?? arity?.min ?? 0 }, () => '');
  return (
    <fieldset className="schema-option">
      <legend>{header}</legend>
      {metadata}
      {description}
      {rangeHint}
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="schema-option__row" role="group" aria-label={`${name} ${copy.occurrence} ${rowIndex + 1}`}>
          {row.map((cell, cellIndex) => (
            <span key={cellIndex} className="schema-option__cell">
              <ValueInput option={option} value={cell} label={`${name} ${copy.occurrence} ${rowIndex + 1} ${copy.value} ${cellIndex + 1}`}
                disabled={locked} emptyMeans="empty" copy={copy} describedBy={describedBy} validationDescription={validationDescription}
                onValue={next => store(rows.map((r, i) => (i === rowIndex ? r.map((c, j) => (j === cellIndex ? next : c)) : r)))}
                onInvalid={invalid => report(`${rowIndex}:${cellIndex}`, invalid)} />
              {canRemoveValue(row) && (
                <button type="button" className="app-button app-button--secondary" disabled={locked}
                  onClick={() => store(rows.map((r, i) => (i === rowIndex ? r.filter((_, j) => j !== cellIndex) : r)))}>{copy.removeValue}</button>
              )}
            </span>
          ))}
          {canAddValue(row) && (
            <button type="button" className="app-button app-button--secondary" disabled={locked}
              onClick={() => store(rows.map((r, i) => (i === rowIndex ? [...r, ''] : r)))}>{copy.addValue}</button>
          )}
          {onRowSpelling && firstSpelling && spellings.length > 1 && (
            <CustomSelect
              ariaLabel={`${name} ${copy.occurrence} ${rowIndex + 1} ${copy.spelling}`}
              // A null order spelling means this option's default, not the shared alias.
              value={(rowSpellings?.[rowIndex] === null ? firstSpelling.flag : rowSpellings?.[rowIndex]) ?? current?.spelling ?? firstSpelling.flag}
              disabled={locked}
              options={spellings.map(spelling => ({ value: spelling.flag, label: spelling.flag }))}
              onChange={flag => onRowSpelling(rowIndex, flag)}
            />
          )}
          <button type="button" className="app-button app-button--secondary" disabled={locked}
            onClick={() => store(rows.filter((_, i) => i !== rowIndex), undefined, rows.flatMap((_, i) => (i === rowIndex ? [] : [i])))}>{copy.removeOccurrence}</button>
        </div>
      ))}
      {(repeatable || rows.length === 0) && (
        <button type="button" className="app-button app-button--secondary" disabled={locked}
          onClick={() => store([...rows, emptyRow()])}>{copy.addOccurrence}</button>
      )}
      {!readOnly && rows.length > 0 && (
        <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => onStore(undefined)}>{copy.useDefault}</button>
      )}
      {aliasSelect}
      {help}
    </fieldset>
  );
});

function SingleValue({ option, value, label, disabled, copy, describedBy, validationDescription, inputId, onValue, onInvalid }: {
  option: OptionSchemaDefinition; value: unknown; label: string; disabled: boolean; copy: Copy; describedBy?: string; validationDescription?: string;
  inputId: string; onValue: (value: unknown) => void; onInvalid: (invalid: boolean) => void;
}) {
  // The label element points at the first focusable control rendered below.
  return (
    <span className="schema-option__single">
      <ValueInput inputId={inputId} option={option} value={value} label={label} disabled={disabled} emptyMeans="inherit" copy={copy}
        describedBy={describedBy} validationDescription={validationDescription} onValue={onValue} onInvalid={onInvalid} />
    </span>
  );
}

/** Explicit value count and repetition for a help option whose help left
 * them unknown. Nothing is inferred; the user states what the runtime takes. */
function ConfirmSyntax({ option, name, disabled, copy, onConfirm }: {
  option: OptionSchemaDefinition; name: string; disabled: boolean; copy: Copy; onConfirm: (syntax: ConfirmedSyntax) => void;
}) {
  const id = useId();
  const arityUnknown = option.arity.certainty === 'unknown';
  const repeatUnknown = option.repeatable.certainty === 'unknown';
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('1');
  const [repeat, setRepeat] = useState('');
  const minValue = Number(min);
  const maxValue = max.trim() === '' ? null : Number(max);
  const arityValid = !arityUnknown || (/^\d+$/.test(min.trim()) && minValue <= 256
    && (maxValue === null || (/^\d+$/.test(max.trim()) && maxValue >= minValue && maxValue <= 256)));
  const syntax: ConfirmedSyntax = {
    ...(arityUnknown ? { arity: { min: minValue, max: maxValue } } : {}),
    ...(repeatUnknown && repeat ? { repeatable: repeat === 'yes' } : {}),
  };
  const ready = arityValid && (syntax.arity !== undefined || syntax.repeatable !== undefined);
  return (
    <details>
      <summary>{copy.confirmSyntax} ({name})</summary>
      <p className="app-section-hint">{copy.confirmSyntaxHint}</p>
      {arityUnknown && (
        <span className="schema-option__value">
          <label htmlFor={`${id}-min`}>{copy.minValues}</label>
          <input id={`${id}-min`} name={`${option.key}-min-values`} className="app-input" inputMode="numeric" value={min} disabled={disabled}
            aria-invalid={!arityValid || undefined} onChange={event => setMin(event.target.value)} />
          <label htmlFor={`${id}-max`}>{copy.maxValues}</label>
          <input id={`${id}-max`} name={`${option.key}-max-values`} className="app-input" inputMode="numeric" value={max} disabled={disabled}
            placeholder={copy.noLimit} aria-invalid={!arityValid || undefined} onChange={event => setMax(event.target.value)} />
        </span>
      )}
      {repeatUnknown && (
        <CustomSelect ariaLabel={`${copy.repeatable} (${name})`} value={repeat} disabled={disabled}
          options={[{ value: '', label: copy.repeatUnknown }, { value: 'yes', label: copy.repeatYes }, { value: 'no', label: copy.repeatNo }]}
          onChange={setRepeat} />
      )}
      <button type="button" className="app-button app-button--secondary" disabled={disabled || !ready} onClick={() => onConfirm(syntax)}>{copy.confirm}</button>
    </details>
  );
}
