import { useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import type { ViewId } from '../../shared/types/navigation';
import { getOptionOccurrences, managedServerOption, serverOptionMatches, SERVER_OPTIONS_SOURCE, type OptionOccurrence, type ServerOption } from '../../shared/config/serverOptions';
import { serverOptionsText } from '../../shared/i18n/serverOptionsI18n';
import { TUNING_FIELD_CATALOG, type TuningCategoryId } from './tuningFields';
import type { useServerOptions } from './useServerOptions';
import { ServerOptionDefault } from './TuningOptionMetadata';
import { serverDefault } from '../../shared/config/optionDefaults';
import { defaultScalar } from '../../shared/config/tuningResetValues';
import { useEditorDraft } from '../../shared/state/draftGuard';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';

const MEMORY_OPTIONS = new Set(['--mmap', '--mlock', '--direct-io', '--load-mode', '--lazy-mode', '--numa', '--kv-offload', '--op-offload', '--repack', '--fit', '--fit-target', '--fit-ctx', '--cache-ram', '--swa-full']);
const LOAD_CHOICES = ['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio'];
const ACTION_OPTIONS = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices']);
const DESTINATIONS: Record<string, ViewId> = { '--model': 'models', '--mmproj': 'models', '--lora': 'lora', '--device': 'runtimes', '--main-gpu': 'runtimes', '--split-mode': 'runtimes', '--tensor-split': 'runtimes', '--port': 'api', '--host': 'api', '--api-key': 'api' };

interface Props {
  cfg: AppConfig;
  runtime: ReturnType<typeof useServerOptions>;
  disabled: boolean;
  rawDirty: boolean;
  query?: string;
  memoryOnly?: boolean;
  onSave: (option: ServerOption, occurrences: OptionOccurrence[]) => Promise<void>;
  onCategory: (category: TuningCategoryId) => void;
  onNavigate?: (view: ViewId) => void;
}

function OptionEditor({ option, args, disabled, onSave, single = false, options }: {
  option: ServerOption; args: string[]; disabled: boolean; onSave: Props['onSave']; single?: boolean; options: readonly ServerOption[];
}) {
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const stored = getOptionOccurrences(args, option);
  const [draft, setDraft] = useState<OptionOccurrence[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');
  const choices = option.id === '--load-mode' ? LOAD_CHOICES : option.choices;
  const scalar = defaultScalar(serverDefault(option, options).value);
  const pathArgument = /\b(?:FNAME|FILE|PATH|DIR)\b/.test(option.signature);
  const absent = typeof scalar === 'string' && !choices.includes(scalar)
    && (['disabled', 'unused', 'unset'].includes(scalar) || (pathArgument && scalar === 'none'));
  const initialValue = option.arity === 1 && scalar !== undefined && !absent ? String(scalar) : '';
  const initialItem = { flag: option.id, values: Array.from({ length: option.arity }, () => initialValue) };
  const occurrences = draft ?? stored;
  const inherited = occurrences.length === 0;
  const items = inherited ? [initialItem] : occurrences;
  const update = (index: number, item: OptionOccurrence) => setDraft(items.map((value, i) => i === index ? item : value));
  const append = () => {
    setDraft(inherited && option.arity === 0 ? [initialItem]
      : [...items, { flag: option.id, values: Array.from({ length: option.arity }, () => '') }]);
  };
  const save = async (values: OptionOccurrence[]) => {
    if (busy || disabled) return false;
    setBusy(true); setError(''); setFeedback('');
    try { await onSave(option, values); setDraft(null); setFeedback(copy.saved); return true; }
    catch (cause) { setError(String(cause)); return false; }
    finally { setBusy(false); }
  };
  const invalid = occurrences.some(item => item.values.length !== option.arity || item.values.some(value => !value.trim()));
  useEditorDraft({ dirty: draft !== null, save: async () => { if (invalid) { setError(copy.required); return false; } return save(occurrences); }, discard: () => { setDraft(null); setError(''); } });
  return <div className="server-option-editor">
    {inherited && <p className="server-option-default">{copy.inherited}</p>}
    {items.map((item, index) => <div className="server-option-occurrence" key={index}>
      <label><span>{copy.flag}</span><select className="app-select" aria-label={`${option.id} ${copy.flag} ${index + 1}`} value={inherited && option.arity === 0 ? '' : item.flag} disabled={disabled || busy}
        onChange={event => event.target.value ? update(index, { ...item, flag: event.target.value }) : setDraft(items.filter((_, i) => i !== index))}>
        {option.arity === 0 && <option value="">{copy.inherited}</option>}
        {option.flags.filter(flag => flag.startsWith('--') || !option.flags.some(value => value.startsWith('--'))).map(flag => <option key={flag}>{flag}</option>)}
        {!item.flag.startsWith('--') && <option>{item.flag}</option>}
      </select></label>
      {Array.from({ length: option.arity }, (_, argumentIndex) => <label key={argumentIndex}>
        <span>{copy.argument} {option.arity > 1 ? argumentIndex + 1 : ''}</span>
        <input className="app-input" aria-label={`${option.id} ${copy.argument} ${index + 1}.${argumentIndex + 1}`} list={choices.length ? `choices-${option.id}` : undefined}
          placeholder={normalizeDisplayText(option.signature)} value={normalizeDisplayText(item.values[argumentIndex] ?? '')} disabled={disabled || busy} spellCheck={false}
          onChange={event => { const values = [...item.values]; values[argumentIndex] = choices.find(value => normalizeDisplayText(value) === event.target.value) ?? event.target.value; update(index, { ...item, values }); }} />
      </label>)}
      {!inherited && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={disabled || busy} aria-label={`${option.id} ${copy.remove} ${index + 1}`}
        onClick={() => setDraft(items.filter((_, i) => i !== index))}>{copy.remove}</button>}
    </div>)}
    {choices.length > 0 && <datalist id={`choices-${option.id}`}>{choices.map(value => <option key={value} value={normalizeDisplayText(value)} />)}</datalist>}
    <div className="server-option-actions">
      {!single && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled || busy} onClick={append}>{copy.add}</button>}
      {draft && <button type="button" className="app-button app-button--primary app-button--sm" disabled={disabled || busy || invalid} onClick={() => void save(occurrences)}>{copy.save}</button>}
      {(draft !== null || stored.length > 0) && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled || busy} onClick={() => void save([])}>{copy.reset}</button>}
    </div>
    {invalid && <p className="app-section-hint">{copy.required}</p>}
    {feedback && <p className="server-option-default" role="status">{feedback}</p>}
    {error && <p className="text-error" role="alert">{normalizeDisplayText(error)}</p>}
  </div>;
}

export default function TuningServerOptions({ cfg, runtime, disabled, rawDirty, query = '', memoryOnly = false, onSave, onCategory, onNavigate }: Props) {
  const { locale } = useI18n();
  const copy = serverOptionsText[locale];
  const [localQuery, setLocalQuery] = useState('');
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const options = runtime.options.filter(option => (!memoryOnly || MEMORY_OPTIONS.has(option.id))
    && serverOptionMatches(option, query) && serverOptionMatches(option, localQuery)
    && (!configuredOnly || getOptionOccurrences(cfg.server_args, option).length > 0));
  return <section className="server-options tuning-section" aria-label={memoryOnly ? copy.memory : copy.title}>
    <div className="server-options-heading">
      {memoryOnly && <div><h3>{copy.memory}</h3><p className="app-section-hint">{copy.memoryHint}</p></div>}
      <button className="app-button app-button--secondary app-button--sm" type="button" disabled={runtime.loading} onClick={runtime.refresh}>{runtime.loading ? copy.loading : copy.refresh}</button>
    </div>
    <p className="app-section-hint" role="status">{runtime.verified ? copy.runtime : copy.fallback} · {options.length} {copy.count}</p>
    {!runtime.verified && runtime.error && <details><summary>{copy.unverified}</summary><p className="app-section-hint">{normalizeDisplayText(runtime.error)}</p></details>}
    {!memoryOnly && <div className="server-options-toolbar">
      <input className="app-input" type="search" value={localQuery} onChange={event => setLocalQuery(event.target.value)} aria-label={copy.search} placeholder={copy.search} />
      <label><input type="checkbox" checked={configuredOnly} onChange={event => setConfiguredOnly(event.target.checked)} />{copy.custom}</label>
      <a href={SERVER_OPTIONS_SOURCE} target="_blank" rel="noreferrer">{copy.source}</a>
    </div>}
    {rawDirty && <p role="status" className="app-section-hint">{copy.pending}</p>}
    <div className="server-options-list">
      {options.map(option => {
        const managed = managedServerOption(option);
        const field = managed ? TUNING_FIELD_CATALOG.find(item => item.aliases?.includes(managed)) : undefined;
        const destination = managed ? DESTINATIONS[managed] : undefined;
        const occurrences = getOptionOccurrences(cfg.server_args, option);
        return <details className="server-option" key={option.id} data-server-option={option.id}>
          <summary><code>{normalizeDisplayText(option.signature)}</code><span className="server-option-state">{managed ? copy.managed : occurrences.length ? `${copy.custom} · ${occurrences.length}` : copy.inherited}</span>
            <ServerOptionDefault option={option} options={runtime.options} verified={runtime.verified} />
          </summary>
          <p className="server-option-description">{normalizeDisplayText(option.description)}</p>
          {managed === '--port' ? <OptionEditor key={`port:${cfg.port}`} option={option} options={runtime.options} args={['--port', String(cfg.port)]} disabled={disabled || rawDirty} onSave={onSave} single /> : managed ? <div className="server-option-actions"><span>{copy.managed}</span>
            {field ? <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => onCategory(field.category)}>{copy.dedicated}</button>
              : destination && onNavigate ? <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => onNavigate(destination)}>{copy.dedicated}</button> : <p>{copy.lifecycle}</p>}
          </div> : ACTION_OPTIONS.has(option.id) ? <p className="app-section-hint">{copy.command}</p>
            : <OptionEditor key={`${option.id}:${JSON.stringify(occurrences)}`} option={option} options={runtime.options} args={cfg.server_args} disabled={disabled || rawDirty} onSave={onSave} />}
        </details>;
      })}
      {options.length === 0 && <p role="status" className="app-section-hint">{copy.noResults}</p>}
    </div>
  </section>;
}
