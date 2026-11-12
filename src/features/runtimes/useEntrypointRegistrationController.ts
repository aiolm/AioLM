import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  entrypointHelpCancel,
  entrypointHelpDiscover,
  entrypointManifestPreview,
  EntrypointHelpPendingError,
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
import { useI18n } from '../../shared/i18n/i18n';
import { entrypointCopy } from '../../shared/i18n/entrypointCopy';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { helpSummary } from './helpSummary';
import type { HelpTextChoice } from './HelpTextSettings';
import type { BindingState, EntrypointRegistrationController, EntrypointRegistrationProps, EntrypointRegistrationStep } from './entrypointRegistrationTypes';
import { isIpcErrorKind } from '../../shared/api/ipcError';

const noBinding: BindingState = { mode: 'none', flag: '', equals: false };

function toBinding(state: BindingState): ArgBinding | null {
  if (state.mode === 'positional') return { kind: 'positional' };
  if (state.mode === 'flag' && state.flag.trim()) return { kind: 'flag', flag: state.flag.trim(), equals: state.equals };
  return null;
}

/** Owns the draft, help task lifetime and generation guards for the entire wizard. */
export function useEntrypointRegistrationController({ locked, onRegistered, onPublished, onBusyChange, cfg }: EntrypointRegistrationProps): EntrypointRegistrationController {
  const { locale } = useI18n();
  const copy = entrypointCopy[locale];
  const id = useId();
  const taskId = `entrypoint-help-${id}`;
  const [step, setStep] = useState<EntrypointRegistrationStep>(0);
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
  const [helpPending, setHelpPending] = useState<EntrypointDraft | null>(null);
  const pendingRegistration = useRef<EntrypointDraft | null>(null);
  const generation = useRef(0);
  const pendingHelp = useRef<EntrypointHelp | null>(null);
  const cancelled = useRef(false);
  useEffect(() => () => {
    generation.current += 1;
    pendingRegistration.current = null;
    // Only help discovery still in flight is cancelled. A settled run keeps its
    // record: a failure stays with its detail until the user dismisses it.
    if (pendingHelp.current) {
      void entrypointHelpCancel(pendingHelp.current).catch(() => undefined);
      finishTask(taskId, 'cancelled');
    }
    pendingHelp.current = null;
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
    if (busy || locked || pendingRegistration.current) return;
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
      // Child diagnostics can mention cancellation without cancelling this run.
      const wasCancelled = cancelled.current || isIpcErrorKind(cause, 'cancelled');
      if (!wasCancelled) setError(message);
      finishTask(taskId, wasCancelled ? 'cancelled' : 'failed', message);
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
    if (busy || locked || pendingRegistration.current) return;
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
    if (busy || locked || pendingRegistration.current) return;
    const incomplete = incompleteBinding();
    if (incomplete) { setError(`${incomplete}: ${copy.bindingIncomplete}`); return; }
    const next = draft();
    if (!next) { setError(copy.required); return; }
    const submitted = structuredClone(next);
    const ownGeneration = ++generation.current;
    setBusy(true); setError('');
    try {
      const registered = await runtimeEntrypointRegister(submitted, { reportHelpPending: true });
      if (generation.current !== ownGeneration) return;
      setDone(true);
      onRegistered(registered.engine_id as ProviderId, registered);
    } catch (cause) {
      if (generation.current !== ownGeneration) return;
      if (cause instanceof EntrypointHelpPendingError) {
        pendingRegistration.current = submitted;
        setHelpPending(submitted);
        onPublished?.();
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ownGeneration) setBusy(false);
    }
  };

  const retryHelp = async () => {
    const submitted = pendingRegistration.current;
    if (busy || locked || !submitted) return;
    const ownGeneration = ++generation.current;
    setBusy(true); setError('');
    try {
      const registered = await runtimeEntrypointRegister(submitted, { reportHelpPending: true, resumeHelp: true });
      if (generation.current !== ownGeneration || pendingRegistration.current !== submitted) return;
      pendingRegistration.current = null;
      setHelpPending(null); setDone(true);
      onRegistered(registered.engine_id as ProviderId, registered);
    } catch (cause) {
      if (generation.current === ownGeneration && pendingRegistration.current === submitted) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation.current === ownGeneration) setBusy(false);
    }
  };

  const onPrepared = (prepared: EntrypointDraft) => {
    if (pendingRegistration.current) return;
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
  };
  const changeHelpArgs = (next: string[]) => { setHelpArgs(next); setFound(null); setSkipHelp(false); };
  const changeTextChoice = (next: HelpTextChoice) => {
    generation.current += 1;
    setTextChoice(next); setFound(null); setSkipHelp(false); setError('');
  };
  const cancelHelp = () => {
    cancelled.current = true;
    updateTask(taskId, { state: 'cancelling' });
    void entrypointHelpCancel(entry).catch(cause => setError(String(cause)));
  };
  const previous = () => { if (!pendingRegistration.current) setStep((step - 1) as EntrypointRegistrationStep); };
  const next = () => { if (!pendingRegistration.current) setStep((step + 1) as EntrypointRegistrationStep); };

  const disabled = locked || busy || !!helpPending;
  const steps = [copy.stepEntry, copy.stepHelp, copy.stepBindings, copy.stepReview];
  const canContinue = ([
    !!engine.trim() && !!runtime.trim() && !!program.trim() && (protocol === 'openai_http' || (!!bridgeProgram.trim() && !!bridgeArgvEnv.trim())) && metadata.ok,
    helpChecked || skipHelp,
    true,
    true,
  ] as const)[step];

  return {
    id, copy, locked, step, steps, disabled, busy, setBusy, error, setError, canContinue, previous, next, onPrepared,
    engine, setEngine, runtime, setRuntime, displayName, setDisplayName, program, setProgram, prefix, setPrefix,
    workingDir, setWorkingDir, artifacts, setArtifacts, env, setEnv, protocol, setProtocol,
    bridgeProgram, setBridgeProgram, bridgePrefix, setBridgePrefix, bridgeArgvEnv, setBridgeArgvEnv,
    metadataText, setMetadataText, metadata, commandLayout, setCommandLayout,
    helpArgs, changeHelpArgs, textChoice, changeTextChoice, taskId, discover, cancelHelp, found, current, summary, skipHelp, setSkipHelp,
    model, setModel, port, setPort, host, setHost, served, setServed, documented, positionalDocumented, helpChecked,
    auth, setAuth, authName, setAuthName, probeProgram, setProbeProgram, probeArgs, setProbeArgs,
    healthPath, setHealthPath, healthAuth, setHealthAuth, formats, setFormats,
    review, manifest, done, helpPending, retryHelp, register,
  };
}
