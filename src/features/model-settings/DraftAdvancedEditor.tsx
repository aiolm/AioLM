import { useId, useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { parseChatOptions, parseServerArgs } from '../../shared/config/tuningValidation';
import { getOptionOccurrences, managedServerOption, replaceServerOption, serverOptionMatches, type ServerOption } from '../../shared/config/serverOptions';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { DraftPatch } from './DraftTuningEditor';
import { advancedOptionDescription, advancedSettingsHelp } from './advancedSettingsHelp';

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
  const excluded = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices']);
  const benchmarkFlags = /(?:parallel|ctx|context|timeout|sleep|cache|sampl|temp|top-p|top-k|seed|predict|reasoning-effort)/;
  const visible = options.filter(option => !managedServerOption(option) && !excluded.has(option.id) && (!benchmark || !benchmarkFlags.test(option.id)))
    .map(option => ({ option, description: advancedOptionDescription(option, locale, t) }))
    .filter(({ option, description }) => serverOptionMatches({ ...option, description: `${option.description} ${description}` }, query));
  return <div className="model-settings-fields">
    {error && <p className="text-error" role="alert">{error}</p>}
    <div><label htmlFor={`${id}-args`}>{copy.rawArgs}</label>
    <textarea id={`${id}-args`} aria-describedby={`${id}-args-help`} className="app-input font-mono" rows={6} spellCheck={false} disabled={disabled} value={args ?? cfg.server_args.join('\n')} onChange={event => {
      const raw = event.target.value; setArgs(raw);
      try { const server_args = parseServerArgs(raw); onChange({ server_args }); onInvalid('server_args', false); setError(''); }
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
    <div className="model-settings-options">{visible.map(({ option, description }) => {
      const stored = getOptionOccurrences(cfg.server_args, option);
      const value = optionDrafts[option.id] ?? stored.map(item => item.values.join(' ')).join('\n');
      const descriptionId = `${id}-${option.id}-description`;
      const formatId = `${id}-${option.id}-format`;
      const describedBy = `${descriptionId} ${formatId}`;
      return <div key={option.id} className="model-settings-option"><details><summary><code>{option.id}</code></summary>
        {option.arity === 0 ? <label><input type="checkbox" aria-label={`${option.id} ${copy.enabled}`} aria-describedby={describedBy} checked={stored.length > 0} disabled={disabled} onChange={event => { setArgs(null); onChange({ server_args: replaceServerOption(cfg.server_args, option, event.target.checked ? [{ flag: option.id, values: [] }] : []) }); }} />{copy.enabled}</label>
          : <label><span>{option.signature}</span><input className="app-input" aria-describedby={describedBy} value={value} disabled={disabled} onChange={event => {
            const raw = event.target.value; setOptionDrafts(previous => ({ ...previous, [option.id]: raw }));
            const values = option.arity === 1 ? [raw] : raw.trim().split(/\s+/);
            const valid = !raw || values.length === option.arity;
            onInvalid(option.id, !valid);
            if (valid) { setArgs(null); onChange({ server_args: replaceServerOption(cfg.server_args, option, raw ? [{ flag: option.id, values }] : []) }); }
          }} /></label>}
      </details><p className="app-section-hint whitespace-pre-line break-words"><span id={descriptionId}>{description}</span>
        <span id={formatId} className="model-settings-option-format">{option.arity === 0 ? help.toggle : option.arity === 1 ? help.single : help.multiple}
          {option.choices.length > 0 && <> {help.choices}: {option.choices.join(', ')}.</>}</span>
      </p></div>;
    })}{visible.length === 0 && <p className="app-section-hint" role="status">{help.noResults}</p>}</div>
  </div>;
}
