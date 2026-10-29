import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import { commandImportCopy } from '../../shared/i18n/commandImportCopy';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { assertJsonOptionNumbers, JsonOptionNumberError, parseJsonOption } from '../../shared/runtime/jsonOptionNumbers';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { useRuntimeInventoryRevision } from '../../shared/runtime/runtimeInventoryEvents';
import { automaticProviderTelemetry, providerTelemetryCopy } from './providerTelemetry';
import type { ConfirmedSyntax, EffectiveSchema, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import RuntimeOptionSchemaForm, { applyPlan, maskPreview, maskImportReview, OccurrenceOrder, SchemaOptionField } from '../runtimes/RuntimeOptionSchemaForm';
import { sensitiveEntryTokenStrings } from '../runtimes/sensitiveEntryTokens';
import RuntimeHelpReview from '../runtimes/RuntimeHelpReview';
import RuntimeFactDifferences from '../runtimes/RuntimeFactDifferences';
import ConfirmedSyntaxReview from '../runtimes/ConfirmedSyntaxReview';
import PositionalLayout from '../runtimes/PositionalLayout';
import { ImportedIntegerPrecisionError, ORDER_KEY } from '../runtimes/optionOrder';
import { modelSettingsCopy } from './modelSettingsCopy';
import { settingsFlowCopy } from './settingsFlowCopy';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { clearRuntimeOptionOverrides } from '../runtimes/runtimeOptionDefaults';
import { runtimeDefaultsCopy } from './runtimeDefaultsCopy';
import { useProfileRuntimeSchema } from './useProfileRuntimeSchema';
import { profileSchemaCopy } from './profileSchemaCopy';
import { runtimeInstanceLabel } from '../../shared/i18n/runtimeInstanceText';

export function ProviderRuntimeControl({ cfg, disabled, onProvider, onChange, onReady, revision = 0 }: {
  cfg: api.AppConfig; disabled: boolean; onProvider: (provider: api.ProviderId) => void;
  onChange: (patch: Partial<api.AppConfig>) => void; onReady: (ready: boolean | null) => void; revision?: number;
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const flowCopy = settingsFlowCopy[locale];
  const groupId = useId();
  const inventoryRevision = useRuntimeInventoryRevision();
  const [retryRevision, setRetryRevision] = useState(0);
  const provider = api.providerOf(cfg);
  const [descriptions, setDescriptions] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [error, setError] = useState('');
  const [inventoryState, setInventoryState] = useState<'loading' | 'ready' | 'error'>('loading');
  useEffect(() => {
    let active = true;
    setInventoryState('loading'); setError('');
    void Promise.all([api.providerCatalog(inventoryRevision > 0 || retryRevision > 0), api.providerRuntimes()]).then(([catalog, runtimes]) => {
      if (active) { setDescriptions(catalog); setRuntimes(runtimes); setInventoryState('ready'); }
    }).catch(cause => { if (active) { setError(String(cause)); setInventoryState('error'); } });
    return () => { active = false; };
  }, [revision, inventoryRevision, retryRevision]);
  const selected = provider === 'llama.cpp' ? cfg.active_build && cfg.active_backend ? `${cfg.active_build}-${cfg.active_backend}` : '' : cfg.active_runtime ?? '';
  const description = descriptions.find(item => item.id === provider);
  const entries = runtimes.filter(item => item.provider === provider);
  const engines = [...new Set([...api.PROVIDERS, ...descriptions.map(item => item.id), provider])];
  const selectRuntime = (item?: api.RuntimeInstance) => onChange(provider === 'llama.cpp'
    ? { active_backend: item?.backend ?? '', active_build: item?.build ?? '' } : { active_runtime: item?.id ?? '' });
  // A pending or failed inventory cannot establish that the selected runtime is absent.
  const ready = inventoryState === 'ready' ? description?.availability.supported === true && entries.some(item => item.id === selected && item.available) : null;
  useEffect(() => onReady(ready), [ready, onReady]);
  return <div className="model-settings-fields runtime-selection-cards">
    <fieldset disabled={disabled} className="runtime-choice-group"><legend>{copy.engine}</legend>
      {engines.map(engine => {
        const metadata = descriptions.find(item => item.id === engine);
        const label = api.isExternalProvider(engine) ? metadata?.engine ?? api.providerDisplayName(engine) : api.providerDisplayName(engine);
        return <label key={engine} className={`runtime-choice${engine === provider ? ' is-selected' : ''}`}>
          <input type="radio" name={`${groupId}-engine`} checked={engine === provider} onChange={() => onProvider(engine)} />
          <span><strong>{label}</strong>{metadata?.availability.detail && <small>{normalizeDisplayText(metadata.availability.detail)}</small>}</span>
        </label>;
      })}
    </fieldset>
    <fieldset disabled={disabled || description?.availability.supported === false} className="runtime-choice-group"><legend>{copy.runtime}</legend>
      {entries.map(item => <label key={item.id} className={`runtime-choice${item.id === selected ? ' is-selected' : ''}`}>
        <input type="radio" name={`${groupId}-runtime`} checked={item.id === selected} disabled={!item.available} onChange={() => selectRuntime(item)} />
        <span><strong>{runtimeInstanceLabel(item, locale)}</strong><small>{item.server}</small>{item.problems.length > 0 && <small>{normalizeDisplayText(item.problems.join('; '))}</small>}</span>
      </label>)}
      {inventoryState === 'ready' && !entries.length && <p className="app-section-hint">{flowCopy.noRuntimes}</p>}
      {selected && !entries.some(item => item.id === selected) && <p className="app-section-hint">{selected}</p>}
      {selected && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => selectRuntime()}>{copy.reset}</button>}
    </fieldset>
    {description?.availability.supported === false && <FeedbackBanner tone="warning">{copy.unsupported} {description.availability.detail}</FeedbackBanner>}
    {inventoryState === 'loading' && <p role="status">{copy.loading}</p>}
    {error && <FeedbackBanner tone="error" action={{ label: modelSettingsCopy[locale].refresh, disabled: disabled || inventoryState === 'loading', onClick: () => {
      if (disabled || inventoryState === 'loading') return;
      setRetryRevision(value => value + 1);
    } }}>{error}</FeedbackBanner>}
  </div>;
}

export function ProviderOptions({ cfg, disabled, onChange, onInvalid, onChecking, section, collapseTools = false, hideDefaultsReset = false, editor = 'schema' }: {
  cfg: api.AppConfig; disabled: boolean; onChange: (patch: Partial<api.AppConfig>) => void; onInvalid: (key: string, invalid: boolean) => void;
  onChecking?: (checking: boolean) => void;
  section?: string;
  collapseTools?: boolean;
  hideDefaultsReset?: boolean;
  /** A custom host owns primary controls and command import; discovered options remain available. */
  editor?: 'schema' | 'custom';
}) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const provider = api.providerOf(cfg);
  const external = api.isExternalProvider(provider);
  const selectedRuntime = provider === 'llama.cpp'
    ? (cfg.active_backend && cfg.active_build ? `${cfg.active_build}-${cfg.active_backend}` : '') : cfg.active_runtime;
  const usesEffective = !!selectedRuntime;
  const checkedSchema = useProfileRuntimeSchema(cfg, usesEffective);
  const effective = checkedSchema.view ?? null;
  // Preserve local form drafts for this runtime without presenting old facts
  // while its checked schema is pending or unavailable.
  const retainedForm = useRef<{ provider: api.ProviderId; runtime: string; view: EffectiveSchema } | null>(null);
  if (retainedForm.current && (retainedForm.current.provider !== provider || retainedForm.current.runtime !== checkedSchema.runtime)) retainedForm.current = null;
  if (effective) retainedForm.current = { provider, runtime: checkedSchema.runtime, view: effective };
  const formEffective = effective ?? retainedForm.current?.view ?? null;
  const defaultsCopy = runtimeDefaultsCopy[locale];
  const [defaultsRevision, setDefaultsRevision] = useState(0);
  const [defaultsRestored, setDefaultsRestored] = useState(false);
  // The selected runtime's effective schema (catalog/manifest + accepted
  // help) drives the common renderer; the catalog list is only the preview
  // before a runtime exists. Typed settings keep their dedicated controls;
  // help adds options the installed build supplies without an app release.
  const [effectiveRevision, setEffectiveRevision] = useState(0);
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;
  const importRequest = useRef(0);
  const previewRequest = useRef(0);
  const syntaxRequest = useRef(0);
  const [syntaxBusy, setSyntaxBusy] = useState(false);
  useEffect(() => () => { importRequest.current += 1; previewRequest.current += 1; syntaxRequest.current += 1; }, []);
  const [schema, setSchema] = useState<api.ProviderOption[]>([]);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [schemaKnown, setSchemaKnown] = useState(false);
  const [catalogError, setCatalogError] = useState('');
  const [runtimeFlags, setRuntimeFlags] = useState<string[] | undefined>();
  const [issues, setIssues] = useState<Array<{ key: string; message: string }>>([]);
  const issueId = useId();
  const issueDescriptions = useMemo(() => {
    const descriptions = new Map<string, string>();
    issues.forEach((issue, index) => descriptions.set(issue.key, [descriptions.get(issue.key), `${issueId}-${index}`].filter(Boolean).join(' ')));
    return descriptions;
  }, [issues, issueId]);
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
  // Unsaved draft secret prefix indices reported by the positional layout
  // sibling (display-only, never persisted). Projections generated before the
  // linkage are cleared so no rendered copy keeps the raw secret.
  const [draftSecretIndices, setDraftSecretIndices] = useState<number[]>([]);
  const draftSecretsKey = JSON.stringify([...draftSecretIndices].sort((a, b) => a - b));
  useEffect(() => { setPreview(''); setPreviewError(''); setImportReview(''); }, [draftSecretsKey]);
  // Saved (current/stale supplement) plus unsaved draft entry secrets for
  // display projections only. Draft indices resolve against this effective's
  // own prefix; out-of-range indices contribute nothing.
  const entrySecretsFor = (view: EffectiveSchema, indices: number[]) => {
    const saved = sensitiveEntryTokenStrings(view);
    const prefix = view.entry?.prefix ?? [];
    const drafted = indices.map(index => prefix[index]).filter((token): token is string => !!token);
    return [...saved, ...drafted];
  };
  // Late display responses mask with the newest secrets, not the ones known
  // when the request started: a mapping made while the request was pending
  // must not leak through its resolution. Application still uses the
  // request-time snapshot; only the review projection refreshes.
  const effectiveRef = useRef<EffectiveSchema | null>(null);
  effectiveRef.current = effective;
  const draftSecretsRef = useRef<number[]>([]);
  draftSecretsRef.current = draftSecretIndices;
  const liveEntrySecrets = () => {
    const view = effectiveRef.current;
    return view ? entrySecretsFor(view, draftSecretsRef.current) : [];
  };
  // The layout reports draft indices from a passive effect; a display
  // response resolving between that commit and this parent's re-render must
  // already see them, so the ref updates synchronously here as well.
  // Stable across renders so the layout only reports changed drafts.
  const reportDraftSecrets = useCallback((indices: number[]) => {
    draftSecretsRef.current = indices;
    setDraftSecretIndices(indices);
  }, []);
  const values = cfg.provider_options?.[provider] ?? {};
  // An external engine's options come from the runtime's manifest, so there is
  // nothing to validate (or preview) until a runtime is chosen above.
  const runtimeNeeded = (api.isExternalProvider(provider) || provider === 'llama.cpp') && !selectedRuntime;
  const schemaError = catalogError || checkedSchema.error || '';
  const loadingSchema = loadingCatalog || checkedSchema.pending;
  useEffect(() => {
    let active = true; setValidating(true); setError('');
    if (runtimeNeeded) { setIssues([]); setValidating(false); return; }
    const timer = setTimeout(() => {
      void api.providerOptionIssues(cfg).then(result => { if (active) { setIssues(result); setValidating(false); } })
        .catch(cause => { if (active) { setError(String(cause)); setValidating(false); } });
    }, 150);
    return () => { active = false; clearTimeout(timer); };
    // Saved confirmations change what the same values mean; revalidate.
  }, [cfg, runtimeNeeded, effectiveRevision, effective]);
  useEffect(() => {
    let active = true; setSchema([]); setRuntimeFlags(undefined); setLoadingCatalog(true); setSchemaKnown(false); setCatalogError(''); setImportReview('');
    setDefaultsRestored(false);
    importRequest.current += 1; previewRequest.current += 1; syntaxRequest.current += 1; setSyntaxBusy(false);
    void Promise.all([
      api.providerCatalog(),
      // External schemas have their own verified runtime identity. Inventory
      // checks for unrelated installations must not delay these option fields.
      external ? Promise.resolve<api.RuntimeInstance[]>([]) : api.providerRuntimes(),
      provider !== 'llama.cpp' && cfgRef.current.active_runtime ? api.providerRuntimeOptions(provider, cfgRef.current.active_runtime) : Promise.resolve(undefined),
    ]).then(([catalog, runtimes, runtimeOptions]) => {
      if (active) {
        setSchema(runtimeOptions ?? catalog.find(item => item.id === provider)?.options ?? []);
        setRuntimeFlags(runtimes.find(item => item.provider === provider && item.id === selectedRuntime)?.server_flags);
        setSchemaKnown(true);
        setLoadingCatalog(false);
      }
    }).catch(cause => { if (active) { setCatalogError(String(cause)); setLoadingCatalog(false); } });
    return () => { active = false; };
  }, [provider, external, cfg.active_runtime, cfg.active_backend, cfg.active_build, selectedRuntime, usesEffective, effectiveRevision]);
  // Until the schema answers, absence from this list is not evidence that a
  // saved option is unsupported. Do not offer destructive resets while probing.
  const known = (key: string) => effective ? effective.schema.options.some(option => option.key === key) : schema.some(option => option.key === key);
  const unknown = schemaKnown && (!usesEffective || effective) ? Object.keys(values).filter(key => !known(key) && !['extra_args', 'lora_adapters', 'request_lora', 'draft_model', ORDER_KEY].includes(key)
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
    setDefaultsRestored(false);
    const next = { ...values }; if (value === undefined) delete next[key]; else next[key] = value;
    onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
  };
  const groups: Record<string, readonly string[]> = { runtime: ['parallel', 'multimodal'], tuning: ['model', 'context', 'memory'], sampling: ['sampling'], reasoning: ['reasoning'], adapters: ['lora', 'speculative', 'adapters'] };
  const inGroupSection = (group: string) => !section || (section === 'advanced'
    ? !Object.values(groups).flat().includes(group) : groups[section]?.includes(group));
  const inSection = (option: api.ProviderOption) => inGroupSection(option.group);
  const visible = usesEffective ? [] : schema.filter(option => inSection(option) && (option.target === 'request' || !option.flag || !runtimeFlags || runtimeFlags.includes(option.flag) || values[option.key] !== undefined));
  const schemaFilter = (option: OptionSchemaDefinition) => (!collapseTools || !option.managed || option.managed === 'discovery') && inGroupSection(option.group)
    && (option.target === 'request' || !runtimeFlags || !effective?.compat_keys.includes(option.key)
      || option.spellings.some(spelling => runtimeFlags.includes(spelling.flag)) || values[option.key] !== undefined);
  const hasSchemaOptions = effective ? effective.schema.options.some(schemaFilter) : visible.length > 0;
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
        try { next = applyPlan(effective.schema, values, result); } catch (cause) { setError(cause instanceof ImportedIntegerPrecisionError ? runtimeOptionsCopy[locale].importIntegerPrecision : cause instanceof JsonOptionNumberError ? runtimeOptionsCopy[locale].jsonNumberRange : String(cause)); return; }
        const review = maskImportReview(result, effective.schema, values, liveEntrySecrets(), effective.entry);
        setError(''); setImportReview([...review.managed, ...review.unrecognized].join(' '));
        onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
      }).catch(cause => { if (current()) setError(String(cause)); });
      return;
    }
    void api.providerImportCommand(provider, paste, importSyntax).then(result => {
      if (!current()) return;
      if (result.issues.length) { setError(result.issues.map(issue => issue.message).join('\n')); return; }
      for (const option of schema) {
        if (option.kind.type === 'json') assertJsonOptionNumbers(result.options[option.key]);
      }
      setError(''); onChange({ ...(result.model ? { active_model: result.model } : {}), provider_options: { ...cfg.provider_options, [provider]: result.options } });
    }).catch(cause => { if (current()) setError(cause instanceof JsonOptionNumberError ? runtimeOptionsCopy[locale].jsonNumberRange : String(cause)); });
  };
  // Confirmations are runtime metadata pinned to the accepted help, saved
  // immediately and apart from the profile's values.
  const saveSyntax = (save: () => Promise<EffectiveSchema>) => {
    const request = ++syntaxRequest.current;
    setSyntaxBusy(true);
    void save().then(() => {
      if (syntaxRequest.current !== request) return;
      setError(''); setEffectiveRevision(current => current + 1); checkedSchema.retry();
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
  const managedOptions = collapseTools ? effective?.schema.options.filter(option => option.managed && option.managed !== 'discovery') ?? [] : [];
  return <div className="model-settings-fields">
    {!collapseTools && editor === 'schema' && <h3>{copy.options}</h3>}
    {external && !hideDefaultsReset && <div>
      <button type="button" className="app-button app-button--secondary" disabled={disabled || checking || !effective || ['stale', 'unchecked'].includes(effective.help_state)} onClick={() => {
        if (!effective) return;
        try {
          const next = clearRuntimeOptionOverrides(effective.schema, values, effective.scope);
          onChange({ provider_options: { ...cfg.provider_options, [provider]: next } });
          setDefaultsRevision(value => value + 1); setDefaultsRestored(true); setError('');
        } catch { setError(defaultsCopy.order); }
      }}>{defaultsCopy.reset}</button>
      <p className="app-section-hint">{defaultsCopy.hint}</p>
      {defaultsRestored && <p role="status">{defaultsCopy.done}</p>}
    </div>}
    {loadingSchema && <p role="status">{copy.loading}</p>}
    {runtimeNeeded && <p className="app-section-hint">{copy.choose}</p>}
    {issues.map((issue, index) => <div key={`${issue.key}:${index}`} id={`${issueId}-${index}`}><FeedbackBanner tone="error">{issue.message}</FeedbackBanner></div>)}
    {unknown.map(key => <FeedbackBanner key={key} tone="error">{key} <button type="button" disabled={disabled} className="app-button app-button--secondary" onClick={() => update(key, undefined)}>{copy.reset}</button></FeedbackBanner>)}
    {formEffective && (editor === 'schema' || formEffective.schema.options.length > 0) && <div hidden={!effective} inert={!effective}>
      <RuntimeOptionSchemaForm key={defaultsRevision} compact showAll={external} showNoMatch={hasSchemaOptions} schema={formEffective.schema} values={values} scope={formEffective.scope} disabled={disabled || !effective}
        onChange={next => { setDefaultsRestored(false); onChange({ provider_options: { ...cfg.provider_options, [provider]: next } }); }}
        filter={schemaFilter}
        inheritLabel={option => automaticProviderTelemetry(provider, option.key, runtimeFlags, values) ? providerTelemetryCopy[locale].automatic : undefined}
        hint={option => automaticProviderTelemetry(provider, option.key, runtimeFlags, values) ? providerTelemetryCopy[locale].hint : undefined}
        onInvalid={onInvalid} validationDescriptions={issueDescriptions}
        confirmSyntaxFor={option => formEffective.help_keys.includes(option.key)}
        onConfirmSyntax={confirmable ? (option, syntax) => confirmSyntax(option.key, syntax) : undefined} />
    </div>}
    {visible.map(option => <OptionField key={`${provider}:${option.key}`} option={option} value={values[option.key]} disabled={disabled} automaticTelemetry={automaticProviderTelemetry(provider, option.key, runtimeFlags, values)} onChange={value => update(option.key, value)} onInvalid={onInvalid} />)}
    {adapters && (showLora || showBinding) && <h3>{copy.adapters}</h3>}
    {adapters && showLora && <OptionField option={{ key: 'lora_adapters', target: 'launch', group: 'adapters', kind: { type: 'json' } }} value={values.lora_adapters} disabled={disabled} onChange={value => update('lora_adapters', value)} onInvalid={onInvalid} />}
    {adapters && showBinding && <OptionField option={{ key: bindingKey, target: provider === 'vllm' ? 'request' : 'launch', group: 'adapters', kind: { type: 'text' } }} value={values[bindingKey]} disabled={disabled} onChange={value => update(bindingKey, value)} onInvalid={onInvalid} />}
    {advanced && <OptionTools collapsed={collapseTools} label={modelSettingsCopy[locale].optionTools}>
    {managedOptions.length > 0 && <section aria-label={modelSettingsCopy[locale].managedArguments}>
      <h4>{modelSettingsCopy[locale].managedArguments}</h4>
      {managedOptions.map(option => <SchemaOptionField key={option.key} option={option} stored={values[option.key]} disabled onStore={value => update(option.key, value)} />)}
    </section>}
    {provider !== 'llama.cpp' && !api.isExternalProvider(provider) && <OptionField option={{ key: 'extra_args', target: 'launch', group: 'advanced', kind: { type: 'json' } }} value={values.extra_args} disabled={disabled} onChange={value => update('extra_args', value)} onInvalid={onInvalid} />}
    {editor === 'schema' && <><label>{copy.import}<textarea className="app-textarea" disabled={disabled} value={paste} onChange={event => { importRequest.current += 1; setPaste(event.target.value); }} /></label>
    <label>{commandImportCopy[locale].syntax}<CustomSelect<api.CommandSyntax | ''> ariaLabel={commandImportCopy[locale].syntax}
      value={importSyntax} disabled={disabled}
      options={[{ value: '', label: commandImportCopy[locale].choose }, { value: 'windows', label: commandImportCopy[locale].windows }, { value: 'posix', label: commandImportCopy[locale].posix }]}
      onChange={value => { importRequest.current += 1; setImportSyntax(value); }} /></label>
    <button type="button" className="app-button app-button--secondary" disabled={disabled || !paste.trim() || !importSyntax} onClick={importCommand}>{copy.import}</button></>}
    <button type="button" className="app-button app-button--secondary" disabled={disabled || runtimeNeeded} onClick={() => {
      const source = cfg;
      const request = ++previewRequest.current;
      const current = () => cfgRef.current === source && previewRequest.current === request;
      void api.providerCommandPreview(source).then(args => {
        if (!current()) return;
        setPreviewError('');
        setPreview((effective ? maskPreview(args, effective.schema, values, liveEntrySecrets()) : args).map(arg => JSON.stringify(arg)).join(' '));
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
      onSave={options => { const fingerprint = effective.accepted_fingerprint; if (fingerprint) saveSyntax(() => api.runtimeHelpConfirmSyntax(cfg, fingerprint, options)); }}
      onDraftSecrets={reportDraftSecrets} />}
    {effective && <RuntimeFactDifferences conflicts={effective.conflicts} metadata={effective.metadata} schema={effective.schema} />}
    {effective && <RuntimeHelpReview key={`${provider}:${selectedRuntime}`} cfg={cfg} effective={effective} disabled={disabled} draftPrefixSecrets={draftSecretIndices} onAccepted={() => { setEffectiveRevision(current => current + 1); checkedSchema.retry(); }} />}
    </OptionTools>}
    {!validating && !loadingSchema && !error && !schemaError && !runtimeNeeded && !advanced && !hasSchemaOptions && !(adapters && (showLora || showBinding)) && <p className="app-section-hint">{copy.noOptions}</p>}
    {schemaError && <FeedbackBanner tone="error" action={{ label: profileSchemaCopy[locale].retry, disabled: disabled || loadingSchema, onClick: () => {
      if (disabled || loadingSchema) return;
      setEffectiveRevision(value => value + 1); checkedSchema.retry();
    } }}>{schemaError}</FeedbackBanner>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    {importReview && <FeedbackBanner tone="warning">{importReview}</FeedbackBanner>}
  </div>;
}

function OptionTools({ collapsed, label, children }: { collapsed: boolean; label: string; children: ReactNode }) {
  return collapsed
    ? <details><summary>{label}</summary><div className="model-settings-fields">{children}</div></details>
    : <>{children}</>;
}

function OptionField({ option, value, disabled, automaticTelemetry = false, onChange, onInvalid }: { option: api.ProviderOption; value: unknown; disabled: boolean; automaticTelemetry?: boolean; onChange: (value: unknown) => void; onInvalid: (key: string, invalid: boolean) => void }) {
  const { locale } = useI18n(); const copy = providerCopy[locale];
  const text = value === undefined ? '' : option.kind.type === 'json' || typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
  const [draft, setDraft] = useState(text);
  const [invalid, setInvalid] = useState(false);
  const [jsonNumberError, setJsonNumberError] = useState(false);
  const saved = useRef({ text, key: option.key });
  const invalidRef = useRef(false);
  const errorId = useId();
  useEffect(() => {
    // The initial state already contains the saved value. A late first effect
    // or a new validation listener must not replace an edit made meanwhile.
    if (saved.current.text !== text || saved.current.key !== option.key) {
      saved.current = { text, key: option.key };
      setDraft(text); setInvalid(false); setJsonNumberError(false); invalidRef.current = false;
    }
    onInvalid(`provider:${option.key}`, invalidRef.current);
    return () => onInvalid(`provider:${option.key}`, false);
  }, [text, option.key, onInvalid]);
  const edit = (text: string) => {
    setDraft(text);
    setJsonNumberError(false);
    if (!text.trim()) { invalidRef.current = false; setInvalid(false); onInvalid(`provider:${option.key}`, false); onChange(undefined); return; }
    try {
      let parsed: unknown = text;
      if (option.kind.type === 'json') parsed = parseJsonOption(text);
      if (['integer', 'number'].includes(option.kind.type)) {
        parsed = Number(text);
        if (!Number.isFinite(parsed) || option.kind.type === 'integer' && !Number.isSafeInteger(parsed) || option.kind.min !== undefined && Number(parsed) < option.kind.min || option.kind.max !== undefined && Number(parsed) > option.kind.max) throw new Error('range');
      }
      invalidRef.current = false; setInvalid(false); onInvalid(`provider:${option.key}`, false); onChange(parsed);
    } catch (cause) { invalidRef.current = true; setInvalid(true); setJsonNumberError(cause instanceof JsonOptionNumberError); onInvalid(`provider:${option.key}`, true); }
  };
  return <label>{option.flag ?? option.key} <small>{option.target === 'launch' ? copy.launch : copy.request} · {copy.inherit}: {option.runtime_default ?? copy.modelDefault}</small>
    {automaticTelemetry && <small>{providerTelemetryCopy[locale].hint}</small>}
    {['flag', 'toggle', 'choice'].includes(option.kind.type) ? <CustomSelect ariaLabel={option.flag ?? option.key} disabled={disabled} value={text} onChange={value => onChange(value === '' ? undefined : ['flag', 'toggle'].includes(option.kind.type) ? value === 'true' : value)}
      options={[{ value: '', label: automaticTelemetry ? providerTelemetryCopy[locale].automatic : copy.inherit }, ...(option.kind.choices ?? ['true', 'false']).map(value => ({ value, label: value }))]} /> : option.kind.type === 'json' ? <textarea className="app-textarea" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} onChange={event => edit(event.target.value)} />
      : <input className="app-input" disabled={disabled} value={draft} aria-invalid={invalid || undefined} aria-describedby={invalid ? errorId : undefined} inputMode={['integer', 'number'].includes(option.kind.type) ? 'decimal' : 'text'} onChange={event => edit(event.target.value)} />}
    {invalid && <span id={errorId} role="alert">{jsonNumberError ? runtimeOptionsCopy[locale].jsonNumberRange : copy.invalid}</span>}
  </label>;
}
