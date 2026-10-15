import { memo, useDeferredValue, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { runtimeHelpImport, runtimeHelpResolve, type ConfirmedSyntax, type ImportedPlan, type OptionSchema, type OptionSchemaDefinition, type OptionSchemaFact } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';

type Copy = (typeof runtimeOptionsCopy)['en'];

import { applyPlan, editOption, expandPlan, moveOccurrence, ORDER_KEY, readOrder, readStored, setOccurrenceSpelling, writeStored } from './optionOrder';
export { readStored, writeStored, applyPlan, type StoredOption } from './optionOrder';

function supported<T>(fact: OptionSchemaFact<T> | undefined): T | undefined {
  return fact && fact.certainty !== 'unknown' ? (fact.value ?? undefined) : undefined;
}

function kindOf(option: OptionSchemaDefinition): string | undefined {
  return supported(option.kind);
}

function isSwitch(option: OptionSchemaDefinition): boolean {
  return kindOf(option) === 'boolean' && supported(option.arity)?.max === 0;
}

function textual(option: OptionSchemaDefinition): boolean {
  const kind = kindOf(option);
  return kind === undefined || kind === 'text' || kind === 'tokens';
}

function display(value: unknown): string {
  if (value === undefined) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** Parses typed text by the option's documented kind; unknown kinds stay text. */
function parseValue(option: OptionSchemaDefinition, text: string): { ok: true; value: unknown } | { ok: false } {
  const kind = kindOf(option);
  if (kind === 'integer') {
    const value = Number(text);
    return /^\s*-?\d+\s*$/.test(text) && Number.isSafeInteger(value) ? { ok: true, value } : { ok: false };
  }
  if (kind === 'number') {
    const value = Number(text);
    return text.trim() !== '' && Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  if (kind === 'json') {
    try {
      return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
      return { ok: false };
    }
  }
  return { ok: true, value: text };
}

function optionName(option: OptionSchemaDefinition) {
  return option.spellings[0]?.flag ?? option.key;
}

/** Where the option's established facts come from: observed help, an
 * adapter's catalog or metadata (by id and revision), or the user. Unknown
 * facts have no source and are marked separately. */
function factSources(option: OptionSchemaDefinition, copy: Copy): string | undefined {
  const facts = [option.kind, option.arity, option.repeatable, option.choices, option.range, option.unit,
    option.runtime_default, option.request_field, option.restart_required, option.sensitive, option.local_path];
  let help = false;
  let user = false;
  const adapters: string[] = [];
  for (const fact of facts) {
    if (!fact || fact.certainty === 'unknown' || !fact.source || typeof fact.source !== 'object') continue;
    const source = fact.source as { kind?: string; id?: string; revision?: string };
    if (source.kind === 'help') help = true;
    else if (source.kind === 'user') user = true;
    else if (source.kind === 'adapter') {
      const label = `${copy.sourceAdapter} ${source.id} (${source.revision})`;
      if (!adapters.includes(label)) adapters.push(label);
    }
  }
  const labels = [...(help ? [copy.sourceHelp] : []), ...adapters, ...(user ? [copy.sourceUser] : [])];
  return labels.length ? `${copy.documentedBy}: ${labels.join(', ')}` : undefined;
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
  onValue: (value: unknown) => void;
  onInvalid: (invalid: boolean) => void;
}

function ValueInput({ inputId, option, value, label, disabled, emptyMeans, copy, describedBy, onValue, onInvalid }: ValueInputProps) {
  const generated = useId();
  const id = inputId ?? generated;
  const ariaLabel = inputId ? undefined : label;
  const errorId = `${id}-error`;
  const text = display(value);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setDraft(text); setInvalid(false); }, [text]);
  const kind = kindOf(option);
  const sensitive = supported(option.sensitive) === true;
  const choices = supported(option.choices) ?? [];
  const markInvalid = (next: boolean) => { setInvalid(next); onInvalid(next); };
  const describedByIds = [describedBy, invalid ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  if (choices.length > 0) {
    // Choices keep their documented JSON type by position, never via String().
    const index = choices.findIndex(choice => JSON.stringify(choice) === JSON.stringify(value));
    return (
      <CustomSelect
        ariaLabel={label}
        value={index < 0 ? '' : String(index)}
        disabled={disabled}
        options={[
          { value: '', label: emptyMeans === 'inherit' ? copy.inherit : copy.value },
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
        value={value === true ? 'true' : value === false ? 'false' : ''}
        disabled={disabled}
        options={[{ value: '', label: copy.inherit }, { value: 'true', label: 'true' }, { value: 'false', label: 'false' }]}
        onChange={selected => onValue(selected === '' ? undefined : selected === 'true')}
      />
    );
  }
  const commit = (next: string) => {
    setDraft(next);
    if (next === '' && (emptyMeans === 'inherit' || !textual(option))) {
      markInvalid(emptyMeans === 'empty');
      if (emptyMeans === 'inherit') onValue(undefined);
      return;
    }
    const parsed = parseValue(option, next);
    if (!parsed.ok) { markInvalid(true); return; }
    markInvalid(false);
    onValue(parsed.value);
  };
  const hide = sensitive && !revealed;
  return (
    <span className="schema-option__value">
      {kind === 'json' ? (
        hide ? (
          <input id={id} className="app-input" type="password" value={draft} disabled={disabled} aria-label={ariaLabel} readOnly placeholder={copy.hidden} />
        ) : (
          <textarea id={id} name={label} className="app-textarea" value={draft} disabled={disabled} aria-label={ariaLabel}
            aria-describedby={describedByIds} aria-invalid={invalid || undefined}
            onChange={event => commit(event.target.value)} onBlur={event => commit(event.target.value)} />
        )
      ) : (
        <input id={id} name={label} className="app-input" value={draft} disabled={disabled} aria-label={ariaLabel}
          type={hide ? 'password' : 'text'} inputMode={kind === 'integer' || kind === 'number' ? 'decimal' : 'text'}
          autoCorrect="off" autoCapitalize="off" spellCheck={false}
          aria-describedby={describedByIds} aria-invalid={invalid || undefined}
          onChange={event => commit(event.target.value)} onBlur={event => commit(event.target.value)} />
      )}
      {sensitive && (
        <button type="button" className="app-button app-button--secondary" aria-pressed={revealed} disabled={disabled}
          onClick={() => setRevealed(current => !current)}>{revealed ? copy.hide : copy.show}</button>
      )}
      {invalid && <span id={errorId} role="alert">{copy.invalid}</span>}
    </span>
  );
}

export interface SchemaOptionFieldProps {
  option: OptionSchemaDefinition;
  stored: unknown;
  disabled: boolean;
  applicable?: boolean;
  /** Label for "no saved value" (e.g. an automatic capability default). */
  inheritLabel?: string;
  hint?: string;
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
export const SchemaOptionField = memo(function SchemaOptionField({ option, stored, disabled, applicable = true, inheritLabel, hint, onStore, onInvalid, rowSpellings, onRowSpelling, onConfirmSyntax }: SchemaOptionFieldProps) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const helpId = `${id}-help`;
  const name = optionName(option);
  const current = readStored(stored);
  const arity = supported(option.arity);
  const repeatable = supported(option.repeatable) === true;
  const locked = disabled || !applicable || !!option.managed;
  const spellings = option.spellings.filter(spelling => spelling.polarity === undefined || spelling.polarity === null);
  const invalidCells = useRef(new Set<string>());
  const report = (cell: string, invalid: boolean) => {
    if (invalid) invalidCells.current.add(cell); else invalidCells.current.delete(cell);
    onInvalid?.(`schema:${option.key}`, invalidCells.current.size > 0);
  };
  useEffect(() => () => onInvalid?.(`schema:${option.key}`, false), [option.key, onInvalid]);
  const store = (rows: unknown[][], spelling = current?.spelling ?? null, origins?: Array<number | null>) => onStore(writeStored(rows, spelling), origins);
  const defaultValue = supported(option.runtime_default);
  const confirmed = option.arity.certainty === 'user_confirmed' || option.repeatable.certainty === 'user_confirmed';
  const facts = [
    option.target === 'request' ? copy.request : copy.launch,
    `${copy.inherit}: ${inheritLabel ?? (defaultValue ? display(defaultValue.literal) : copy.inherit)}`,
    supported(option.unit),
    supported(option.restart_required) === true ? copy.restartRequired : undefined,
    supported(option.sensitive) === true ? copy.secretValue : undefined,
    option.kind.certainty === 'unknown' && !isSwitch(option) ? copy.unverifiedType : undefined,
    option.arity.certainty === 'unknown' && option.target === 'launch' ? copy.unconfirmedArity : undefined,
    confirmed ? copy.confirmedByYou : undefined,
    factSources(option, copy),
  ].filter(Boolean).join(' · ');
  const header = (
    <span className="schema-option__header">
      <span id={`${id}-name`}>{name}</span> <small>{facts}</small>
    </span>
  );
  const syntaxUnknown = option.target === 'launch' && !option.managed
    && (option.arity.certainty === 'unknown' || option.repeatable.certainty === 'unknown');
  const help = (
    <>
      {hint && <small>{hint}</small>}
      {option.help && <p id={helpId} className="app-section-hint">{option.help}</p>}
      {!applicable && <p className="app-section-hint">{copy.notApplicable}</p>}
      {onConfirmSyntax && syntaxUnknown && <ConfirmSyntax option={option} name={name} disabled={disabled} copy={copy} onConfirm={onConfirmSyntax} />}
    </>
  );
  if (option.managed) {
    return (
      <div className="schema-option">
        <p>{name} <small>· {copy.managed}</small></p>
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
        <CustomSelect
          ariaLabel={name}
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
        {explicitEmpty ? (
          <span className="schema-option__value">
            <span>{copy.emptySet}</span>
            <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => onStore(undefined)}>{copy.useDefault}</button>
          </span>
        ) : (
          <SingleValue option={option} value={value} label={name} disabled={locked} copy={copy} describedBy={option.help ? helpId : undefined}
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
      {rows.map((row, rowIndex) => (
        <div key={rowIndex} className="schema-option__row" role="group" aria-label={`${name} ${copy.occurrence} ${rowIndex + 1}`}>
          {row.map((cell, cellIndex) => (
            <span key={cellIndex} className="schema-option__cell">
              <ValueInput option={option} value={cell} label={`${name} ${copy.occurrence} ${rowIndex + 1} ${copy.value} ${cellIndex + 1}`}
                disabled={locked} emptyMeans="empty" copy={copy}
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
              value={rowSpellings?.[rowIndex] ?? current?.spelling ?? spellings[0].flag}
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
      {rows.length > 0 && (
        <button type="button" className="app-button app-button--secondary" disabled={locked} onClick={() => onStore(undefined)}>{copy.useDefault}</button>
      )}
      {aliasSelect}
      {help}
    </fieldset>
  );
});

function SingleValue({ option, value, label, disabled, copy, describedBy, inputId, onValue, onInvalid }: {
  option: OptionSchemaDefinition; value: unknown; label: string; disabled: boolean; copy: Copy; describedBy?: string;
  inputId: string; onValue: (value: unknown) => void; onInvalid: (invalid: boolean) => void;
}) {
  // The label element points at the first focusable control rendered below.
  return (
    <span className="schema-option__single">
      <ValueInput inputId={inputId} option={option} value={value} label={label} disabled={disabled} emptyMeans="inherit" copy={copy}
        describedBy={describedBy} onValue={onValue} onInvalid={onInvalid} />
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

export function maskPreview(argv: string[], schema: OptionSchema, values: Record<string, unknown>): string[] {
  const secrets = new Set<string>();
  for (const option of schema.options) {
    if (supported(option.sensitive) !== true) continue;
    for (const row of readStored(values[option.key])?.rows ?? []) {
      for (const cell of row) {
        const text = display(cell);
        if (text) secrets.add(text);
      }
    }
  }
  return argv.map(token => {
    if (secrets.has(token)) return '•••';
    const equals = token.indexOf('=');
    return equals > 0 && secrets.has(token.slice(equals + 1)) ? `${token.slice(0, equals + 1)}•••` : token;
  });
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
  filter?: (option: OptionSchemaDefinition) => boolean;
  inheritLabel?: (option: OptionSchemaDefinition) => string | undefined;
  hint?: (option: OptionSchemaDefinition) => string | undefined;
  onInvalid?: (key: string, invalid: boolean) => void;
  /** Saves confirmed syntax for a reviewed help option; omitted where none applies. */
  onConfirmSyntax?: (option: OptionSchemaDefinition, syntax: ConfirmedSyntax) => void;
  /** Options whose syntax may be confirmed (reviewed help options only). */
  confirmSyntaxFor?: (option: OptionSchemaDefinition) => boolean;
}

/** Generic runtime-scoped option renderer, validator and argv preview. */
export default memo(function RuntimeOptionSchemaForm({ schema, values, scope, disabled = false, onChange, compact = false, filter, inheritLabel, hint, onInvalid, onConfirmSyntax, confirmSyntaxFor }: RuntimeOptionSchemaFormProps) {
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
  const [imported, setImported] = useState<ImportedPlan | null>(null);
  const [importError, setImportError] = useState('');
  const [error, setError] = useState('');

  const groups = useMemo(() => [...new Set(schema.options.map(option => option.group || 'runtime'))].sort(), [schema]);
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
    for (const item of expandPlan(schema, values, order.order)) byKey.set(item.key, [...(byKey.get(item.key) ?? []), item.spelling ?? null]);
    return byKey;
  }, [order, schema, values]);
  const masked = useMemo(() => (preview ? maskPreview(preview, schema, values) : null), [preview, schema, values]);
  const unknownKeys = useMemo(() => Object.keys(values).filter(key => key !== ORDER_KEY && !schema.options.some(option => option.key === key)), [schema, values]);

  const fields = visible.slice(0, limit).map((option, index) => (
    <div key={option.key} style={index >= DEFERRED_FROM ? deferredStyle : undefined}>
      <SchemaOptionField option={option} stored={values[option.key]} disabled={disabled} applicable={isApplicable(option, scope)}
        inheritLabel={inheritLabel?.(option)} hint={hint?.(option)} onStore={(next, origins) => update(option.key, next, origins)} onInvalid={onInvalid}
        rowSpellings={rowSpellings.get(option.key)}
        onRowSpelling={order.ok ? (row, flag) => onChange(setOccurrenceSpelling(schema, values, option.key, row, flag)) : undefined}
        onConfirmSyntax={onConfirmSyntax && (!confirmSyntaxFor || confirmSyntaxFor(option)) ? syntax => onConfirmSyntax(option, syntax) : undefined} />
    </div>
  ));
  const navigation = (
        <fieldset>
          <legend>{copy.legend}</legend>
          <label htmlFor={`${formId}-search`}>{copy.search}</label>
          <input id={`${formId}-search`} name="schema-search" className="app-input" type="search" value={search}
            autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => { setSearch(event.target.value); setLimit(64); }} />
          <label>{copy.group}
            <CustomSelect ariaLabel={copy.group} value={group} disabled={disabled}
              options={[{ value: '', label: copy.allGroups }, ...groups.map(name => ({ value: name, label: name }))]} onChange={next => { setGroup(next); setLimit(64); }} />
          </label>
        </fieldset>
  );
  const more = visible.length > limit && <button type="button" className="app-button app-button--secondary" disabled={disabled}
    onClick={() => setLimit(current => current + 64)}>{copy.more} ({visible.length - limit})</button>;
  if (compact) return <div className="model-settings-fields">{navigation}{fields}{more}{visible.length === 0 && <p>{copy.noMatch}</p>}</div>;

  return (
    <div className="model-settings-fields">
      {navigation}
      {issues.map((issue, index) => <FeedbackBanner key={`${issue.key}:${index}`} tone="error">{issue.message}</FeedbackBanner>)}
      {unknownKeys.map(key => (
        <FeedbackBanner key={key} tone="error">
          {key} {copy.unknownKey}
          <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.remove}</button>
        </FeedbackBanner>
      ))}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {fields}
      <OccurrenceOrder schema={schema} values={values} disabled={disabled} onChange={onChange} />
      {more}
      {visible.length === 0 && <p className="app-section-hint">{copy.noMatch}</p>}
      <details>
        <summary>{copy.importTitle}</summary>
        <label htmlFor={`${formId}-import`}>{copy.importLabel}</label>
        <textarea id={`${formId}-import`} name="schema-import" className="app-textarea" value={paste} disabled={disabled}
          autoCorrect="off" autoCapitalize="off" spellCheck={false}
          onChange={event => { setPaste(event.target.value); setImportError(''); }} />
        <div className="app-page-actions mt-3">
          <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim()}
            onClick={() => {
              setImportError('');
              void runtimeHelpImport(schema, scope, paste)
                .then(result => setImported(result))
                .catch(cause => { setImported(null); setImportError(cause instanceof Error ? cause.message : String(cause)); });
            }}>{copy.split}</button>
          {imported && (
            <button type="button" className="app-button app-button--secondary" disabled={disabled}
              onClick={() => {
                try { onChange(applyPlan(schema, values, imported)); } catch (cause) { setImportError(cause instanceof Error ? cause.message : String(cause)); }
              }}>{copy.apply}</button>
          )}
        </div>
        {importError && <FeedbackBanner tone="error">{importError}</FeedbackBanner>}
        {imported && (
          <div>
            <p className="app-section-hint">{copy.planOrder}: {imported.plan.map(item => item.key).join(', ') || '—'}</p>
            <p className="app-section-hint">{copy.groupedNote}</p>
            {imported.managed.length > 0 && <FeedbackBanner tone="warning">{copy.importManaged}: {imported.managed.join(' ')}</FeedbackBanner>}
            {imported.unrecognized.length > 0 && <FeedbackBanner tone="warning">{copy.importUnknown}: {imported.unrecognized.join(' ')}</FeedbackBanner>}
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
