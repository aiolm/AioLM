import { useEffect, useId, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import EngineSelect from '../../shared/ui/EngineSelect';

export function ProviderRuntimeControl({ cfg, disabled, onProvider, onChange, onReady, revision = 0, compact = false }: {
  cfg: api.AppConfig; disabled: boolean; onProvider: (provider: api.ProviderId) => void;
  onChange: (patch: Partial<api.AppConfig>) => void; onReady: (ready: boolean) => void; revision?: number;
  compact?: boolean;
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const provider = api.providerOf(cfg);
  const [descriptions, setDescriptions] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void Promise.all([api.providerCatalog(), api.providerRuntimes()]).then(([catalog, runtimes]) => {
      if (active) { setDescriptions(catalog); setRuntimes(runtimes); setError(''); }
    }).catch(cause => { if (active) setError(String(cause)); });
    return () => { active = false; };
  }, [revision]);
  const selected = provider === 'llama.cpp' ? cfg.active_build && cfg.active_backend ? `${cfg.active_build}-${cfg.active_backend}` : '' : cfg.active_runtime ?? '';
  const description = descriptions.find(item => item.id === provider);
  const entries = runtimes.filter(item => item.provider === provider);
  const ready = description?.availability.supported === true && entries.some(item => item.id === selected && item.available);
  useEffect(() => onReady(ready), [ready, onReady]);
  return <div className="model-settings-fields">
    <EngineSelect value={provider} disabled={disabled} onChange={onProvider} size={compact ? 'sm' : 'md'} />
    <label>{copy.runtime}<CustomSelect ariaLabel={copy.runtime} value={selected} disabled={disabled || description?.availability.supported === false} size={compact ? 'sm' : 'md'}
      options={[{ value: '', label: copy.choose }, ...entries.map(item => ({ value: item.id, label: api.runtimeLabel(item), disabled: !item.available })),
        ...(!entries.some(item => item.id === selected) && selected ? [{ value: selected, label: selected, disabled: true }] : [])]}
      onChange={value => { const item = entries.find(item => item.id === value); onChange(provider === 'llama.cpp'
        ? { active_backend: item?.backend ?? '', active_build: item?.build ?? '' } : { active_runtime: value }); }} /></label>
    {description?.availability.supported === false && <FeedbackBanner tone="warning">{copy.unsupported} {description.availability.detail}</FeedbackBanner>}
    {provider !== 'llama.cpp' && !description && <p role="status">{copy.loading}</p>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </div>;
}

export function ProviderOptions({ cfg, disabled, onChange, onInvalid, section }: {
  cfg: api.AppConfig; disabled: boolean; onChange: (patch: Partial<api.AppConfig>) => void; onInvalid: (key: string, invalid: boolean) => void;
  section?: string;
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const provider = api.providerOf(cfg);
  const [schema, setSchema] = useState<api.ProviderOption[]>([]);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [runtimeFlags, setRuntimeFlags] = useState<string[] | undefined>();
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const [validating, setValidating] = useState(true);
  const [error, setError] = useState(''); const [paste, setPaste] = useState(''); const [preview, setPreview] = useState('');
  const values = cfg.provider_options?.[provider] ?? {};
  useEffect(() => {
    let active = true; setValidating(true); setError('');
    const timer = setTimeout(() => {
      void api.providerOptionIssues(cfg).then(result => { if (active) { setIssues(result); setValidating(false); } })
        .catch(cause => { if (active) { setError(String(cause)); setValidating(false); } });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [cfg]);
  useEffect(() => {
    let active = true; setSchema([]); setRuntimeFlags(undefined); setLoadingSchema(true);
    void Promise.all([api.providerCatalog(), api.providerRuntimes(), cfg.active_runtime ? api.providerRuntimeOptions(provider, cfg.active_runtime) : Promise.resolve(undefined)]).then(([catalog, runtimes, runtimeOptions]) => {
      if (active) {
        setSchema(runtimeOptions ?? catalog.find(item => item.id === provider)?.options ?? []);
        setRuntimeFlags(runtimes.find(item => item.provider === provider && item.id === cfg.active_runtime)?.server_flags);
        setLoadingSchema(false);
      }
    }).catch(cause => { if (active) { setError(String(cause)); setLoadingSchema(false); } });
    return () => { active = false; };
  }, [provider, cfg.active_runtime]);
  const unknown = Object.keys(values).filter(key => !schema.some(option => option.key === key) && !['extra_args', 'lora_adapters', 'request_lora', 'draft_model'].includes(key)
    && !(key === 'trust_remote_code' && values[key] === false));
  const supports = (...flags: string[]) => !runtimeFlags || flags.every(flag => runtimeFlags.includes(flag));
  const showLora = supports(...(provider === 'vllm' ? ['--enable-lora', '--lora-modules'] : ['--adapter-path'])) || values.lora_adapters !== undefined;
  const bindingKey = provider === 'vllm' ? 'request_lora' : 'draft_model';
  const showBinding = (provider === 'vllm' ? supports('--enable-lora', '--lora-modules') : supports('--draft-model')) || values[bindingKey] !== undefined;
  const unknownCount = unknown.length;
  useEffect(() => { onInvalid('provider-options', validating || loadingSchema || issues.length > 0 || unknownCount > 0 || !!error); return () => onInvalid('provider-options', false); }, [unknownCount, issues, validating, loadingSchema, error, onInvalid]);
  const update = (key: string, value: unknown) => {
    const next = { ...values }; if (value === undefined) delete next[key]; else next[key] = value;
    onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
  };
  const groups: Record<string, readonly string[]> = { runtime: ['parallel', 'multimodal'], tuning: ['model', 'context', 'memory'], sampling: ['sampling'], reasoning: ['reasoning'], adapters: ['lora', 'speculative', 'adapters'] };
  const inSection = (option: api.ProviderOption) => !section || (section === 'advanced'
    ? !Object.values(groups).flat().includes(option.group) : groups[section]?.includes(option.group));
  const visible = schema.filter(option => inSection(option) && (option.target === 'request' || !option.flag || !runtimeFlags || runtimeFlags.includes(option.flag) || values[option.key] !== undefined));
  const adapters = !section || section === 'adapters';
  const advanced = !section || section === 'advanced';
  return <div className="model-settings-fields">
    <h3>{copy.options}</h3>
    {loadingSchema && <p role="status">{copy.loading}</p>}
    {issues.map((issue, index) => <FeedbackBanner key={`${issue.key}:${index}`} tone="error">{issue.message}</FeedbackBanner>)}
    {unknown.map(key => <FeedbackBanner key={key} tone="error">{key} <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.reset}</button></FeedbackBanner>)}
    {visible.map(option => <OptionField key={`${provider}:${option.key}`} option={option} value={values[option.key]} disabled={disabled} onChange={value => update(option.key, value)} onInvalid={onInvalid} />)}
    {adapters && (showLora || showBinding) && <h3>{copy.adapters}</h3>}
    {adapters && showLora && <OptionField option={{ key: 'lora_adapters', target: 'launch', group: 'adapters', kind: { type: 'json' } }} value={values.lora_adapters} disabled={disabled} onChange={value => update('lora_adapters', value)} onInvalid={onInvalid} />}
    {adapters && showBinding && <OptionField option={{ key: bindingKey, target: provider === 'vllm' ? 'request' : 'launch', group: 'adapters', kind: { type: 'text' } }} value={values[bindingKey]} disabled={disabled} onChange={value => update(bindingKey, value)} onInvalid={onInvalid} />}
    {advanced && <>
    <OptionField option={{ key: 'extra_args', target: 'launch', group: 'advanced', kind: { type: 'json' } }} value={values.extra_args} disabled={disabled} onChange={value => update('extra_args', value)} onInvalid={onInvalid} />
    <label>{copy.import}<textarea className="app-textarea" disabled={disabled} value={paste} onChange={event => setPaste(event.target.value)} /></label>
    <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim()} onClick={() => void api.providerImportCommand(provider, paste).then(result => {
      if (result.issues.length) { setError(result.issues.map(issue => issue.message).join('\n')); return; }
      setError(''); onChange({ ...(result.model ? { active_model: result.model } : {}), provider_options: { ...cfg.provider_options, [provider]: result.options } });
    }).catch(cause => setError(String(cause)))}>{copy.import}</button>
    <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => void api.providerCommandPreview(cfg).then(args => { setError(''); setPreview(args.map(arg => JSON.stringify(arg)).join(' ')); }).catch(cause => setError(String(cause)))}>{copy.preview}</button>
    {preview && <pre className="overflow-auto whitespace-pre-wrap">{preview}</pre>}
    </>}
    {!validating && !loadingSchema && !error && !advanced && !visible.length && !(adapters && (showLora || showBinding)) && <p className="app-section-hint">{copy.noOptions}</p>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </div>;
}

function OptionField({ option, value, disabled, onChange, onInvalid }: { option: api.ProviderOption; value: unknown; disabled: boolean; onChange: (value: unknown) => void; onInvalid: (key: string, invalid: boolean) => void }) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const text = value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  const errorId = useId();
  useEffect(() => { setDraft(text); setInvalid(false); onInvalid(`provider:${option.key}`, false);
    return () => onInvalid(`provider:${option.key}`, false);
  }, [text, option.key, onInvalid]);
  const edit = (text: string) => {
    setDraft(text);
    if (!text.trim()) { setInvalid(false); onInvalid(`provider:${option.key}`, false); onChange(undefined); return; }
    try {
      let parsed: unknown = text;
      if (option.kind.type === 'json') parsed = JSON.parse(text);
      if (['integer', 'number'].includes(option.kind.type)) {
        parsed = Number(text);
        if (!Number.isFinite(parsed) || option.kind.type === 'integer' && !Number.isSafeInteger(parsed) || option.kind.min !== undefined && Number(parsed) < option.kind.min || option.kind.max !== undefined && Number(parsed) > option.kind.max) throw new Error('range');
      }
      setInvalid(false); onInvalid(`provider:${option.key}`, false); onChange(parsed);
    } catch { setInvalid(true); onInvalid(`provider:${option.key}`, true); }
  };
  return <label>{option.flag ?? option.key} <small>{option.target === 'launch' ? copy.launch : copy.request} · {copy.inherit}: {option.runtime_default ?? copy.modelDefault}</small>
    {['flag', 'toggle', 'choice'].includes(option.kind.type) ? <CustomSelect ariaLabel={option.flag ?? option.key} disabled={disabled} value={text} onChange={value => onChange(value === '' ? undefined : ['flag', 'toggle'].includes(option.kind.type) ? value === 'true' : value)}
      options={[{ value: '', label: copy.inherit }, ...(option.kind.choices ?? ['true', 'false']).map(value => ({ value, label: value }))]} /> : option.kind.type === 'json' ? <textarea className="app-textarea" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} onChange={event => edit(event.target.value)} />
      : <input className="app-input" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} inputMode={['integer', 'number'].includes(option.kind.type) ? 'decimal' : 'text'} onChange={event => edit(event.target.value)} />}
    {invalid && <span id={errorId} role="alert">{copy.invalid}</span>}
  </label>;
}
