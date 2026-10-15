import { useId } from 'react';
import { pickRuntimePath } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { entrypointCopy } from '../../shared/i18n/entrypointCopy';

/** Explicit argv tokens keep paths with spaces and Unicode in one argument. */
export default function RuntimeArgumentList({ label, tokens, disabled, onChange, onFile, onError }: {
  label: string; tokens: string[]; disabled: boolean; onChange: (next: string[]) => void;
  onFile?: (path: string) => void; onError?: (message: string) => void;
}) {
  const id = useId();
  const { locale } = useI18n();
  const copy = entrypointCopy[locale];
  return <fieldset>
    <legend>{label}</legend>
    {tokens.map((token, index) => <span key={index} className="entrypoint-token">
      <input id={`${id}-${index}`} name={`${label}-${index}`} className="app-input" value={token} disabled={disabled}
        aria-label={`${label} ${copy.token} ${index + 1}`} autoCorrect="off" autoCapitalize="off" spellCheck={false}
        onChange={event => onChange(tokens.map((current, i) => i === index ? event.target.value : current))} />
      <button type="button" className="app-button app-button--secondary" disabled={disabled}
        onClick={() => onChange(tokens.filter((_, i) => i !== index))}>{copy.removeToken}</button>
    </span>)}
    <span className="app-page-actions">
      <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => onChange([...tokens, ''])}>{copy.addToken}</button>
      {onFile && <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => {
        void pickRuntimePath('file').then(path => { if (path) { onChange([...tokens, path]); onFile(path); } })
          .catch(cause => onError?.(cause instanceof Error ? cause.message : String(cause)));
      }}>{copy.addFileToken}</button>}
    </span>
  </fieldset>;
}
