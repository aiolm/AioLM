import { useState } from 'react';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import type { ServerOption } from '../../shared/config/serverOptions';
import { parseSettingsText, type RejectedSetting } from './settingsImport';
import { modelSettingsCopy } from './modelSettingsCopy';
import type { DraftPatch } from './DraftTuningEditor';

function rejectionText(entry: RejectedSetting, copy: (typeof modelSettingsCopy)['en']): string {
  if (entry.reason === 'unknown') return `${entry.flag} — ${copy.pasteUnknown}`;
  if (entry.reason === 'missing') return `${entry.flag} — ${copy.pasteMissing}`;
  const range = entry.range ? ` (${entry.range.min}–${entry.range.max})` : '';
  return `${entry.flag} ${entry.value ?? ''} — ${copy.pasteBadValue}${range}`;
}

/**
 * Applying a llama-server command line to the controls.
 *
 * Model cards publish their configuration as a command, and copying twenty flags
 * into twenty controls by hand is where mistakes come from. Whatever cannot be
 * applied is listed rather than dropped: a paste that silently loses half its
 * flags leaves a model running on settings nobody chose.
 */
export default function SettingsPasteBox({ cfg, options, disabled, onChange }: {
  cfg: AppConfig; options: readonly ServerOption[]; disabled: boolean; onChange: DraftPatch;
}) {
  const { locale } = useI18n();
  const copy = modelSettingsCopy[locale];
  const [text, setText] = useState('');
  const [result, setResult] = useState<ReturnType<typeof parseSettingsText> | null>(null);

  const apply = () => {
    const parsed = parseSettingsText(text, options, cfg);
    setResult(parsed);
    if (Object.keys(parsed.patch).length > 0) onChange(parsed.patch);
  };

  return <div className="model-settings-paste">
    <label htmlFor="model-settings-paste">{copy.pasteLabel}</label>
    <p className="app-section-hint">{copy.pasteHint}</p>
    <textarea id="model-settings-paste" className="app-input font-mono" rows={5} spellCheck={false} disabled={disabled}
      value={text} onChange={event => { setText(event.target.value); setResult(null); }} placeholder={copy.pastePlaceholder} />
    <div className="model-settings-paste-actions">
      <button type="button" className="app-button app-button--secondary app-button--sm" disabled={disabled || !text.trim()} onClick={apply}>{copy.pasteApply}</button>
      {result && <span className="app-section-hint" role="status">{copy.pasteApplied.replace('{count}', String(result.applied.length))}</span>}
    </div>
    {result && result.rejected.length > 0 && <div className="model-settings-paste-rejected" role="alert">
      <strong>{copy.pasteRejected}</strong>
      <ul>{result.rejected.map(entry => <li key={`${entry.flag}:${entry.value ?? ''}`}>{rejectionText(entry, copy)}</li>)}</ul>
    </div>}
  </div>;
}
