import { memo, useDeferredValue, useEffect, useId, useMemo, useState } from 'react';
import { runtimeHelpImport, runtimeHelpResolve, type ImportedPlan, type OptionSchema, type OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';

export interface SchemaFormValues {
  values: Record<string, unknown>;
  scope: string[];
}

interface RowValues {
  rows: unknown[][];
  spelling?: string | null;
}

function rowsOf(stored: unknown): RowValues | undefined {
  if (stored === undefined) return undefined;
  if (stored !== null && typeof stored === 'object' && !Array.isArray(stored)) {
    const candidate = stored as { occurrences?: unknown; spelling?: unknown };
    if (Array.isArray(candidate.occurrences)) {
      const rows = (candidate.occurrences as unknown[]).map(row =>
        Array.isArray(row) ? [...row] : [row],
      );
      return {
        rows: rows as unknown[][],
        spelling: typeof candidate.spelling === 'string' ? candidate.spelling : null,
      };
    }
  }
  return { rows: [[stored]], spelling: null };
}

function storeRows(option: OptionSchemaDefinition, rows: unknown[][] | undefined, spelling?: string | null): unknown | undefined {
  if (!rows || rows.length === 0) return undefined;
  const singleSpelling = !spelling && option.spellings.length <= 1;
  if (singleSpelling && rows.length === 1 && rows[0].length === 1) return rows[0][0];
  return { spelling: spelling ?? null, occurrences: rows };
}

function isApplicable(option: OptionSchemaDefinition, scope: string[]): boolean {
  if (option.scope.length > scope.length) return false;
  return option.scope.every((segment, index) => scope[index] === segment);
}

function maskPreview(argv: string[], schema: OptionSchema, values: Record<string, unknown>): string[] {
  const secrets = new Set<string>();
  for (const option of schema.options) {
    if (option.sensitive.value !== true) continue;
    const rows = rowsOf(values[option.key]);
    for (const row of rows?.rows ?? []) {
      for (const cell of row) {
        if (typeof cell === 'string' && cell) secrets.add(cell);
        else if (typeof cell === 'number') secrets.add(String(cell));
      }
    }
  }
  return argv.map(token => {
    if (secrets.has(token)) return '•••';
    const equals = token.indexOf('=');
    if (equals > 0 && secrets.has(token.slice(equals + 1))) {
      return `${token.slice(0, equals + 1)}•••`;
    }
    return token;
  });
}

interface FieldProps {
  option: OptionSchemaDefinition;
  stored: unknown;
  disabled: boolean;
  applicable: boolean;
  onStore: (next: unknown | undefined) => void;
}

const BooleanField = memo(function BooleanField({ option, stored, disabled, applicable, onStore }: FieldProps) {
  const id = useId();
  const current = stored === true ? 'true' : stored === false ? 'false' : '';
  const helpId = `${id}-help`;
  return (
    <div className="schema-option" style={{ contentVisibility: 'auto' }}>
      <label htmlFor={id}>
        {option.spellings[0]?.flag ?? option.key}
        <small> · launch · inherit: runtime default</small>
      </label>
      <CustomSelect
        ariaLabel={option.spellings[0]?.flag ?? option.key}
        value={current}
        disabled={disabled || !applicable}
        options={[
          { value: '', label: 'Use runtime default' },
          { value: 'true', label: 'true' },
          { value: 'false', label: 'false' },
        ]}
        onChange={value => onStore(value === '' ? undefined : value === 'true')}
      />
      {option.help && <p id={helpId} className="app-section-hint">{option.help}</p>}
    </div>
  );
});

const TextField = memo(function TextField({ option, stored, disabled, applicable, onStore }: FieldProps) {
  const id = useId();
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const rows = rowsOf(stored);
  const single = rows?.rows[0]?.[0];
  const text = single === undefined ? '' : typeof single === 'object' ? JSON.stringify(single) : String(single);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  const [revealed, setRevealed] = useState(false);
  useEffect(() => { setDraft(text); setInvalid(false); }, [text]);
  const sensitive = option.sensitive.value === true;
  const kind = option.kind.value;
  const commit = (next: string) => {
    setDraft(next);
    if (!next.trim() && (option.arity.value?.min ?? 1) > 0) {
      onStore(undefined);
      setInvalid(false);
      return;
    }
    try {
      if (kind === 'json') {
        onStore(next.trim() ? JSON.parse(next) : undefined);
      } else if (kind === 'integer') {
        const parsed = Number(next);
        if (!Number.isSafeInteger(parsed)) throw new Error('range');
        onStore(parsed);
      } else if (kind === 'number') {
        const parsed = Number(next);
        if (!Number.isFinite(parsed)) throw new Error('range');
        onStore(parsed);
      } else {
        onStore(next);
      }
      setInvalid(false);
    } catch {
      setInvalid(true);
    }
  };
  return (
    <div className="schema-option" style={{ contentVisibility: 'auto' }}>
      <label htmlFor={id}>
        {option.spellings[0]?.flag ?? option.key}
        <small>
          {' '}· launch · inherit: runtime default
          {option.unit.value ? ` · ${option.unit.value}` : ''}
          {option.kind.certainty === 'unknown' ? ' · unverified type' : ''}
          {option.arity.certainty === 'unknown' ? ' · value count unconfirmed' : ''}
        </small>
      </label>
      {kind === 'json' ? (
        <textarea
          id={id}
          className="app-textarea"
          value={draft}
          disabled={disabled || !applicable}
          aria-describedby={`${helpId} ${invalid ? errorId : ''}`.trim()}
          aria-invalid={invalid || undefined}
          onChange={event => commit(event.target.value)}
          onBlur={event => commit(event.target.value)}
        />
      ) : (
        <input
          id={id}
          className="app-input"
          value={draft}
          disabled={disabled || !applicable}
          type={sensitive && !revealed ? 'password' : 'text'}
          inputMode={kind === 'integer' || kind === 'number' ? 'decimal' : 'text'}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={`${helpId} ${invalid ? errorId : ''}`.trim()}
          aria-invalid={invalid || undefined}
          onChange={event => commit(event.target.value)}
          onBlur={event => commit(event.target.value)}
        />
      )}
      {sensitive && (
        <button
          type="button"
          className="app-button app-button--secondary"
          aria-pressed={revealed}
          onClick={() => setRevealed(value => !value)}
        >
          {revealed ? 'Hide value' : 'Show value'}
        </button>
      )}
      {option.help && <p id={helpId} className="app-section-hint">{option.help}</p>}
      {option.runtime_default.value !== undefined && option.runtime_default.value !== null && (
        <p className="app-section-hint">Runtime default (display only): {JSON.stringify((option.runtime_default.value as { literal: unknown }).literal)}</p>
      )}
      {invalid && <p id={errorId} role="alert">Enter a valid value.</p>}
    </div>
  );
});

const ChoiceField = memo(function ChoiceField({ option, stored, disabled, applicable, onStore }: FieldProps) {
  const rows = rowsOf(stored);
  const current = rows?.rows[0]?.[0];
  const text = current === undefined ? '' : String(current);
  const choices = (option.choices.value ?? []).map(value => String(value));
  return (
    <div className="schema-option" style={{ contentVisibility: 'auto' }}>
      <label>
        {option.spellings[0]?.flag ?? option.key}
        <small> · launch · inherit: runtime default</small>
        <CustomSelect
          ariaLabel={option.spellings[0]?.flag ?? option.key}
          value={text}
          disabled={disabled || !applicable}
          options={[{ value: '', label: 'Use runtime default' }, ...choices.map(value => ({ value, label: value }))]}
          onChange={value => onStore(value === '' ? undefined : value)}
        />
      </label>
      {option.help && <p className="app-section-hint">{option.help}</p>}
    </div>
  );
});

function FieldForOption(props: FieldProps) {
  const { option } = props;
  if (option.managed) {
    return (
      <div className="schema-option" style={{ contentVisibility: 'auto' }}>
        <p>
          {option.spellings[0]?.flag ?? option.key}
          <small> · managed by the app; use its binding control</small>
        </p>
        {option.help && <p className="app-section-hint">{option.help}</p>}
      </div>
    );
  }
  if (option.kind.value === 'boolean') return <BooleanField {...props} />;
  if (Array.isArray(option.choices.value) && option.choices.value.length > 0) return <ChoiceField {...props} />;
  return <TextField {...props} />;
}

/** Generic runtime-scoped option renderer, validator and argv preview. */
export default memo(function RuntimeOptionSchemaForm({
  schema,
  values,
  scope,
  disabled = false,
  onChange,
}: {
  schema: OptionSchema;
  values: Record<string, unknown>;
  scope: string[];
  disabled?: boolean;
  onChange: (next: Record<string, unknown>) => void;
}) {
  const [search, setSearch] = useState('');
  const [group, setGroup] = useState('');
  const deferredSearch = useDeferredValue(search);
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const [preview, setPreview] = useState<string[]>([]);
  const [paste, setPaste] = useState('');
  const [imported, setImported] = useState<ImportedPlan | null>(null);
  const [importError, setImportError] = useState('');
  const [error, setError] = useState('');

  const groups = useMemo(() => {
    const seen = new Set<string>();
    for (const option of schema.options) seen.add(option.group || 'runtime');
    return [...seen].sort();
  }, [schema]);

  const visible = useMemo(() => {
    const query = deferredSearch.trim().toLowerCase();
    return schema.options.filter(option => {
      if (group && (option.group || 'runtime') !== group) return false;
      if (!query) return true;
      const haystack = `${option.key} ${(option.spellings ?? []).map(s => s.flag).join(' ')} ${option.help} ${option.group}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [schema, deferredSearch, group]);

  useEffect(() => {
    let active = true;
    setError('');
    const timer = setTimeout(() => {
      void runtimeHelpResolve(schema, scope, values)
        .then(result => {
          if (!active) return;
          setIssues([]);
          setPreview(result.argv);
        })
        .catch(cause => {
          if (!active) return;
          if (Array.isArray(cause)) {
            setIssues(cause as Array<{ key: string; message: string }>);
            setPreview([]);
          } else {
            setError(String(cause));
          }
        });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [schema, scope, values]);

  const update = (key: string, next: unknown | undefined) => {
    const copy = { ...values };
    if (next === undefined) delete copy[key];
    else copy[key] = next;
    onChange(copy);
  };

  const masked = useMemo(() => maskPreview(preview, schema, values), [preview, schema, values]);
  const unknownKeys = useMemo(
    () => Object.keys(values).filter(key => !schema.options.some(option => option.key === key)),
    [schema, values],
  );

  return (
    <div className="model-settings-fields">
      <form action="#" method="GET" onSubmit={event => event.preventDefault()}>
        <fieldset>
          <legend>Runtime options</legend>
          <label htmlFor="schema-search">Search options</label>
          <input
            id="schema-search"
            name="schema-search"
            className="app-input"
            type="search"
            value={search}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            onChange={event => setSearch(event.target.value)}
          />
          <label>Group
            <CustomSelect
              ariaLabel="Group"
              value={group}
              disabled={disabled}
              options={[{ value: '', label: 'All groups' }, ...groups.map(name => ({ value: name, label: name }))]}
              onChange={setGroup}
            />
          </label>
        </fieldset>
      </form>
      {issues.map((issue, index) => (
        <FeedbackBanner key={`${issue.key}:${index}`} tone="error">{issue.message}</FeedbackBanner>
      ))}
      {unknownKeys.map(key => (
        <FeedbackBanner key={key} tone="error">
          {key} is absent from this schema; the saved value was retained.
          <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>Remove</button>
        </FeedbackBanner>
      ))}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {visible.map(option => (
        <FieldForOption
          key={option.key}
          option={option}
          stored={values[option.key]}
          disabled={disabled}
          applicable={isApplicable(option, scope)}
          onStore={next => {
            const rows = next === undefined ? undefined : rowsOf(next)?.rows ?? [[next]];
            update(option.key, next === undefined ? undefined : storeRows(option, rows, rowsOf(next)?.spelling));
          }}
        />
      ))}
      {visible.length === 0 && <p className="app-section-hint">No options match this search.</p>}
      <details>
        <summary>Import a pasted command line</summary>
        <label htmlFor="schema-import">Pasted command (program and scope words are skipped when recognized)</label>
        <textarea
          id="schema-import"
          name="schema-import"
          className="app-textarea"
          value={paste}
          disabled={disabled}
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          onChange={event => { setPaste(event.target.value); setImportError(''); }}
        />
        <div className="app-page-actions mt-3">
          <button
            type="button"
            className="app-button app-button--secondary"
            disabled={disabled || !paste.trim()}
            onClick={() => {
              setImportError('');
              void runtimeHelpImport(schema, scope, paste)
                .then(result => setImported(result))
                .catch(cause => { setImported(null); setImportError(cause instanceof Error ? cause.message : String(cause)); });
            }}
          >
            Split into ordered plan
          </button>
          {imported && (
            <button
              type="button"
              className="app-button app-button--secondary"
              disabled={disabled}
              onClick={() => {
                const grouped = new Map<string, { spelling: string | null; occurrences: unknown[][] }>();
                for (const occurrence of imported.plan) {
                  const entry = grouped.get(occurrence.key) ?? { spelling: null as string | null, occurrences: [] as unknown[][] };
                  if (entry.spelling === null) entry.spelling = occurrence.spelling ?? null;
                  entry.occurrences.push(occurrence.values);
                  grouped.set(occurrence.key, entry);
                }
                const next: Record<string, unknown> = { ...values };
                for (const [key, entry] of grouped) {
                  const option = schema.options.find(item => item.key === key);
                  const defaultSpelling = option?.spellings[0]?.flag ?? null;
                  const spelling = !entry.spelling || entry.spelling === defaultSpelling ? null : entry.spelling;
                  const single = !spelling && (option?.spellings.length ?? 1) <= 1 && entry.occurrences.length === 1 && entry.occurrences[0].length === 1;
                  next[key] = single ? entry.occurrences[0][0] : { spelling, occurrences: entry.occurrences };
                }
                onChange(next);
              }}
            >
              Apply plan to values
            </button>
          )}
        </div>
        {importError && <FeedbackBanner tone="error">{importError}</FeedbackBanner>}
        {imported && (
          <div>
            <p className="app-section-hint">
              Plan order: {imported.plan.map(item => item.key).join(', ') || '—'}
            </p>
            {imported.managed.length > 0 && (
              <FeedbackBanner tone="warning">Managed by the app, not imported: {imported.managed.join(' ')}</FeedbackBanner>
            )}
            {imported.unrecognized.length > 0 && (
              <FeedbackBanner tone="warning">Unrecognized, kept for review: {imported.unrecognized.join(' ')}</FeedbackBanner>
            )}
          </div>
        )}
      </details>
      {masked.length > 0 && (
        <div>
          <h4>Launch preview</h4>
          <pre className="overflow-auto whitespace-pre-wrap">{masked.map(token => JSON.stringify(token)).join(' ')}</pre>
        </div>
      )}
    </div>
  );
});
