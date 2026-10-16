import { useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import {
  entrypointHelpCancel,
  entrypointHelpDiscover,
  entrypointManifestPreview,
  pickRuntimePath,
  runtimeEntrypointRegister,
  type ArgBinding,
  type AuthBinding,
  type EntrypointDraft,
  type EntrypointHelp,
  type HelpReport,
  type HelpRequest,
  type OptionMetadata,
  type RuntimeDescriptor,
} from '../../shared/api/runtimeHelp';
import type { ProviderId } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import { useI18n } from '../../shared/i18n/i18n';
import { entrypointCopy } from '../../shared/i18n/entrypointCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { helpSummary } from './helpSummary';
import RuntimeArgumentList from './RuntimeArgumentList';
import RuntimeSchemaChanges from './RuntimeSchemaChanges';
import AdapterSetupPanel from './AdapterSetupPanel';
import RuntimeCommandLayout from './RuntimeCommandLayout';
import HelpTextSettings, { type HelpTextChoice } from './HelpTextSettings';

type Copy = (typeof entrypointCopy)['en'];
type Step = 0 | 1 | 2 | 3;
const FORMATS = ['gguf', 'hf-safetensors', 'mlx', 'unknown'] as const;

function PathField({ label, value, kind, disabled, required = false, copy, onChange }: {
  label: string; value: string; kind: 'file' | 'folder'; disabled: boolean; required?: boolean; copy: Copy; onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <span className="entrypoint-path">
      <label htmlFor={id}>{label}</label>
      <input id={id} name={label} className="app-input" value={value} disabled={disabled} required={required}
        autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => onChange(event.target.value)} />
      <button type="button" className="app-button app-button--secondary" disabled={disabled}
        onClick={() => void pickRuntimePath(kind).then(path => { if (path) onChange(path); })}>{copy.choose}</button>
    </span>
  );
}

interface BindingState { mode: 'none' | 'flag' | 'positional'; flag: string; equals: boolean }
const noBinding: BindingState = { mode: 'none', flag: '', equals: false };

function toBinding(state: BindingState): ArgBinding | null {
  if (state.mode === 'positional') return { kind: 'positional' };
  if (state.mode === 'flag' && state.flag.trim()) return { kind: 'flag', flag: state.flag.trim(), equals: state.equals };
  return null;
}

/** One app-owned binding: a documented help option (or typed name without
 * help), the positional slot, or unused when the binding is optional. */
function BindingField({ label, state, optional, documented, positionalDocumented, helpChecked, disabled, copy, onChange }: {
  label: string; state: BindingState; optional: boolean; documented: string[]; positionalDocumented: boolean; helpChecked: boolean;
  disabled: boolean; copy: Copy; onChange: (next: BindingState) => void;
}) {
  const id = useId();
  const modes = [
    ...(optional ? [{ value: 'none', label: copy.none }] : []),
    { value: 'flag', label: helpChecked ? copy.flagChoice : copy.flagText },
    ...(!helpChecked || positionalDocumented ? [{ value: 'positional', label: copy.positional }] : []),
  ];
  return (
    <fieldset>
      <legend>{label}</legend>
      <CustomSelect ariaLabel={label} value={state.mode} disabled={disabled} options={modes}
        onChange={mode => onChange({ ...state, mode: mode as BindingState['mode'] })} />
      {state.mode === 'flag' && (helpChecked ? (
        <CustomSelect ariaLabel={`${label} ${copy.flagChoice}`} value={state.flag} disabled={disabled}
          options={[{ value: '', label: copy.flagChoice }, ...documented.map(flag => ({ value: flag, label: flag }))]}
          onChange={flag => onChange({ ...state, flag })} />
      ) : (
        <span>
          <label htmlFor={`${id}-flag`}>{copy.flagText}</label>
          <input id={`${id}-flag`} name={`${label}-flag`} className="app-input" value={state.flag} disabled={disabled}
            autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => onChange({ ...state, flag: event.target.value })} />
        </span>
      ))}
      {state.mode === 'flag' && (
        <label><input type="checkbox" checked={state.equals} disabled={disabled}
          onChange={event => onChange({ ...state, equals: event.target.checked })} /> {copy.equals}</label>
      )}
    </fieldset>
  );
}

/** Executable/entry point → help → explicit bindings, protocol and probe →
 * reviewed manifest → register. Nothing is inferred; a fresh model probe
 * after registration decides Ready. */
export default function EntrypointRegistration({ locked, onRegistered, onBusyChange, titleRef, cfg }: {
  locked: boolean; onRegistered: (engine: ProviderId, registered: { runtime_id: string; display_name: string }) => void; onBusyChange?: (busy: boolean) => void; titleRef?: Ref<HTMLHeadingElement>;
  cfg?: AppConfig;
}) {
  const { locale } = useI18n();
  const copy = entrypointCopy[locale];
  const id = useId();
  const taskId = `entrypoint-help-${id}`;
  const [step, setStep] = useState<Step>(0);
  const [engine, setEngine] = useState('custom.');
  const [runtime, setRuntime] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [program, setProgram] = useState('');
  const [prefix, setPrefix] = useState<string[]>([]);
  const [workingDir, setWorkingDir] = useState('');
  const [artifacts, setArtifacts] = useState<string[]>([]);
  const [env, setEnv] = useState<Array<[string, string]>>([]);
  const [protocol, setProtocol] = useState<'openai_http' | 'bridge'>('openai_http');
  const [bridgeProgram, setBridgeProgram] = useState('');
  const [bridgePrefix, setBridgePrefix] = useState<string[]>([]);
  const [bridgeArgvEnv, setBridgeArgvEnv] = useState('');
  const [metadataText, setMetadataText] = useState('');
  const [commandLayout, setCommandLayout] = useState<EntrypointHelp['command_layout']>();
  const [helpArgs, setHelpArgs] = useState<string[]>(['--help']);
  const [textChoice, setTextChoice] = useState<HelpTextChoice>({});
  const [found, setFound] = useState<{ entry: string; request: HelpRequest; result: [HelpReport, RuntimeDescriptor] } | null>(null);
  const [skipHelp, setSkipHelp] = useState(false);
  const [model, setModel] = useState<BindingState>({ ...noBinding, mode: 'flag' });
  const [port, setPort] = useState<BindingState>({ ...noBinding, mode: 'flag' });
  const [host, setHost] = useState<BindingState>(noBinding);
  const [served, setServed] = useState<BindingState>(noBinding);
  const [auth, setAuth] = useState<'none' | 'env'>('none');
  const [authName, setAuthName] = useState('');
  const [probeProgram, setProbeProgram] = useState('');
  const [probeArgs, setProbeArgs] = useState<string[]>([]);
  const [probeEnvironment, setProbeEnvironment] = useState<Record<string, string>>({});
  const [probeWorkingDir, setProbeWorkingDir] = useState<string | null>(null);
  const [launchResources, setLaunchResources] = useState<EntrypointDraft['launch_resources']>();
  const [optionsSeparator, setOptionsSeparator] = useState<EntrypointDraft['options_separator']>();
  const [modelBindings, setModelBindings] = useState<EntrypointDraft['models']>();
  const [healthPath, setHealthPath] = useState('');
  const [healthAuth, setHealthAuth] = useState(false);
  const [formats, setFormats] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [manifest, setManifest] = useState('');
  const [done, setDone] = useState(false);
  const generation = useRef(0);
  const pendingHelp = useRef<EntrypointHelp | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => {
    generation.current += 1;
    if (pendingHelp.current) void entrypointHelpCancel(pendingHelp.current).catch(() => undefined);
    pendingHelp.current = null;
    finishTask(taskId, 'cancelled');
  }, [taskId]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => () => onBusyChange?.(false), [onBusyChange]);

  // Explicit adapter metadata is passed through as given; the backend checks
  // its version, engine and provenance. Nothing is added when it is empty.
  const metadata = useMemo((): { ok: boolean; value?: OptionMetadata } => {
    if (!metadataText.trim()) return { ok: true };
    try {
      const value: unknown = JSON.parse(metadataText);
      return value && typeof value === 'object' && !Array.isArray(value) ? { ok: true, value: value as OptionMetadata } : { ok: false };
    } catch {
      return { ok: false };
    }
  }, [metadataText]);
  const entry: EntrypointHelp = useMemo(() => ({
    engine_id: engine.trim(), runtime_id: runtime.trim(), program: program.trim(), prefix,
    working_directory: workingDir.trim() || null, artifacts,
    environment: Object.fromEntries(env.filter(([name]) => name.trim())),
    protocol: protocol === 'bridge' ? { kind: 'bridge', program: bridgeProgram.trim(), prefix: bridgePrefix, engine_argv_env: bridgeArgvEnv.trim() } : { kind: 'openai_http' },
    ...(metadata.value ? { option_metadata: metadata.value } : {}),
    ...(commandLayout ? { command_layout: commandLayout } : {}),
  }), [engine, runtime, program, prefix, workingDir, artifacts, env, protocol, bridgeProgram, bridgePrefix, bridgeArgvEnv, metadata, commandLayout]);
  const entryKey = JSON.stringify(entry);
  const current = found && found.entry === entryKey ? found : null;
  const schema = current?.result[1].schema;
  const helpChecked = !!current && current.result[1].help_complete && !skipHelp;
  const documented = useMemo(() => (schema ? schema.options.flatMap(option => option.spellings.map(spelling => spelling.flag)) : []), [schema]);
  const positionalDocumented = !!schema?.options.some(option => option.position !== null && option.position !== undefined);
  const summary = current ? helpSummary(current.result[1]) : null;

  const discover = async () => {
    if (busy) return;
    const ownGeneration = ++generation.current;
    cancelled.current = false; pendingHelp.current = entry;
    const request: HelpRequest = { program: null, args: [...(protocol === 'bridge' ? bridgePrefix : prefix), ...helpArgs], scope: commandLayout?.subcommands.map(index => (protocol === 'bridge' ? bridgePrefix : prefix)[index] ?? '') ?? [], ...textChoice };
    setBusy(true); setError(''); setSkipHelp(false);
    registerTask({ id: taskId, kind: 'runtime', label: copy.title, interruptible: true, cancel: () => { cancelled.current = true; void entrypointHelpCancel(entry); } });
    try {
      const result = await (cfg ? entrypointHelpDiscover(entry, request, cfg) : entrypointHelpDiscover(entry, request));
      if (generation.current !== ownGeneration) return;
      if (!cancelled.current) setFound({ entry: entryKey, request, result });
      finishTask(taskId, cancelled.current ? 'cancelled' : 'completed');
    } catch (cause) {
      if (generation.current !== ownGeneration) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = message.includes('cancelled');
      if (!cancelled) setError(message);
      finishTask(taskId, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      if (generation.current === ownGeneration) { pendingHelp.current = null; setBusy(false); }
    }
  };

  const draft = (): EntrypointDraft | null => {
    const modelBinding = toBinding(model);
    const portBinding = toBinding(port);
    const authBinding: AuthBinding = auth === 'env' ? { kind: 'env', name: authName.trim() } : { kind: 'none' };
    if (!modelBinding || !portBinding || !probeProgram.trim() || !healthPath.trim() || formats.length === 0 || (auth === 'env' && !authName.trim())) return null;
    return {
      ...entry,
      display_name: displayName.trim() || engine.trim(),
      model: modelBinding,
      port: portBinding,
      host: toBinding(host),
      served_model: toBinding(served),
      auth: authBinding,
      probe: { program: probeProgram.trim(), args: probeArgs, env: probeEnvironment, working_directory: probeWorkingDir },
      ...(launchResources ? { launch_resources: launchResources } : {}),
      ...(optionsSeparator ? { options_separator: optionsSeparator } : {}),
      ...(modelBindings?.length ? { models: modelBindings } : {}),
      health_path: healthPath.trim(),
      health_authenticated: healthAuth,
      model_formats: formats,
      help: helpChecked && current ? { fingerprint: current.result[1].fingerprint, request: current.request } : null,
    };
  };

  // An optional binding the user switched on must name its argument; it is
  // never registered as "Not used" behind their back.
  const incompleteBinding = () => ([[copy.host, host], [copy.served, served]] as const)
    .find(([, state]) => state.mode !== 'none' && !toBinding(state))?.[0];

  const review = async () => {
    if (busy || locked) return;
    const incomplete = incompleteBinding();
    if (incomplete) { setError(`${incomplete}: ${copy.bindingIncomplete}`); return; }
    const next = draft();
    if (!next) { setError(copy.required); return; }
    const ownGeneration = ++generation.current;
    setBusy(true); setError(''); setDone(false);
    try {
      const preview = await entrypointManifestPreview(next);
      if (generation.current !== ownGeneration) return;
      setManifest(JSON.stringify(preview, null, 2));
      setStep(3);
    } catch (cause) {
      if (generation.current === ownGeneration) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ownGeneration) setBusy(false);
    }
  };

  const register = async () => {
    if (busy || locked) return;
    const incomplete = incompleteBinding();
    if (incomplete) { setError(`${incomplete}: ${copy.bindingIncomplete}`); return; }
    const next = draft();
    if (!next) { setError(copy.required); return; }
    const ownGeneration = ++generation.current;
    setBusy(true); setError('');
    try {
      const registered = await runtimeEntrypointRegister(next);
      if (generation.current !== ownGeneration) return;
      setDone(true);
      onRegistered(registered.engine_id as ProviderId, registered);
    } catch (cause) {
      if (generation.current === ownGeneration) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ownGeneration) setBusy(false);
    }
  };

  const disabled = locked || busy;
  const steps = [copy.stepEntry, copy.stepHelp, copy.stepBindings, copy.stepReview];
  const canContinue = [
    !!engine.trim() && !!runtime.trim() && !!program.trim() && (protocol === 'openai_http' || (!!bridgeProgram.trim() && !!bridgeArgvEnv.trim())) && metadata.ok,
    helpChecked || skipHelp,
    true,
    true,
  ][step];

  return (
    <section className="app-card app-card--tight mb-4 entrypoint-registration" aria-labelledby={`${id}-title`}>
      <h3 id={`${id}-title`} ref={titleRef} tabIndex={-1} className="app-section-title">{copy.title}</h3>
      <p className="app-section-hint">{copy.hint}</p>
      <div hidden={step !== 0}><AdapterSetupPanel disabled={locked || busy} onBusyChange={setBusy} onPrepared={prepared => {
        const binding = (value: ArgBinding | null | undefined): BindingState => value?.kind === 'flag'
          ? { mode: 'flag', flag: value.flag, equals: value.equals ?? false }
          : value?.kind === 'positional' ? { mode: 'positional', flag: '', equals: false } : noBinding;
        setEngine(prepared.engine_id); setRuntime(prepared.runtime_id); setDisplayName(prepared.display_name);
        setProgram(prepared.program); setPrefix(prepared.prefix); setWorkingDir(prepared.working_directory ?? '');
        setArtifacts(prepared.artifacts); setEnv(Object.entries(prepared.environment));
        setProtocol(prepared.protocol.kind);
        setBridgeProgram(prepared.protocol.kind === 'bridge' ? prepared.protocol.program : '');
        setBridgePrefix(prepared.protocol.kind === 'bridge' ? prepared.protocol.prefix : []);
        setBridgeArgvEnv(prepared.protocol.kind === 'bridge' ? prepared.protocol.engine_argv_env ?? '' : '');
        setMetadataText(prepared.option_metadata ? JSON.stringify(prepared.option_metadata, null, 2) : '');
        setModel(binding(prepared.model)); setPort(binding(prepared.port)); setHost(binding(prepared.host)); setServed(binding(prepared.served_model));
        setAuth(prepared.auth.kind); setAuthName(prepared.auth.kind === 'env' ? prepared.auth.name : '');
        setProbeProgram(prepared.probe.program); setProbeArgs(prepared.probe.args); setProbeEnvironment(prepared.probe.env);
        setProbeWorkingDir(prepared.probe.working_directory ?? null);
        setLaunchResources(prepared.launch_resources); setModelBindings(prepared.models);
        setOptionsSeparator(prepared.options_separator);
        setCommandLayout(prepared.command_layout);
        setHealthPath(prepared.health_path); setHealthAuth(prepared.health_authenticated); setFormats(prepared.model_formats);
        setHelpArgs(['--help']); setFound(null); setSkipHelp(false); setManifest(''); setDone(false); setError('');
        setStep(1);
      }} /></div>
      <nav aria-label={copy.steps}>
        <ol className="entrypoint-steps">
          {steps.map((label, index) => <li key={label} aria-current={index === step ? 'step' : undefined}>{label}</li>)}
        </ol>
      </nav>
      {locked && !busy && <p>{copy.locked}</p>}
      <form action="#" method="POST" onSubmit={event => event.preventDefault()}>
        {step === 0 && (
          <div className="model-settings-fields">
            <div className="entrypoint-primary">
              <PathField label={copy.program} value={program} kind="file" disabled={disabled} required copy={copy} onChange={setProgram} />
            </div>
            <RuntimeArgumentList label={copy.prefix} tokens={prefix} disabled={disabled} onError={setError} onChange={setPrefix}
              onFile={path => setArtifacts(current => (current.includes(path) ? current : [...current, path]))} />
            {([[copy.display, displayName, setDisplayName], [copy.engine, engine, setEngine], [copy.runtime, runtime, setRuntime]] as const).map(([label, value, set]) => (
              <label key={label} htmlFor={`${id}-${label}`}>{label}
                <input id={`${id}-${label}`} name={label} className="app-input" value={value} disabled={disabled}
                  autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => set(event.target.value)} />
              </label>
            ))}
            <PathField label={copy.workingDir} value={workingDir} kind="folder" disabled={disabled} copy={copy} onChange={setWorkingDir} />
            <RuntimeArgumentList label={copy.artifacts} tokens={artifacts} disabled={disabled} onError={setError} onChange={setArtifacts} onFile={() => undefined} />
            <fieldset>
              <legend>{copy.environment}</legend>
              {env.map(([name, value], index) => (
                <span key={index} className="entrypoint-token">
                  <input className="app-input" name={`env-name-${index}`} aria-label={`${copy.variableName} ${index + 1}`} value={name} disabled={disabled}
                    autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    onChange={event => setEnv(env.map((pair, i) => (i === index ? [event.target.value, pair[1]] : pair)))} />
                  <input className="app-input" name={`env-value-${index}`} aria-label={`${copy.variableValue} ${index + 1}`} value={value} disabled={disabled}
                    autoCorrect="off" autoCapitalize="off" spellCheck={false}
                    onChange={event => setEnv(env.map((pair, i) => (i === index ? [pair[0], event.target.value] : pair)))} />
                  <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setEnv(env.filter((_, i) => i !== index))}>{copy.remove}</button>
                </span>
              ))}
              <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setEnv([...env, ['', '']])}>{copy.addVariable}</button>
            </fieldset>
            <fieldset>
              <legend>{copy.protocol}</legend>
              <label><input type="radio" name={`${id}-protocol`} checked={protocol === 'openai_http'} disabled={disabled} onChange={() => setProtocol('openai_http')} /> {copy.direct}</label>
              <label><input type="radio" name={`${id}-protocol`} checked={protocol === 'bridge'} disabled={disabled} onChange={() => setProtocol('bridge')} /> {copy.bridge}</label>
              {protocol === 'bridge' && (
                <>
                  <PathField label={copy.bridgeProgram} value={bridgeProgram} kind="file" disabled={disabled} required copy={copy} onChange={setBridgeProgram} />
                  <RuntimeArgumentList label={copy.bridgePrefix} tokens={bridgePrefix} disabled={disabled} onChange={setBridgePrefix} onError={setError}
                    onFile={path => setArtifacts(current => (current.includes(path) ? current : [...current, path]))} />
                  <label htmlFor={`${id}-bridge-argv-env`}>{copy.bridgeArgvEnv}
                    <input id={`${id}-bridge-argv-env`} className="app-input" value={bridgeArgvEnv} disabled={disabled} required
                      autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setBridgeArgvEnv(event.target.value)} />
                  </label>
                  <p className="app-section-hint">{copy.bridgeContract}</p>
                </>
              )}
            </fieldset>
            <RuntimeCommandLayout prefix={protocol === 'bridge' ? bridgePrefix : prefix} value={commandLayout} disabled={disabled} onChange={setCommandLayout} />
            <label htmlFor={`${id}-metadata`}>{copy.optionMetadata}</label>
            <textarea id={`${id}-metadata`} name="option-metadata" className="app-textarea" value={metadataText} disabled={disabled}
              autoCorrect="off" autoCapitalize="off" spellCheck={false}
              aria-describedby={`${id}-metadata-hint${metadata.ok ? '' : ` ${id}-metadata-error`}`} aria-invalid={!metadata.ok || undefined}
              onChange={event => setMetadataText(event.target.value)} />
            <p id={`${id}-metadata-hint`} className="app-section-hint">{copy.optionMetadataHint}</p>
            {!metadata.ok && <span id={`${id}-metadata-error`} role="alert">{copy.optionMetadataInvalid}</span>}
          </div>
        )}
        {step === 1 && (
          <div className="model-settings-fields">
            {protocol === 'bridge' && <p className="app-section-hint">{copy.bridgeHelp}</p>}
            <RuntimeArgumentList label={copy.helpArgs} tokens={helpArgs} disabled={disabled} onChange={next => { setHelpArgs(next); setFound(null); setSkipHelp(false); }} />
            <HelpTextSettings value={textChoice} disabled={disabled} onChange={next => {
              generation.current += 1;
              setTextChoice(next); setFound(null); setSkipHelp(false); setError('');
            }} />
            <div className="app-page-actions">
              <button type="button" className="app-button app-button--primary" disabled={disabled} onClick={() => void discover()}>{copy.discover}</button>
              {busy && (
                <LocalTaskCancelButton taskId={taskId} onClick={() => { cancelled.current = true; updateTask(taskId, { state: 'cancelling' }); void entrypointHelpCancel(entry).catch(cause => setError(String(cause))); }}>{copy.cancel}</LocalTaskCancelButton>
              )}
              <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setSkipHelp(true)}>{copy.skipHelp}</button>
            </div>
            {found && !current && <FeedbackBanner tone="warning">{copy.stale}</FeedbackBanner>}
            {skipHelp && <FeedbackBanner tone="warning">{copy.helpSkipped}</FeedbackBanner>}
            {current && summary && (
              <div role="status">
                <p>{copy.discovered}: {summary.total} {copy.options}</p>
                <RuntimeSchemaChanges descriptor={current.result[1]} />
                {summary.uncertain.length > 0 && <p>{copy.uncertain}: {summary.uncertain.length} ({summary.uncertain.slice(0, 20).join(', ')}{summary.uncertain.length > 20 ? ', …' : ''})</p>}
                {!current.result[1].help_complete && <FeedbackBanner tone="error">{copy.incomplete}</FeedbackBanner>}
                <details>
                  <summary>{copy.rawHelp}</summary>
                  <pre className="overflow-auto whitespace-pre-wrap">{[current.result[0].stdout.clean_text, current.result[0].stderr.clean_text].filter(Boolean).join('\n')}</pre>
                </details>
              </div>
            )}
          </div>
        )}
        {step === 2 && (
          <div className="model-settings-fields">
            <BindingField label={copy.model} state={model} optional={false} documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setModel} />
            <BindingField label={copy.port} state={port} optional={false} documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setPort} />
            <BindingField label={copy.host} state={host} optional documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setHost} />
            <BindingField label={copy.served} state={served} optional documented={documented} positionalDocumented={positionalDocumented} helpChecked={helpChecked} disabled={disabled} copy={copy} onChange={setServed} />
            <fieldset>
              <legend>{copy.auth}</legend>
              <label><input type="radio" name={`${id}-auth`} checked={auth === 'none'} disabled={disabled} onChange={() => setAuth('none')} /> {copy.authNone}</label>
              <label><input type="radio" name={`${id}-auth`} checked={auth === 'env'} disabled={disabled} onChange={() => setAuth('env')} /> {copy.authEnv}</label>
              {auth === 'env' && (
                <label htmlFor={`${id}-auth-name`}>{copy.authName}
                  <input id={`${id}-auth-name`} name="credential-variable" className="app-input" value={authName} disabled={disabled} required
                    autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setAuthName(event.target.value)} />
                </label>
              )}
            </fieldset>
            <fieldset>
              <legend>{copy.probe}</legend>
              <PathField label={copy.probeProgram} value={probeProgram} kind="file" disabled={disabled} required copy={copy} onChange={setProbeProgram} />
              <RuntimeArgumentList label={copy.probeArgs} tokens={probeArgs} disabled={disabled} onChange={setProbeArgs} />
              <span className="app-page-actions">
                <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setProbeArgs([...probeArgs, '{model}'])}>{copy.insertModel}</button>
                <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => setProbeArgs([...probeArgs, '{options_json}'])}>{copy.insertOptions}</button>
              </span>
            </fieldset>
            <label htmlFor={`${id}-health`}>{copy.health}
              <input id={`${id}-health`} name="health-path" className="app-input" value={healthPath} disabled={disabled} required
                autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setHealthPath(event.target.value)} />
            </label>
            <label><input type="checkbox" checked={healthAuth} disabled={disabled} onChange={event => setHealthAuth(event.target.checked)} /> {copy.healthAuth}</label>
            <fieldset>
              <legend>{copy.formats}</legend>
              {FORMATS.map(format => (
                <label key={format}><input type="checkbox" checked={formats.includes(format)} disabled={disabled}
                  onChange={event => setFormats(event.target.checked ? [...formats, format] : formats.filter(item => item !== format))} /> {format}</label>
              ))}
            </fieldset>
          </div>
        )}
        {step === 3 && (
          <div className="model-settings-fields">
            {manifest && <pre className="overflow-auto whitespace-pre-wrap">{manifest}</pre>}
            {done ? <p role="status">{copy.registered}</p> : (
              <button type="submit" className="app-button app-button--primary" disabled={disabled} onClick={() => void register()}>{copy.register}</button>
            )}
          </div>
        )}
        <div className="app-page-actions mt-3">
          {step > 0 && <button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => setStep((step - 1) as Step)}>{copy.previous}</button>}
          {step < 2 && <button type="button" className="app-button app-button--secondary" disabled={busy || !canContinue} onClick={() => setStep((step + 1) as Step)}>{copy.next}</button>}
          {step === 2 && <button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => void review()}>{copy.review}</button>}
        </div>
      </form>
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    </section>
  );
}
