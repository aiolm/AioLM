import { useEffect, useId, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { commandImportCopy } from '../../shared/i18n/commandImportCopy';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import EngineSelect from '../../shared/ui/EngineSelect';
import { automaticProviderTelemetry, providerTelemetryCopy } from './providerTelemetry';
import type { ConfirmedSyntax, EffectiveSchema } from '../../shared/api/runtimeHelp';
import RuntimeOptionSchemaForm, { applyPlan, maskPreview, maskImportReview, OccurrenceOrder } from '../runtimes/RuntimeOptionSchemaForm';
import RuntimeHelpReview from '../runtimes/RuntimeHelpReview';
import RuntimeFactDifferences from '../runtimes/RuntimeFactDifferences';
import ConfirmedSyntaxReview from '../runtimes/ConfirmedSyntaxReview';
import PositionalLayout from '../runtimes/PositionalLayout';
import { ORDER_KEY } from '../runtimes/optionOrder';

export function ProviderRuntimeControl({ cfg, disabled, onProvider, onChange, onReady, revision = 0, compact = false }: {
  cfg: api.AppConfig; disabled: boolean; onProvider: (provider: api.ProviderId) => void;
  onChange: (patch: Partial<api.AppConfig>) => void; onReady: (ready: boolean | null) => void; revision?: number;
  compact?: boolean;
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const provider = api.providerOf(cfg);
  const [descriptions, setDescriptions] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [error, setError] = useState('');
  const [inventoryState, setInventoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    setInventoryState('loading'); setError('');
    void Promise.all([api.providerCatalog(), api.providerRuntimes()]).then(([catalog, runtimes]) => {
      if (active) { setDescriptions(catalog); setRuntimes(runtimes); setInventoryState('ready'); }
    }).catch(cause => { if (active) { setError(String(cause)); setInventoryState('error'); } });
    return () => { active = false; };
  }, [revision]);
  const selected = provider === 'llama.cpp' ? cfg.active_build && cfg.active_backend ? `${cfg.active_build}-${cfg.active_backend}` : '' : cfg.active_runtime ?? '';
  const description = descriptions.find(item => item.id === provider);
  const entries = runtimes.filter(item => item.provider === provider);
  // A pending or failed inventory cannot establish that the selected runtime is absent.
  const ready = inventoryState === 'ready' ? description?.availability.supported === true && entries.some(item => item.id === selected && item.available) : null;
  useEffect(() => onReady(ready), [ready, onReady]);
  return <div className="model-settings-fields">
    <EngineSelect value={provider} disabled={disabled} onChange={onProvider} size={compact ? 'sm' : 'md'} />
    <label>{copy.runtime}<CustomSelect ariaLabel={copy.runtime} value={selected} disabled={disabled || description?.availability.supported === false} size={compact ? 'sm' : 'md'}
      options={[{ value: '', label: copy.choose }, ...entries.map(item => ({ value: item.id, label: api.runtimeLabel(item), disabled: !item.available })),
        ...(!entries.some(item => item.id === selected) && selected ? [{ value: selected, label: selected, disabled: true }] : [])]}
      onChange={value => { const item = entries.find(item => item.id === value); onChange(provider === 'llama.cpp'
        ? { active_backend: item?.backend ?? '', active_build: item?.build ?? '' } : { active_runtime: value }); }} /></label>
    {description?.availability.supported === false && <FeedbackBanner tone="warning">{copy.unsupported} {description.availability.detail}</FeedbackBanner>}
    {inventoryState === 'loading' && <p role="status">{copy.loading}</p>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </div>;
}

export function ProviderOptions({ cfg, disabled, onChange, onInvalid, onChecking, section }: {
  cfg: api.AppConfig; disabled: boolean; onChange: (patch: Partial<api.AppConfig>) => void; onInvalid: (key: string, invalid: boolean) => void;
  onChecking?: (checking: boolean) => void;
  section?: string;
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const provider = api.providerOf(cfg);
  // The selected runtime's effective schema (catalog/manifest + accepted
  // help) drives the common renderer; the catalog list is only the preview
  // before a runtime exists. Typed settings keep their dedicated controls;
  // help adds options the installed build supplies without an app release.
  const [effective, setEffective] = useState<EffectiveSchema | null>(null);
  const [effectiveRevision, setEffectiveRevision] = useState(0);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const importRequest = useRef(0);
  const previewRequest = useRef(0);
  const syntaxRequest = useRef(0);
  const [syntaxBusy, setSyntaxBusy] = useState(false);
  useEffect(() => () => { importRequest.current += 1; previewRequest.current += 1; syntaxRequest.current += 1; }, []);
  const [schema, setSchema] = useState<api.ProviderOption[]>([]);
  const [loadingSchema, setLoadingSchema] = useState(true);
  const [schemaKnown, setSchemaKnown] = useState(false);
  const [schemaError, setSchemaError] = useState('');
  const [runtimeFlags, setRuntimeFlags] = useState<string[] | undefined>();
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const [validating, setValidating] = useState(true);
  const [error, setError] = useState(''); const [paste, setPaste] = useState(''); const [preview, setPreview] = useState('');
  // Words a registered import ignored. Kept apart from `error`: revalidating
  // the applied configuration must not erase why they were not applied.
  const [importReview, setImportReview] = useState('');
  const [importSyntax, setImportSyntax] = useState<api.CommandSyntax | ''>('');
  // A preview can fail for launch-time reasons (a model awaiting its fresh
  // probe) while the options are valid; it informs but does not gate saving.
  const [previewError, setPreviewError] = useState('');
  useEffect(() => { setPreview(''); setPreviewError(''); }, [cfg]);
  const values = cfg.provider_options?.[provider] ?? {};
  // An external engine's options come from the runtime's manifest, so there is
  // nothing to validate (or preview) until a runtime is chosen above.
  const selectedRuntime = provider === 'llama.cpp'
    ? (cfg.active_backend && cfg.active_build ? `${cfg.active_build}-${cfg.active_backend}` : '') : cfg.active_runtime;
  const runtimeNeeded = (api.isExternalProvider(provider) || provider === 'llama.cpp') && !selectedRuntime;
  useEffect(() => {
    let active = true; setValidating(true); setError('');
    if (runtimeNeeded) { setIssues([]); setValidating(false); return; }
    const timer = setTimeout(() => {
      void api.providerOptionIssues(cfg).then(result => { if (active) { setIssues(result); setValidating(false); } })
        .catch(cause => { if (active) { setError(String(cause)); setValidating(false); } });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
    // Saved confirmations change what the same values mean; revalidate.
  }, [cfg, runtimeNeeded, effectiveRevision]);
  const usesEffective = !!selectedRuntime;
  useEffect(() => {
    let active = true; setSchema([]); setEffective(null); setRuntimeFlags(undefined); setLoadingSchema(true); setSchemaKnown(false); setSchemaError(''); setImportReview('');
    importRequest.current += 1; previewRequest.current += 1; syntaxRequest.current += 1; setSyntaxBusy(false);
    void Promise.all([
      api.providerCatalog(), api.providerRuntimes(),
      provider !== 'llama.cpp' && cfgRef.current.active_runtime ? api.providerRuntimeOptions(provider, cfgRef.current.active_runtime) : Promise.resolve(undefined),
      usesEffective ? api.providerOptionSchema(cfgRef.current) : Promise.resolve(null),
    ]).then(([catalog, runtimes, runtimeOptions, schemaView]) => {
      if (active) {
        setSchema(runtimeOptions ?? catalog.find(item => item.id === provider)?.options ?? []);
        setEffective(schemaView);
        setRuntimeFlags(runtimes.find(item => item.provider === provider && item.id === selectedRuntime)?.server_flags);
        setSchemaKnown(true);
        setLoadingSchema(false);
      }
    }).catch(cause => { if (active) { setSchemaError(String(cause)); setLoadingSchema(false); } });
    return () => { active = false; };
  }, [provider, cfg.active_runtime, cfg.active_backend, cfg.active_build, selectedRuntime, usesEffective, effectiveRevision]);
  // Until the schema answers, absence from this list is not evidence that a
  // saved option is unsupported. Do not offer destructive resets while probing.
  const known = (key: string) => effective ? effective.schema.options.some(option => option.key === key) : schema.some(option => option.key === key);
  const unknown = schemaKnown ? Object.keys(values).filter(key => !known(key) && !['extra_args', 'lora_adapters', 'request_lora', 'draft_model', ORDER_KEY].includes(key)
    && !(key === 'trust_remote_code' && values[key] === false)) : [];
  const supports = (...flags: string[]) => !runtimeFlags || flags.every(flag => runtimeFlags.includes(flag));
  const showLora = provider !== 'llama.cpp' && !api.isExternalProvider(provider) && (supports(...(provider === 'vllm' ? ['--enable-lora', '--lora-modules'] : ['--adapter-path'])) || values.lora_adapters !== undefined);
  const bindingKey = provider === 'vllm' ? 'request_lora' : 'draft_model';
  const showBinding = provider !== 'llama.cpp' && !api.isExternalProvider(provider) && ((provider === 'vllm' ? supports('--enable-lora', '--lora-modules') : supports('--draft-model')) || values[bindingKey] !== undefined);
  const unknownCount = unknown.length;
  const checking = validating || loadingSchema;
  useEffect(() => {
    onChecking?.(checking);
    // Callers without a separate pending state retain their existing save gate.
    onInvalid('provider-options', (!onChecking && checking) || issues.length > 0 || unknownCount > 0 || !!error || !!schemaError);
    return () => { onChecking?.(false); onInvalid('provider-options', false); };
  }, [unknownCount, issues, checking, error, schemaError, onInvalid, onChecking]);
  const update = (key: string, value: unknown) => {
    const next = { ...values }; if (value === undefined) delete next[key]; else next[key] = value;
    onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
  };
  const groups: Record<string, readonly string[]> = { runtime: ['parallel', 'multimodal'], tuning: ['model', 'context', 'memory'], sampling: ['sampling'], reasoning: ['reasoning'], adapters: ['lora', 'speculative', 'adapters'] };
  const inGroupSection = (group: string) => !section || (section === 'advanced'
    ? !Object.values(groups).flat().includes(group) : groups[section]?.includes(group));
  const inSection = (option: api.ProviderOption) => inGroupSection(option.group);
  const visible = effective ? [] : schema.filter(option => inSection(option) && (option.target === 'request' || !option.flag || !runtimeFlags || runtimeFlags.includes(option.flag) || values[option.key] !== undefined));
  const schemaVisible = effective ? effective.schema.options.filter(option => inGroupSection(option.group)).length : visible.length;
  const importCommand = () => {
    if (!importSyntax) return;
    const source = cfg;
    const request = ++importRequest.current;
    const current = () => cfgRef.current === source && importRequest.current === request;
    setImportReview('');
    if (effective) {
      // Registered engines import through their effective schema; managed and
      // unrecognized words are reported, never applied.
      void api.runtimeHelpImport(effective.schema, effective.scope, paste, importSyntax, effective.entry).then(result => {
        if (!current()) return;
        let next: Record<string, unknown>;
        try { next = applyPlan(effective.schema, values, result); } catch (cause) { setError(String(cause)); return; }
        const review = maskImportReview(result, effective.schema, values);
        setError(''); setImportReview([...review.managed, ...review.unrecognized].join(' '));
        onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
      }).catch(cause => { if (current()) setError(String(cause)); });
      return;
    }
    void api.providerImportCommand(provider, paste, importSyntax).then(result => {
      if (!current()) return;
      if (result.issues.length) { setError(result.issues.map(issue => issue.message).join('\n')); return; }
      setError(''); onChange({ ...(result.model ? { active_model: result.model } : {}), provider_options: { ...cfg.provider_options, [provider]: result.options } });
    }).catch(cause => { if (current()) setError(String(cause)); });
  };
  // Confirmations are runtime metadata pinned to the accepted help, saved
  // immediately and apart from the profile's values.
  const saveSyntax = (save: () => Promise<EffectiveSchema>) => {
    const request = ++syntaxRequest.current;
    setSyntaxBusy(true);
    void save().then(() => {
      if (syntaxRequest.current !== request) return;
      setError(''); setEffectiveRevision(current => current + 1);
    }).catch(cause => { if (syntaxRequest.current === request) setError(String(cause)); })
      .finally(() => { if (syntaxRequest.current === request) setSyntaxBusy(false); });
  };
  const confirmable = effective?.help_state === 'current' && !!effective.accepted_fingerprint;
  const confirmSyntax = (key: string, syntax: ConfirmedSyntax) => {
    if (!effective?.accepted_fingerprint) return;
    const fingerprint = effective.accepted_fingerprint;
    const existing = effective.supplement?.current ? effective.supplement.options : {};
    saveSyntax(() => api.runtimeHelpConfirmSyntax(cfg, fingerprint, { ...existing, [key]: { ...existing[key], ...syntax } }));
  };
  const adapters = !section || section === 'adapters';
  const advanced = !section || section === 'advanced';
  return <div className="model-settings-fields">
    <h3>{copy.options}</h3>
    {loadingSchema && <p role="status">{copy.loading}</p>}
    {runtimeNeeded && <p className="app-section-hint">{copy.choose}</p>}
    {issues.map((issue, index) => <FeedbackBanner key={`${issue.key}:${index}`} tone="error">{issue.message}</FeedbackBanner>)}
    {unknown.map(key => <FeedbackBanner key={key} tone="error">{key} <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.reset}</button></FeedbackBanner>)}
    {effective && <RuntimeOptionSchemaForm compact schema={effective.schema} values={values} scope={effective.scope} disabled={disabled}
      onChange={next => onChange({ provider_options: { ...cfg.provider_options, [provider]: next } })}
      filter={option => inGroupSection(option.group) && (option.target === 'request' || !runtimeFlags || !effective.compat_keys.includes(option.key)
        || option.spellings.some(spelling => runtimeFlags.includes(spelling.flag)) || values[option.key] !== undefined)}
      inheritLabel={option => automaticProviderTelemetry(provider, option.key, runtimeFlags, values) ? providerTelemetryCopy[locale].automatic : undefined}
      hint={option => automaticProviderTelemetry(provider, option.key, runtimeFlags, values) ? providerTelemetryCopy[locale].hint : undefined}
      onInvalid={onInvalid}
      confirmSyntaxFor={option => effective.help_keys.includes(option.key)}
      onConfirmSyntax={confirmable ? (option, syntax) => confirmSyntax(option.key, syntax) : undefined} />}
    {visible.map(option => <OptionField key={`${provider}:${option.key}`} option={option} value={values[option.key]} disabled={disabled} automaticTelemetry={automaticProviderTelemetry(provider, option.key, runtimeFlags, values)} onChange={value => update(option.key, value)} onInvalid={onInvalid} />)}
    {adapters && (showLora || showBinding) && <h3>{copy.adapters}</h3>}
    {adapters && showLora && <OptionField option={{ key: 'lora_adapters', target: 'launch', group: 'adapters', kind: { type: 'json' } }} value={values.lora_adapters} disabled={disabled} onChange={value => update('lora_adapters', value)} onInvalid={onInvalid} />}
    {adapters && showBinding && <OptionField option={{ key: bindingKey, target: provider === 'vllm' ? 'request' : 'launch', group: 'adapters', kind: { type: 'text' } }} value={values[bindingKey]} disabled={disabled} onChange={value => update(bindingKey, value)} onInvalid={onInvalid} />}
    {advanced && <>
    {provider !== 'llama.cpp' && !api.isExternalProvider(provider) && <OptionField option={{ key: 'extra_args', target: 'launch', group: 'advanced', kind: { type: 'json' } }} value={values.extra_args} disabled={disabled} onChange={value => update('extra_args', value)} onInvalid={onInvalid} />}
    <label>{copy.import}<textarea className="app-textarea" disabled={disabled} value={paste} onChange={event => { importRequest.current += 1; setPaste(event.target.value); }} /></label>
    <label>{commandImportCopy[locale].syntax}<CustomSelect<api.CommandSyntax | ''> ariaLabel={commandImportCopy[locale].syntax}
      value={importSyntax} disabled={disabled}
      options={[{ value: '', label: commandImportCopy[locale].choose }, { value: 'windows', label: commandImportCopy[locale].windows }, { value: 'posix', label: commandImportCopy[locale].posix }]}
      onChange={value => { importRequest.current += 1; setImportSyntax(value); }} /></label>
    <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim() || !importSyntax} onClick={importCommand}>{copy.import}</button>
    <button type="button" className="app-button app-button--secondary" disabled={disabled || runtimeNeeded} onClick={() => {
      const source = cfg;
      const request = ++previewRequest.current;
      const current = () => cfgRef.current === source && previewRequest.current === request;
      void api.providerCommandPreview(source).then(args => {
        if (!current()) return;
        setPreviewError('');
        setPreview((effective ? maskPreview(args, effective.schema, values) : args).map(arg => JSON.stringify(arg)).join(' '));
      }).catch(cause => { if (current()) { setPreview(''); setPreviewError(String(cause)); } });
    }}>{copy.preview}</button>
    {preview && <pre className="overflow-auto whitespace-pre-wrap">{preview}</pre>}
    {previewError && <FeedbackBanner tone="error">{previewError}</FeedbackBanner>}
    {effective && <OccurrenceOrder schema={effective.schema} values={values} disabled={disabled}
      onChange={next => onChange({ provider_options: { ...cfg.provider_options, [provider]: next } })} />}
    {effective && <ConfirmedSyntaxReview effective={effective} disabled={disabled || syntaxBusy}
      onSave={options => { const fingerprint = effective.accepted_fingerprint; if (fingerprint) saveSyntax(() => api.runtimeHelpConfirmSyntax(cfg, fingerprint, options)); }}
      onDiscard={() => saveSyntax(() => api.runtimeHelpClearConfirmedSyntax(cfg))} />}
    {effective && <PositionalLayout effective={effective} disabled={disabled || syntaxBusy}
      onSave={options => { const fingerprint = effective.accepted_fingerprint; if (fingerprint) saveSyntax(() => api.runtimeHelpConfirmSyntax(cfg, fingerprint, options)); }} />}
    {effective && <RuntimeFactDifferences conflicts={effective.conflicts} metadata={effective.metadata} schema={effective.schema} />}
    {effective && <RuntimeHelpReview key={`${provider}:${selectedRuntime}`} cfg={cfg} effective={effective} disabled={disabled} onAccepted={() => setEffectiveRevision(current => current + 1)} />}
    </>}
    {!validating && !loadingSchema && !error && !schemaError && !runtimeNeeded && !advanced && !schemaVisible && !(adapters && (showLora || showBinding)) && <p className="app-section-hint">{copy.noOptions}</p>}
    {schemaError && <FeedbackBanner tone="error">{schemaError}</FeedbackBanner>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    {importReview && <FeedbackBanner tone="warning">{importReview}</FeedbackBanner>}
  </div>;
}

function OptionField({ option, value, disabled, automaticTelemetry = false, onChange, onInvalid }: { option: api.ProviderOption; value: unknown; disabled: boolean; automaticTelemetry?: boolean; onChange: (value: unknown) => void; onInvalid: (key: string, invalid: boolean) => void }) {
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
    {automaticTelemetry && <small>{providerTelemetryCopy[locale].hint}</small>}
    {['flag', 'toggle', 'choice'].includes(option.kind.type) ? <CustomSelect ariaLabel={option.flag ?? option.key} disabled={disabled} value={text} onChange={value => onChange(value === '' ? undefined : ['flag', 'toggle'].includes(option.kind.type) ? value === 'true' : value)}
      options={[{ value: '', label: automaticTelemetry ? providerTelemetryCopy[locale].automatic : copy.inherit }, ...(option.kind.choices ?? ['true', 'false']).map(value => ({ value, label: value }))]} /> : option.kind.type === 'json' ? <textarea className="app-textarea" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} onChange={event => edit(event.target.value)} />
      : <input className="app-input" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} inputMode={['integer', 'number'].includes(option.kind.type) ? 'decimal' : 'text'} onChange={event => edit(event.target.value)} />}
    {invalid && <span id={errorId} role="alert">{copy.invalid}</span>}
  </label>;
}
