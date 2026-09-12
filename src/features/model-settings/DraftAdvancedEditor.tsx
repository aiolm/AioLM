import { useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { parseChatOptions, parseServerArgs } from '../../shared/config/tuningValidation';
import { getOptionOccurrences, managedServerOption, replaceServerOption, serverOptionMatches, type ServerOption } from '../../shared/config/serverOptions';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { DraftPatch } from './DraftTuningEditor';

export default function DraftAdvancedEditor({ cfg, options, disabled, benchmark, onChange, onInvalid }: {
  cfg: AppConfig; options: readonly ServerOption[]; disabled: boolean; benchmark: boolean; onChange: DraftPatch; onInvalid: (key: string, invalid: boolean) => void;
}) {
  const { locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const [args, setArgs] = useState<string | null>(null);
  const [chat, setChat] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [optionDrafts, setOptionDrafts] = useState<Record<string, string>>({});
  const excluded = new Set(['--help', '--version', '--cache-list', '--completion-bash', '--list-devices']);
  const benchmarkFlags = /(?:parallel|ctx|context|timeout|sleep|cache|sampl|temp|top-p|top-k|seed|predict|reasoning-effort)/;
  const visible = options.filter(option => !managedServerOption(option) && !excluded.has(option.id) && (!benchmark || !benchmarkFlags.test(option.id)) && serverOptionMatches(option, query));
  return <div className="model-settings-fields">
    {error && <p className="text-error" role="alert">{error}</p>}
    <label>{copy.rawArgs}<textarea className="app-input font-mono" rows={6} spellCheck={false} disabled={disabled} value={args ?? cfg.server_args.join('\n')} onChange={event => {
      const raw = event.target.value; setArgs(raw);
      try { const server_args = parseServerArgs(raw); onChange({ server_args }); onInvalid('server_args', false); setError(''); }
      catch (cause) { onInvalid('server_args', true); setError(String(cause)); }
    }} /></label>
    {!benchmark && <label>{copy.rawChat}<textarea className="app-input font-mono" rows={7} spellCheck={false} disabled={disabled} value={chat ?? JSON.stringify(cfg.chat_options, null, 2)} onChange={event => {
      const raw = event.target.value; setChat(raw);
      try { const chat_options = parseChatOptions(raw); onChange({ chat_options }); onInvalid('chat_options', false); setError(''); }
      catch (cause) { onInvalid('chat_options', true); setError(String(cause)); }
    }} /></label>}
    <h3>{copy.options}</h3><input className="app-input" type="search" aria-label={copy.optionSearch} placeholder={copy.optionSearch} value={query} onChange={event => setQuery(event.target.value)} />
    <div className="model-settings-options">{visible.map(option => {
      const stored = getOptionOccurrences(cfg.server_args, option);
      const value = optionDrafts[option.id] ?? stored.map(item => item.values.join(' ')).join('\n');
      return <details key={option.id}><summary><code>{option.id}</code></summary><p className="app-section-hint">{option.description}</p>
        {option.arity === 0 ? <label><input type="checkbox" checked={stored.length > 0} disabled={disabled} onChange={event => { setArgs(null); onChange({ server_args: replaceServerOption(cfg.server_args, option, event.target.checked ? [{ flag: option.id, values: [] }] : []) }); }} />{copy.enabled}</label>
          : <label><span>{option.signature}</span><input className="app-input" value={value} disabled={disabled} onChange={event => {
            const raw = event.target.value; setOptionDrafts(previous => ({ ...previous, [option.id]: raw }));
            const values = option.arity === 1 ? [raw] : raw.trim().split(/\s+/);
            const valid = !raw || values.length === option.arity;
            onInvalid(option.id, !valid);
            if (valid) { setArgs(null); onChange({ server_args: replaceServerOption(cfg.server_args, option, raw ? [{ flag: option.id, values }] : []) }); }
          }} /></label>}
      </details>;
    })}</div>
  </div>;
}
