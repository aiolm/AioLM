import { useId, useState } from 'react';
import {
  runtimeHelpCached,
  runtimeHelpCancelOwner,
  runtimeHelpDiscover,
  type HelpCommand,
  type OptionSchema,
  type RuntimeDescriptor,
} from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { helpDiscoveryCopy } from '../../shared/i18n/helpDiscoveryCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';

/** Executable/entry-point help journey: discover once, review diff, then register. */
export default function HelpDiscoveryPanel({ locked }: { locked: boolean }) {
  const { locale } = useI18n();
  const copy = helpDiscoveryCopy[locale];
  const owner = useId();
  const [engine, setEngine] = useState('custom.example');
  const [runtime, setRuntime] = useState('build-1');
  const [program, setProgram] = useState('');
  const [helpArgs, setHelpArgs] = useState('--help');
  const [workingDir, setWorkingDir] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [descriptor, setDescriptor] = useState<RuntimeDescriptor | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [scope, setScope] = useState<string[]>([]);
  const taskId = `runtime-help-discovery-${owner}`;

  const commandFor = (): HelpCommand => ({
    program,
    args: helpArgs.split(/\s+/).filter(Boolean),
    environment: { LC_ALL: 'C' },
    working_directory: workingDir.trim() ? workingDir.trim() : null,
    artifacts: [],
    runtime_version: 'manual-entry',
    scope,
    encoding: 'auto',
    timeout_ms: 30000,
    output_limit: 65536,
  });

  const discover = async (cachedOnly = false) => {
    if (locked || busy || !program.trim()) return;
    setBusy(true);
    setError('');
    registerTask({ id: taskId, kind: 'runtime', label: copy.title, interruptible: true, cancel: () => void runtimeHelpCancelOwner(owner) });
    try {
      if (cachedOnly) {
        setError(copy.explicit);
        return;
      }
      const savedKeys = Object.keys(values);
      const [, described] = await runtimeHelpDiscover(owner, engine.trim(), runtime.trim(), commandFor(), savedKeys);
      setDescriptor(described);
      // Refresh the cached snapshot path without spawning a second child.
      await runtimeHelpCached(engine.trim(), runtime.trim(), described.fingerprint).catch(() => null);
      finishTask(taskId, 'completed');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message !== 'help discovery cancelled') setError(message);
      finishTask(taskId, message === 'help discovery cancelled' ? 'cancelled' : 'failed', message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    updateTask(taskId, { state: 'cancelling' });
    try {
      await runtimeHelpCancelOwner(owner);
    } catch (cause) {
      setError(String(cause));
    }
  };

  const schema: OptionSchema | null = descriptor?.schema ?? null;

  return (
    <section className="app-card app-card--tight mb-4" aria-label={copy.title}>
      <h3 className="app-section-title">{copy.title}</h3>
      <p className="app-section-hint">{copy.hint}</p>
      <div className="model-settings-fields">
        <label htmlFor={`${owner}-engine`}>
          {copy.engine}
          <input id={`${owner}-engine`} name="engine" className="app-input" value={engine} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setEngine(event.target.value)} />
        </label>
        <label htmlFor={`${owner}-runtime`}>
          {copy.runtime}
          <input id={`${owner}-runtime`} name="runtime" className="app-input" value={runtime} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setRuntime(event.target.value)} />
        </label>
        <label htmlFor={`${owner}-program`}>
          {copy.program}
          <input id={`${owner}-program`} name="program" className="app-input" value={program} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} placeholder={copy.programPlaceholder} onChange={event => setProgram(event.target.value)} />
        </label>
        <label htmlFor={`${owner}-args`}>
          {copy.args}
          <input id={`${owner}-args`} name="help-args" className="app-input" value={helpArgs} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setHelpArgs(event.target.value)} />
        </label>
        <label htmlFor={`${owner}-cwd`}>
          {copy.workingDir}
          <input id={`${owner}-cwd`} name="working-directory" className="app-input" value={workingDir} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setWorkingDir(event.target.value)} />
        </label>
      </div>
      <div className="app-page-actions mt-3">
        <button type="button" className="app-button app-button--primary" disabled={busy || locked || !program.trim()} onClick={() => void discover()}>
          {copy.discover}
        </button>
        {busy && (
          <LocalTaskCancelButton taskId={taskId} onClick={() => void cancel()} className="app-button app-button--danger">
            {copy.cancel}
          </LocalTaskCancelButton>
        )}
      </div>
      {locked && !busy && <p>{copy.locked}</p>}
      {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
      {descriptor && (
        <div className="mt-3">
          <p role="status">
            {copy.fingerprint}: {descriptor.fingerprint.slice(0, 12)}… · {descriptor.help_complete ? copy.complete : copy.incomplete}
          </p>
          {descriptor.diff && (
            <ul>
              {descriptor.diff.added.length > 0 && <li>{copy.added}: {descriptor.diff.added.join(', ')}</li>}
              {descriptor.diff.removed.length > 0 && <li>{copy.removed}: {descriptor.diff.removed.join(', ')}</li>}
              {descriptor.diff.changed.length > 0 && <li>{copy.changed}: {descriptor.diff.changed.join(', ')}</li>}
            </ul>
          )}
          {descriptor.retained.length > 0 && (
            <FeedbackBanner tone="warning">{copy.retained}: {descriptor.retained.join(', ')}</FeedbackBanner>
          )}
          <p className="app-section-hint">{copy.ready}</p>
        </div>
      )}
      {schema && (
        <RuntimeOptionSchemaForm schema={schema} values={values} scope={scope} disabled={busy || locked} onChange={setValues} />
      )}
      {schema && (
        <label>
          {copy.scope}
          <input className="app-input" value={scope.join(' ')} disabled={busy || locked} autoCorrect="off" autoCapitalize="off" spellCheck={false} onChange={event => setScope(event.target.value.split(/\s+/).filter(Boolean))} />
        </label>
      )}
    </section>
  );
}
