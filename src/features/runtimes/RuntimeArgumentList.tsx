import { useEffect, useId, useRef } from 'react';
import { errorMessage } from '../../shared/api/errors';
import { pickRuntimePath } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { entrypointCopy } from '../../shared/i18n/entrypointCopy';

/** Explicit argv tokens keep paths with spaces and Unicode in one argument. */
export default function RuntimeArgumentList({ label, tokens, disabled, onChange, onFile, onError, descriptionId }: {
  label: string; tokens: string[]; disabled: boolean; onChange: (next: string[]) => void;
  onFile?: (path: string) => void; onError?: (message: string) => void; descriptionId?: string;
}) {
  const id = useId();
  const { locale } = useI18n();
  const copy = entrypointCopy[locale];
  const mountedRef = useRef(true);
  const pickerGeneration = useRef(0);
  const tokensRef = useRef(tokens); tokensRef.current = tokens;
  const disabledRef = useRef(disabled); disabledRef.current = disabled;
  const onChangeRef = useRef(onChange); onChangeRef.current = onChange;
  const onFileRef = useRef(onFile); onFileRef.current = onFile;
  const onErrorRef = useRef(onError); onErrorRef.current = onError;
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; pickerGeneration.current += 1; };
  }, []);
  return <fieldset aria-describedby={descriptionId}>
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
        const generation = ++pickerGeneration.current;
        void pickRuntimePath('file').then(path => {
          if (!mountedRef.current || disabledRef.current || pickerGeneration.current !== generation || !path) return;
          onChangeRef.current([...tokensRef.current, path]);
          onFileRef.current?.(path);
        }).catch(cause => {
          if (mountedRef.current && pickerGeneration.current === generation) onErrorRef.current?.(errorMessage(cause));
        });
      }}>{copy.addFileToken}</button>}
    </span>
  </fieldset>;
}
