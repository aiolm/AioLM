import { memo, useCallback, useDeferredValue, useId, useMemo, useRef, useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { parseChatOptions } from '../../shared/config/tuningValidation';
import { getOptionOccurrences, managedServerOption, replaceServerOption, serverArgsFromText, serverArgsToText, serverOptionChoices, serverOptionMatches, type ServerOption } from '../../shared/config/serverOptions';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { DraftPatch } from './DraftTuningEditor';
import { advancedOptionDescription, advancedSettingsHelp } from './advancedSettingsHelp';

const EXCLUDED = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices']);
/**
 * How many option rows are put on screen at once.
 *
 * A runtime reports around 255 of them. Rendering every one built a subtree of
 * several thousand nodes that stayed mounted for the life of the dialog, and the
 * browser then re-ran style and layout over all of it on each keystroke and each
 * focus change — the work was never in the filtering, it was in the DOM. The
 * search field above the list is how the rest are reached.
 */
const VISIBLE_LIMIT = 40;
const BENCHMARK_FLAGS = /(?:parallel|ctx|context|timeout|sleep|cache|sampl|temp|top-p|top-k|seed|predict|reasoning-effort)/;

type Occurrence = { flag: string; values: string[] };
type Help = (typeof advancedSettingsHelp)['en'];

/**
 * One runtime option.
 *
 * Memoized, and given only values that stay identical while other fields change:
 * the list is the runtime's whole option set, and re-rendering all of it on every
 * keystroke anywhere in the dialog was what made typing here stutter.
 */
const AdvancedOptionRow = memo(function AdvancedOptionRow({
  option, description, choices, value, checked, disabled, idPrefix, help, enabledLabel, onSet, onDraft, onInvalid,
}: {
  option: ServerOption; description: string; choices: string[]; value: string; checked: boolean;
  disabled: boolean; idPrefix: string; help: Help; enabledLabel: string;
  onSet: (option: ServerOption, entries: Occurrence[]) => void;
  onDraft: (id: string, raw: string) => void;
  onInvalid: (key: string, invalid: boolean) => void;
}) {
  const descriptionId = `${idPrefix}-${option.id}-description`;
  const formatId = `${idPrefix}-${option.id}-format`;
  const describedBy = `${descriptionId} ${formatId}`;
  const choicesId = `${idPrefix}-${option.id}-choices`;
  return <div className="model-settings-option"><details><summary><code>{option.id}</code></summary>
    {option.arity === 0
      ? <label><input type="checkbox" aria-label={`${option.id} ${enabledLabel}`} aria-describedby={describedBy} checked={checked} disabled={disabled}
          onChange={event => onSet(option, event.target.checked ? [{ flag: option.id, values: [] }] : [])} />{enabledLabel}</label>
      : <label><span>{option.signature}</span><input className="app-input" aria-describedby={describedBy} value={value} disabled={disabled}
          placeholder={option.argument} list={choices.length ? choicesId : undefined} onChange={event => {
            const raw = event.target.value;
            onDraft(option.id, raw);
            const values = option.arity === 1 ? [raw] : raw.trim().split(/\s+/);
            const valid = !raw || values.length === option.arity;
            onInvalid(option.id, !valid);
            if (valid) onSet(option, raw ? [{ flag: option.id, values }] : []);
          }} />{choices.length > 0 && <datalist id={choicesId}>{choices.map(choice => <option key={choice} value={choice} />)}</datalist>}</label>}
  </details><p className="app-section-hint whitespace-pre-line break-words"><span id={descriptionId}>{description}</span>
    <span id={formatId} className="model-settings-option-format">{option.arity === 0 ? help.toggle : option.arity === 1 ? help.single : help.multiple}
      {choices.length > 0 && <> {help.choices}: {choices.join(', ')}.</>}</span>
  </p></div>;
});

export default function DraftAdvancedEditor({ cfg, options, disabled, benchmark, onChange, onInvalid }: {
  cfg: AppConfig; options: readonly ServerOption[]; disabled: boolean; benchmark: boolean; onChange: DraftPatch; onInvalid: (key: string, invalid: boolean) => void;
}) {
  const { locale, t } = useI18n();
  const id = useId();
  const copy = modelSettingsCopy[locale];
  const help = advancedSettingsHelp[locale];
  const [args, setArgs] = useState<string | null>(null);
  const [chat, setChat] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  // Held in refs so the row callbacks keep one identity: props that change every
  // render defeat the memo above, which is the whole point of it.
  const argsRef = useRef(cfg.server_args); argsRef.current = cfg.server_args;
  const changeRef = useRef(onChange); changeRef.current = onChange;
  const invalidRef = useRef(onInvalid); invalidRef.current = onInvalid;

  // Translating a description and scanning it for documented values is the
  // expensive part, and it depends on the runtime's option set, not on typing.
  const catalogue = useMemo(() => options
    .filter(option => !managedServerOption(option) && !EXCLUDED.has(option.id) && (!benchmark || !BENCHMARK_FLAGS.test(option.id)))
    .map(option => {
      const description = advancedOptionDescription(option, locale, t);
      return { option, description, choices: serverOptionChoices(option), haystack: { ...option, description: `${option.description} ${description}` } };
    }), [options, locale, benchmark, t]);

  // Searching stays off the keystroke's critical path; the field itself never waits.
  const search = useDeferredValue(query);
  const matching = useMemo(() => catalogue.filter(entry => serverOptionMatches(entry.haystack, search)), [catalogue, search]);
  const visible = matching.length > VISIBLE_LIMIT ? matching.slice(0, VISIBLE_LIMIT) : matching;
  const stored = useMemo(() => new Map(visible.map(entry => [entry.option.id, getOptionOccurrences(cfg.server_args, entry.option)])), [visible, cfg.server_args]);

  const setOption = useCallback((option: ServerOption, entries: Occurrence[]) => {
    setArgs(null);
    changeRef.current({ server_args: replaceServerOption(argsRef.current, option, entries) });
  }, []);
  const draftOption = useCallback((optionId: string, raw: string) => {
    setOptionDrafts(previous => ({ ...previous, [optionId]: raw }));
  }, []);
  const markInvalid = useCallback((key: string, invalid: boolean) => invalidRef.current(key, invalid), []);

  return <div className="model-settings-fields">
    {error && <p className="text-error" role="alert">{error}</p>}
    <div><label htmlFor={`${id}-args`}>{copy.rawArgs}</label>
    <textarea id={`${id}-args`} aria-describedby={`${id}-args-help`} className="app-input font-mono" rows={6} spellCheck={false} disabled={disabled} value={args ?? serverArgsToText(cfg.server_args, options)} onChange={event => {
      const raw = event.target.value; setArgs(raw);
      try { const server_args = serverArgsFromText(raw, options); onChange({ server_args }); onInvalid('server_args', false); setError(''); }
      catch (cause) { onInvalid('server_args', true); setError(String(cause)); }
    }} /><p id={`${id}-args-help`} className="app-section-hint">{help.args}</p></div>
    {!benchmark && <div><label htmlFor={`${id}-chat`}>{copy.rawChat}</label>
    <textarea id={`${id}-chat`} aria-describedby={`${id}-chat-help`} className="app-input font-mono" rows={7} spellCheck={false} disabled={disabled} value={chat ?? JSON.stringify(cfg.chat_options, null, 2)} onChange={event => {
      const raw = event.target.value; setChat(raw);
      try { const chat_options = parseChatOptions(raw); onChange({ chat_options }); onInvalid('chat_options', false); setError(''); }
      catch (cause) { onInvalid('chat_options', true); setError(String(cause)); }
    }} /><p id={`${id}-chat-help`} className="app-section-hint">{help.chat}</p></div>}
    <div><h3>{copy.options}</h3><p className="app-section-hint">{help.options}</p></div>
    <div><input className="app-input" type="search" aria-label={copy.optionSearch} aria-describedby={`${id}-search-help`} placeholder={copy.optionSearch} value={query} onChange={event => setQuery(event.target.value)} />
      <p id={`${id}-search-help`} className="app-section-hint">{help.search}</p></div>
    <div className="model-settings-options">{visible.map(({ option, description, choices }) => {
      const occurrences = stored.get(option.id) ?? [];
      return <AdvancedOptionRow key={option.id} option={option} description={description} choices={choices}
        value={optionDrafts[option.id] ?? occurrences.map(item => item.values.join(' ')).join('\n')}
        checked={occurrences.length > 0} disabled={disabled} idPrefix={id} help={help} enabledLabel={copy.enabled}
        onSet={setOption} onDraft={draftOption} onInvalid={markInvalid} />;
    })}{visible.length === 0 && <p className="app-section-hint" role="status">{help.noResults}</p>}
      {matching.length > visible.length && <p className="app-section-hint" role="status">{copy.optionsTruncated.replace('{shown}', String(visible.length)).replace('{total}', String(matching.length))}</p>}</div>
  </div>;
}
