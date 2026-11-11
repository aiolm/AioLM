import { memo, useDeferredValue, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { inNumericRange, runtimeHelpImport, runtimeHelpResolve, type ConfirmedSyntax, type ImportedPlan, type OptionSchema, type OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { JsonOptionNumberError, parseJsonOption } from '../../shared/runtime/jsonOptionNumbers';

type Copy = (typeof runtimeOptionsCopy)['en'];

import { applyPlan, editOption, expandPlan, ImportedIntegerPrecisionError, moveOccurrence, ORDER_KEY, readOrder, readStored, setOccurrenceSpelling, writeStored } from './optionOrder';
import { display, kindOf, maskImportReview, maskPreview, supported } from './optionPresentation';

function isSwitch(option: OptionSchemaDefinition): boolean {
  return kindOf(option) === 'boolean' && supported(option.arity)?.max === 0;
}

function textual(option: OptionSchemaDefinition): boolean {
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

function optionName(option: OptionSchemaDefinition) {
  return option.spellings[0]?.flag ?? option.key;
}

/** Compound editors keep their values and row actions together at full width. */
function needsWideCard(option: OptionSchemaDefinition): boolean {
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

function ValueInput({ inputId, option, value, label, disabled, emptyMeans, copy, describedBy, validationDescription, onValue, onInvalid }: ValueInputProps) {
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
  const aliasSelect = spellings.length > 1 && (
    <CustomSelect
      ariaLabel={`${name} ${copy.spelling}`}
      value={current?.spelling ?? spellings[0].flag}
      disabled={locked || !current}
      options={spellings.map(spelling => ({ value: spelling.flag, label: spelling.flag }))}
      onChange={flag => current && store(current.rows, flag === spellings[0].flag ? null : flag)}
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
          {onRowSpelling && spellings.length > 1 && (
            <CustomSelect
              ariaLabel={`${name} ${copy.occurrence} ${rowIndex + 1} ${copy.spelling}`}
              // A null order spelling means this option's default, not the shared alias.
              value={(rowSpellings?.[rowIndex] === null ? spellings[0].flag : rowSpellings?.[rowIndex]) ?? current?.spelling ?? spellings[0].flag}
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

/** The saved command-line order of every orderable occurrence, reorderable
 * with buttons. Moving creates or updates the saved order record. */
export function OccurrenceOrder({ schema, values, disabled = false, onChange }: {
  schema: OptionSchema; values: Record<string, unknown>; disabled?: boolean; onChange: (next: Record<string, unknown>) => void;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const state = readOrder(values);
  const [status, setStatus] = useState('');
  if (!state.ok) {
    return (
      <FeedbackBanner tone="error">
        {copy.orderInvalid} ({state.error})
        <button type="button" className="app-button app-button--secondary" disabled={disabled}
          onClick={() => { const next = { ...values }; delete next[ORDER_KEY]; onChange(next); }}>{copy.discardOrder}</button>
      </FeedbackBanner>
    );
  }
  const plan = expandPlan(schema, values, state.order);
  if (plan.length < 2) return null;
  const options = new Map(schema.options.map(option => [option.key, option]));
  const label = (index: number) => {
    const item = plan[index];
    const flag = item.spelling ?? options.get(item.key)?.spellings[0]?.flag ?? item.key;
    const shown = supported(options.get(item.key)?.sensitive) === true ? item.values.map(() => '•••') : item.values.map(value => JSON.stringify(value));
    return [flag, ...shown].join(' ');
  };
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (disabled || target < 0 || target >= plan.length) return;
    onChange(moveOccurrence(schema, values, index, offset));
    setStatus(`${label(index)} → ${target + 1}`);
  };
  return (
    <section aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.orderTitle}</h4>
      <p className="app-section-hint">{copy.orderHint}</p>
      <ol>
        {plan.map((item, index) => (
          <li key={`${item.key}:${index}`}>
            <code>{label(index)}</code>{' '}
            {/* aria-disabled keeps focus on an edge button after a move. */}
            <button type="button" className="app-button app-button--secondary" aria-disabled={disabled || index === 0}
              aria-label={`${copy.moveUp}: ${label(index)}`} onClick={() => move(index, -1)}>{copy.moveUp}</button>
            <button type="button" className="app-button app-button--secondary" aria-disabled={disabled || index === plan.length - 1}
              aria-label={`${copy.moveDown}: ${label(index)}`} onClick={() => move(index, 1)}>{copy.moveDown}</button>
          </li>
        ))}
      </ol>
      <p role="status" className="app-section-hint">{status}</p>
    </section>
  );
}

function isApplicable(option: OptionSchemaDefinition, scope: string[]): boolean {
  return option.scope.length <= scope.length && option.scope.every((segment, index) => scope[index] === segment);
}

/** Items past the first screenful skip layout until scrolled near view. */
const DEFERRED_FROM = 12;
const deferredStyle: CSSProperties = { contentVisibility: 'auto', containIntrinsicSize: 'auto none auto 96px' };

export interface RuntimeOptionSchemaFormProps {
  schema: OptionSchema;
  values: Record<string, unknown>;
  scope: string[];
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
  /** Embedded in settings: fields only; validation and preview come from the host. */
  compact?: boolean;
  /** Show the complete option list without a separate expansion step. */
  showAll?: boolean;
  /** Embedded hosts can provide their own message when a category has no options. */
  showNoMatch?: boolean;
  filter?: (option: OptionSchemaDefinition) => boolean;
  readOnlyForOption?: (option: OptionSchemaDefinition) => boolean;
  inheritLabel?: (option: OptionSchemaDefinition) => string | undefined;
  hint?: (option: OptionSchemaDefinition) => string | undefined;
  onInvalid?: (key: string, invalid: boolean) => void;
  /** Message IDs from a host that validates the complete configuration. */
  validationDescriptions?: ReadonlyMap<string, string>;
  /** Saves confirmed syntax for a reviewed help option; omitted where none applies. */
  onConfirmSyntax?: (option: OptionSchemaDefinition, syntax: ConfirmedSyntax) => void;
  /** Options whose syntax may be confirmed (reviewed help options only). */
  confirmSyntaxFor?: (option: OptionSchemaDefinition) => boolean;
}

interface ImportRequestOwner { schema: OptionSchema; scopeKey: string; text: string }

/** Generic runtime-scoped option renderer, validator and argv preview. */
export default memo(function RuntimeOptionSchemaForm({ schema, values, scope, disabled = false, onChange, compact = false, showAll = false, showNoMatch = true, filter, readOnlyForOption, inheritLabel, hint, onInvalid, validationDescriptions, onConfirmSyntax, confirmSyntaxFor }: RuntimeOptionSchemaFormProps) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const formId = useId();
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const [limit, setLimit] = useState(64);
  const deferredSearch = useDeferredValue(search);
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const [preview, setPreview] = useState<string[] | null>(null);
  const [paste, setPaste] = useState('');
  const [acceptedImport, setAcceptedImport] = useState<{ request: ImportRequestOwner; result: ImportedPlan } | null>(null);
  const [failedImport, setFailedImport] = useState<{ request: ImportRequestOwner; message: string } | null>(null);
  const activeImport = useRef<ImportRequestOwner | null>(null);
  const scopeKey = JSON.stringify(scope);
  const importOwner = useRef({ schema, scopeKey, text: paste });
  const matchesRenderedOwner = (request: ImportRequestOwner) => request.schema === schema && request.scopeKey === scopeKey && request.text === paste;
  const ownsImport = (request: ImportRequestOwner) => activeImport.current === request
    && request.schema === importOwner.current.schema && request.scopeKey === importOwner.current.scopeKey && request.text === importOwner.current.text;
  const imported = acceptedImport && matchesRenderedOwner(acceptedImport.request) ? acceptedImport.result : null;
  const importError = failedImport && matchesRenderedOwner(failedImport.request) ? failedImport.message : '';
  const [error, setError] = useState('');

  useLayoutEffect(() => { importOwner.current = { schema, scopeKey, text: paste }; }, [schema, scopeKey, paste]);
  useLayoutEffect(() => {
    // A changed owner hides stale data during render and then releases it.
    // Equal scope contents and unrelated saved-value edits retain the import.
    setAcceptedImport(current => current && (current.request.schema !== schema || current.request.scopeKey !== scopeKey) ? null : current);
    setFailedImport(current => current && (current.request.schema !== schema || current.request.scopeKey !== scopeKey) ? null : current);
    return () => {
      // An older owner's cleanup must not invalidate a newer request.
      if (activeImport.current?.schema === schema && activeImport.current.scopeKey === scopeKey) activeImport.current = null;
    };
  }, [schema, scopeKey]);

  // Rebuilt on each render like the field list: hosts may update the same
  // schema object in place, and the category chooser must follow it.
  const groups = [...new Set(schema.options.map(option => option.group || 'runtime'))].sort();
  const schemaKeys = useMemo(() => new Set(schema.options.map(option => option.key)), [schema]);
  const visible = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return schema.options.filter(option => {
      if (filter && !filter(option)) return false;
      if (group && (option.group || 'runtime') !== group) return false;
      if (!query) return true;
      const haystack = `${option.key} ${option.spellings.map(s => s.flag).join(' ')} ${option.help} ${option.group}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [schema, deferredSearch, group, filter]);

  useEffect(() => {
    if (compact) return;
    let active = true;
    setError('');
    setPreview(null);
    const timer = setTimeout(() => {
      void runtimeHelpResolve(schema, scope, values)
        .then(result => { if (active) { setIssues([]); setPreview(result.argv); } })
        .catch(cause => {
          if (!active) return;
          if (Array.isArray(cause)) { setIssues(cause as Array<{ key: string; message: string }>); setPreview([]); } else setError(String(cause));
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [compact, schema, scope, values]);

  // Field edits keep a saved order record consistent: occurrence positions
  // and per-occurrence aliases follow the edited rows.
  const update = (key: string, next: unknown, origins?: Array<number | null>) => onChange(editOption(schema, values, key, next, origins));
  const order = useMemo(() => readOrder(values), [values]);
  const rowSpellings = useMemo(() => {
    const byKey = new Map<string, Array<string | null>>();
    if (!order.ok || !order.order) return byKey;
    for (const item of expandPlan(schema, values, order.order)) {
      const spellings = byKey.get(item.key);
      if (spellings) spellings.push(item.spelling ?? null);
      else byKey.set(item.key, [item.spelling ?? null]);
    }
    return byKey;
  }, [order, schema, values]);
  const masked = useMemo(() => (preview ? maskPreview(preview, schema, values) : null), [preview, schema, values]);
  const reviewedImport = useMemo(() => imported ? maskImportReview(imported, schema, values) : null, [imported, schema, values]);
  const unknownKeys = useMemo(() => Object.keys(values).filter(key => key !== ORDER_KEY && !schemaKeys.has(key)), [schemaKeys, values]);

  const issueDescriptions = useMemo(() => {
    const descriptions = new Map(validationDescriptions);
    issues.forEach((issue, index) => descriptions.set(issue.key, [descriptions.get(issue.key), `${formId}-issue-${index}`].filter(Boolean).join(' ')));
    return descriptions;
  }, [validationDescriptions, issues, formId]);

  const fields = (showAll ? visible : visible.slice(0, limit)).map((option, index) => (
    <div key={option.key} className={needsWideCard(option) ? 'schema-option-grid__wide' : undefined} style={index >= DEFERRED_FROM ? deferredStyle : undefined}>
      <SchemaOptionField option={option} stored={values[option.key]} disabled={disabled} readOnly={readOnlyForOption?.(option)} applicable={isApplicable(option, scope)}
        inheritLabel={inheritLabel?.(option)} hint={hint?.(option)} validationDescription={issueDescriptions.get(option.key)} onStore={(next, origins) => update(option.key, next, origins)} onInvalid={onInvalid}
        rowSpellings={rowSpellings.get(option.key)}
        onRowSpelling={order.ok ? (row, flag) => onChange(setOccurrenceSpelling(schema, values, option.key, row, flag)) : undefined}
        onConfirmSyntax={onConfirmSyntax && (!confirmSyntaxFor || confirmSyntaxFor(option)) ? syntax => onConfirmSyntax(option, syntax) : undefined} />
    </div>
  ));
  const navigation = (
        <fieldset className="schema-option-filter">
          <legend>{copy.legend}</legend>
          <label htmlFor={`${formId}-search`}>{copy.search}
            <input id={`${formId}-search`} name="schema-search" className="app-input" type="search" value={search}
              autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => { setSearch(event.target.value); setLimit(64); }} />
          </label>
          <label>{copy.group}
            <CustomSelect ariaLabel={copy.group} value={group} disabled={disabled}
              options={[{ value: '', label: copy.allGroups }, ...groups.map(name => ({ value: name, label: name }))]} onChange={next => { setGroup(next); setLimit(64); }} />
          </label>
        </fieldset>
  );
  const more = !showAll && visible.length > limit && <button type="button" className="app-button app-button--secondary" disabled={disabled}
    onClick={() => setLimit(current => current + 64)}>{copy.more} ({visible.length - limit})</button>;
  const fieldGrid = fields.length > 0 && <div className="schema-option-grid">{fields}</div>;
  if (compact) return <div className="model-settings-fields schema-option-form">{navigation}{fieldGrid}{more}{showNoMatch && visible.length === 0 && <p>{copy.noMatch}</p>}</div>;

  return (
    <div className="model-settings-fields schema-option-form">
      {navigation}
      {issues.map((issue, index) => <div key={`${issue.key}:${index}`} id={`${formId}-issue-${index}`}><FeedbackBanner tone="error">{issue.message}</FeedbackBanner></div>)}
      {unknownKeys.map(key => (
        <FeedbackBanner key={key} tone="error">
          {key} {copy.unknownKey}
          <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.remove}</button>
        </FeedbackBanner>
      ))}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {fieldGrid}
      <OccurrenceOrder schema={schema} values={values} disabled={disabled} onChange={onChange} />
      {more}
      {showNoMatch && visible.length === 0 && <p className="app-section-hint">{copy.noMatch}</p>}
      <details>
        <summary>{copy.importTitle}</summary>
        <label htmlFor={`${formId}-import`}>{copy.importLabel}</label>
        <textarea id={`${formId}-import`} name="schema-import" className="app-textarea" value={paste} disabled={disabled}
          autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onChange={event => { activeImport.current = null; setAcceptedImport(null); setFailedImport(null); setPaste(event.target.value); }} />
        <div className="app-page-actions mt-3">
          <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim()}
            onClick={() => {
              const request = { schema, scopeKey, text: paste };
              activeImport.current = request;
              setAcceptedImport(null); setFailedImport(null);
              void runtimeHelpImport(schema, scope, paste)
                .then(result => { if (ownsImport(request)) setAcceptedImport({ request, result }); })
                .catch(cause => {
                  if (!ownsImport(request)) return;
                  setAcceptedImport(null); setFailedImport({ request, message: cause instanceof Error ? cause.message : String(cause) });
                });
            }}>{copy.split}</button>
          {imported && (
            <button type="button" className="app-button app-button--secondary" disabled={disabled}
              onClick={() => {
                if (!acceptedImport || !ownsImport(acceptedImport.request)) return;
                const plan = readOnlyForOption ? acceptedImport.result.plan.filter(item => {
                  const option = schema.options.find(option => option.key === item.key);
                  return !option || !readOnlyForOption(option);
                }) : acceptedImport.result.plan;
                try { onChange(applyPlan(schema, values, { plan })); } catch (cause) { setFailedImport({ request: acceptedImport.request, message: cause instanceof ImportedIntegerPrecisionError ? copy.importIntegerPrecision : cause instanceof JsonOptionNumberError ? copy.jsonNumberRange : cause instanceof Error ? cause.message : String(cause) }); }
              }}>{copy.apply}</button>
          )}
        </div>
        {importError && <FeedbackBanner tone="error">{importError}</FeedbackBanner>}
        {imported && reviewedImport && (
          <div>
            <p className="app-section-hint">{copy.planOrder}: {imported.plan.map(item => item.key).join(', ') || '—'}</p>
            <p className="app-section-hint">{copy.groupedNote}</p>
            {reviewedImport.managed.length > 0 && <FeedbackBanner tone="warning">{copy.importManaged}: {reviewedImport.managed.join(' ')}</FeedbackBanner>}
            {reviewedImport.unrecognized.length > 0 && <FeedbackBanner tone="warning">{copy.importUnknown}: {reviewedImport.unrecognized.join(' ')}</FeedbackBanner>}
          </div>
        )}
      </details>
      <div aria-live="polite">
        <h4>{copy.preview}</h4>
        {masked === null ? <p className="app-section-hint">{copy.previewPending}</p>
          : <pre className="overflow-auto whitespace-pre-wrap">{masked.map(token => JSON.stringify(token)).join(' ')}</pre>}
      </div>
    </div>
  );
});
