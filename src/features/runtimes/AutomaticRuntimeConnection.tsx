import { useEffect, useId, useRef, useState, type Ref } from 'react';
import {
  runtimeAutoCancel, runtimeAutoConnect, runtimeAutoDiscover, runtimeAutoInspect,
  type AutomaticRuntimeResult, type PreparedRuntimeConnection, type RuntimeCandidate,
} from '../../shared/api/runtimeAuto';
import { pickRuntimePath } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeAutoCopy } from '../../shared/i18n/runtimeAutoCopy';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import DiagnosticDetails, { summarizeDiagnostic } from '../../shared/ui/DiagnosticDetails';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';

type Phase = 'finding' | 'inspecting' | 'connecting';

function DoneIcon() {
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3.5 8.5 3 3 6-7" /></svg>;
}

/** A discovery result is only a candidate. The backend owns launch decisions,
 * model checks and publication; the UI never manufactures a ready adapter. */
export default function AutomaticRuntimeConnection({ locked, onConnected, onBusyChange, titleRef }: {
  locked: boolean;
  onConnected: (result: AutomaticRuntimeResult) => void;
  onBusyChange?: (busy: boolean) => void;
  titleRef?: Ref<HTMLHeadingElement>;
}) {
  const { locale } = useI18n();
  const copy = runtimeAutoCopy[locale];
  const id = useId();
  const taskId = `runtime-auto-${id}`;
  const [phase, setPhase] = useState<Phase | null>(null);
  const activePhase = useRef<Phase>('finding');
  const [candidates, setCandidates] = useState<RuntimeCandidate[]>([]);
  const [selected, setSelected] = useState('');
  const [searched, setSearched] = useState(false);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [prepared, setPrepared] = useState<PreparedRuntimeConnection | null>(null);
  const [model, setModel] = useState('');
  const [error, setError] = useState<{ phase: Phase; message: string } | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const [result, setResult] = useState<AutomaticRuntimeResult | null>(null);
  const operation = useRef(0);
  const running = useRef(false);
  const cancellation = useRef(false);
  const callbacks = useRef({ onBusyChange, onConnected });
  useEffect(() => { callbacks.current = { onBusyChange, onConnected }; }, [onBusyChange, onConnected]);
  useEffect(() => {
    callbacks.current.onBusyChange?.(phase !== null);
  }, [phase]);
  useEffect(() => () => {
    operation.current += 1;
    if (running.current) {
      void runtimeAutoCancel().catch(() => undefined);
      finishTask(taskId, 'cancelled');
    }
    callbacks.current.onBusyChange?.(false);
  }, [taskId]);

  const cancel = () => {
    if (!running.current || cancellation.current) return;
    const own = operation.current;
    cancellation.current = true;
    updateTask(taskId, { state: 'cancelling' });
    void runtimeAutoCancel().catch(cause => {
      if (running.current && operation.current === own) setError({ phase: activePhase.current, message: cause instanceof Error ? cause.message : String(cause) });
    });
  };

  const execute = async (nextPhase: Phase, work: (current: () => boolean) => Promise<void>) => {
    if (locked || running.current) return;
    const own = ++operation.current;
    const current = () => operation.current === own && !cancellation.current;
    running.current = true;
    cancellation.current = false;
    activePhase.current = nextPhase;
    setError(null); setCancelled(false); setResult(null); setPhase(nextPhase);
    registerTask({ id: taskId, kind: 'runtime', label: copy.title, interruptible: true, cancel });
    try {
      await work(current);
      if (operation.current !== own) return;
      setCancelled(cancellation.current);
      finishTask(taskId, cancellation.current ? 'cancelled' : 'completed');
    } catch (cause) {
      if (operation.current !== own) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      if (cancellation.current) setCancelled(true);
      else setError({ phase: activePhase.current, message });
      finishTask(taskId, cancellation.current ? 'cancelled' : 'failed', message);
    } finally {
      if (operation.current === own) { running.current = false; setPhase(null); }
    }
  };

  const applyInspection = (next: PreparedRuntimeConnection) => {
    setPrepared(next);
    setModel(next.models.length === 1 ? next.models[0].id : '');
  };
  const search = (chooseFolder = false) => execute('finding', async current => {
    let folder: string | undefined;
    if (chooseFolder) {
      const path = await pickRuntimePath('folder');
      if (!path || !current()) return;
      folder = path;
    }
    const found = await runtimeAutoDiscover(folder);
    if (!current()) return;
    setCandidates(found.candidates); setWarnings(found.warnings); setTruncated(found.truncated);
    setSearched(true); setSelected(''); setPrepared(null); setModel('');
    if (found.candidates.length === 1) {
      const candidate = found.candidates[0];
      activePhase.current = 'inspecting';
      setSelected(candidate.id); setPhase('inspecting');
      const next = await runtimeAutoInspect(candidate);
      if (current()) applyInspection(next);
    }
  });
  const inspect = (candidate: RuntimeCandidate) => execute('inspecting', async current => {
    setSelected(candidate.id); setPrepared(null); setModel('');
    const next = await runtimeAutoInspect(candidate);
    if (current()) applyInspection(next);
  });
  const chooseCandidate = (candidate: RuntimeCandidate) => {
    if (locked || running.current) return;
    setSelected(candidate.id); setPrepared(null); setModel('');
    setError(null); setCancelled(false); setResult(null);
  };
  const connect = () => {
    if (!prepared || !model || !prepared.models.some(item => item.id === model)) return;
    const connection = prepared;
    const selectedModel = model;
    return execute('connecting', async current => {
      const connected = await runtimeAutoConnect(connection, selectedModel);
      if (!current()) return;
      setResult(connected);
      callbacks.current.onConnected(connected);
    });
  };
  const disabled = locked || phase !== null;
  const selectedCandidate = candidates.find(candidate => candidate.id === selected);
  // The visible journey: find → inspect a candidate → choose a model → verify.
  // Verification is complete only once runtimeAutoConnect itself succeeded.
  const displayedPhase = phase ?? error?.phase;
  const stage = result ? 4
    : displayedPhase === 'finding' ? 0
      : displayedPhase === 'inspecting' ? 1
        : displayedPhase === 'connecting' ? 3
          : prepared ? (model ? 3 : 2)
            : candidates.length > 0 ? 1 : 0;
  const steps = [copy.stepFind, copy.stepCheck, copy.stepModel, copy.stepVerify];

  return <section className="app-card runtime-auto" aria-labelledby={`${id}-title`}>
    <div className="runtime-auto__header">
      <h2 ref={titleRef} id={`${id}-title`} tabIndex={-1} className="app-section-title">{copy.title}</h2>
      <p className="app-section-hint">{copy.intro}</p>
    </div>
    <ol className="runtime-auto-steps" aria-label={copy.progress}>
      {steps.map((label, index) => {
        const state = index < stage ? 'done' : index === stage ? (error ? 'failed' : 'current') : 'pending';
        return <li key={label} data-state={state} aria-current={index === stage ? 'step' : undefined}>
          <span className="runtime-auto-steps__index" aria-hidden="true">{state === 'done' ? <DoneIcon /> : index + 1}</span>
          <span className="runtime-auto-steps__label">{label}</span>
          {state === 'done' && <span className="sr-only"> · {copy.stepDone}</span>}
        </li>;
      })}
    </ol>
    {phase !== null && <p role="status" aria-live="polite" className="runtime-auto-status">{copy[phase]}</p>}

    <div className="runtime-auto-stage">
      <div className="app-page-actions">
        <button type="button" className={`app-button ${stage === 0 ? 'app-button--primary' : 'app-button--secondary'}`} disabled={disabled} onClick={() => void search()}>{result ? copy.selectAgain : copy.find}</button>
        <button type="button" className="app-button app-button--secondary" disabled={disabled} onClick={() => void search(true)}>{copy.folder}</button>
        {phase !== null && <LocalTaskCancelButton taskId={taskId} onClick={cancel}>{copy.cancel}</LocalTaskCancelButton>}
      </div>
      <p className="app-section-hint">{copy.folderHint}</p>
      {searched && candidates.length === 0 && <FeedbackBanner tone="info">{copy.empty}</FeedbackBanner>}
      {truncated && <FeedbackBanner tone="warning">{copy.limited}</FeedbackBanner>}
      {warnings.length > 0 && <DiagnosticDetails summary={summarizeDiagnostic(warnings.join('\n'))} detail={warnings.join('\n')} />}
    </div>

    {candidates.length > 0 && <fieldset disabled={disabled} className="runtime-auto-stage runtime-auto-candidates">
      <legend className="runtime-auto-stage__title">{copy.candidates}</legend>
      <p className="app-section-hint">{copy.candidateHint}</p>
      <div className="runtime-auto-candidate-list">
        {candidates.map(candidate => <label key={candidate.id} className="runtime-auto-candidate">
          <input type="radio" name={`${id}-candidate`} value={candidate.id} checked={selected === candidate.id}
            onChange={() => chooseCandidate(candidate)} />
          <span className="runtime-auto-candidate__text">
            <span className="runtime-auto-candidate__name">{normalizeDisplayText(candidate.display_name)}</span>
            <small>{candidate.source === 'local_process' ? copy.running : copy.installation}{candidate.pid != null && ` · ${copy.process} ${candidate.pid}`}</small>
            {candidate.entrypoint_path && <small className="runtime-auto-candidate__path">{normalizeDisplayText(candidate.entrypoint_path)}</small>}
            {candidate.endpoints.length > 0 && <small>{candidate.endpoints.map(endpoint => `${endpoint.host.includes(':') ? `[${endpoint.host}]` : endpoint.host}:${endpoint.port}`).join(', ')}</small>}
          </span>
        </label>)}
      </div>
      <div className="app-page-actions">
        <button type="button" className={`app-button ${stage === 1 ? 'app-button--primary' : 'app-button--secondary'}`} disabled={!selectedCandidate || result !== null} onClick={() => { if (selectedCandidate) void inspect(selectedCandidate); }}>{copy.check}</button>
      </div>
    </fieldset>}

    {prepared && <form action="#" method="POST" className="runtime-auto-stage runtime-auto-connect" onSubmit={event => { event.preventDefault(); void connect(); }}>
      <p>{prepared.kind === 'attached' ? copy.attached : copy.managed}</p>
      <div className="runtime-auto-field">
        <label htmlFor={`${id}-model`}>{copy.model}</label>
        <CustomSelect id={`${id}-model`} value={model} disabled={disabled || prepared.models.length === 0}
          options={[{ value: '', label: copy.chooseModel }, ...prepared.models.map(item => ({ value: item.id, label: item.name }))]}
          onChange={setModel} />
      </div>
      {prepared.models.length === 0 && <FeedbackBanner tone="warning">{copy.noModels}</FeedbackBanner>}
      <p className="app-section-hint">{copy.limits}</p>
      <div className="app-page-actions">
        <button type="submit" className="app-button app-button--primary" disabled={disabled || !model || result !== null}>{copy.connect}</button>
      </div>
    </form>}
    {error && <FeedbackBanner tone="error" title={copy.failure}>
      <p>{copy.retryHint}</p><DiagnosticDetails summary={summarizeDiagnostic(error.message)} detail={error.message} />
    </FeedbackBanner>}
    {cancelled && <FeedbackBanner tone="info">{copy.cancelled}</FeedbackBanner>}
    {result && <FeedbackBanner tone="success" title={copy.ready}>
      <p>{copy.saved}</p>
      <p>{result.mode === 'attached' ? copy.attached : copy.managed}</p>
      <p>{copy.limits}</p>
      {result.checks.length > 0 && <details><summary>{copy.details}</summary><ul>{result.checks.map((check, index) => <li key={index}>{normalizeDisplayText(check)}</li>)}</ul></details>}
    </FeedbackBanner>}
  </section>;
}
