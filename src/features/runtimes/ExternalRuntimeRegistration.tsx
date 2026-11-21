import { runtimeAdapterCopy } from '../../shared/i18n/runtimeAdapterCopy';
import { useEffect, useId, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { errorMessage } from '../../shared/api/errors';
import { useI18n } from '../../shared/i18n/i18n';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';
import { isIpcErrorKind } from '../../shared/api/ipcError';

/** Selecting a manifest registers external files; it never installs or removes them. */
export default function ExternalRuntimeRegistration({ locked, onRegistered, onBusyChange }: { locked: boolean; onRegistered: (provider: api.ProviderId, registered: { runtime_id: string; display_name: string }) => void; onBusyChange: (busy: boolean) => void }) {
  const { locale, t } = useI18n();
  const copy = runtimeAdapterCopy[locale];
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const operation = useRef<{ cancelled: boolean } | null>(null);
  const mounted = useRef(true);
  const pickerGeneration = useRef(0);
  const taskId = 'runtime-adapter-registration';
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pickerGeneration.current += 1;
      if (operation.current) {
        operation.current.cancelled = true;
        operation.current = null;
        void api.rtCancel().catch(() => undefined);
        finishTask(taskId, 'cancelled');
        onBusyChange(false);
      }
    };
  }, [onBusyChange]);
  const cancel = async (owner = operation.current) => {
    if (!owner || operation.current !== owner || owner.cancelled) return;
    owner.cancelled = true; updateTask(taskId, { state: 'cancelling' });
    try { await api.rtCancel(); }
    catch (cause) { if (mounted.current && operation.current === owner) { owner.cancelled = false; setError(errorMessage(cause)); updateTask(taskId, { state: 'running' }); } }
  };
  const register = async () => {
    if (locked || operation.current || !path.trim()) return;
    const owner = { cancelled: false }; operation.current = owner;
    setBusy(true); onBusyChange(true); setError(''); setResult('');
    registerTask({ id: taskId, kind: 'runtime', label: copy.title, interruptible: true, cancel: () => cancel(owner) });
    try {
      const registered = await api.runtimeAdapterRegister(path.trim());
      if (!mounted.current || operation.current !== owner) return;
      notifyRuntimeInventoryChanged();
      onRegistered(registered.engine_id, registered);
      setResult(`${registered.display_name} · ${registered.runtime_id}`);
      finishTask(taskId, 'completed');
      try { await api.providerCatalog(true); }
      catch (cause) { if (mounted.current) setError(`${copy.refreshError} ${errorMessage(cause)}`); }
    } catch (cause) {
      if (!mounted.current || operation.current !== owner) return;
      const message = errorMessage(cause);
      const cancelled = isIpcErrorKind(cause, 'cancelled');
      if (!cancelled) setError(message);
      finishTask(taskId, cancelled ? 'cancelled' : 'failed', message);
    } finally {
      if (operation.current === owner) operation.current = null;
      if (mounted.current) { setBusy(false); onBusyChange(false); }
    }
  };
  const id = useId();
  return <section className="app-card runtime-manifest" aria-labelledby={`${id}-title`}>
    <h3 id={`${id}-title`} className="app-section-title">{copy.title}</h3>
    <p className="app-section-hint">{copy.hint}</p>
    <div className="entrypoint-field">
      <label htmlFor={`${id}-path`}>{copy.path}</label>
      <span className="entrypoint-path">
        <input id={`${id}-path`} className="app-input" value={path} onChange={event => { pickerGeneration.current += 1; setPath(event.target.value); }} disabled={busy || locked}
          autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} />
        <button type="button" className="app-button app-button--secondary" disabled={busy || locked} onClick={() => {
          const generation = ++pickerGeneration.current;
          void api.pickRuntimeAdapter().then(value => {
            if (!mounted.current || busy || locked || pickerGeneration.current !== generation || !value) return;
            setPath(value);
          }).catch(cause => { if (mounted.current && pickerGeneration.current === generation) setError(errorMessage(cause)); });
        }}>{copy.file}</button>
      </span>
    </div>
    <div className="app-page-actions">
      <button type="button" className="app-button app-button--primary" disabled={busy || locked || !path.trim()} onClick={() => void register()}>{copy.register}</button>
      {busy && <LocalTaskCancelButton taskId={taskId} onClick={() => void cancel()} className="app-button app-button--danger">{t('common.cancel')}</LocalTaskCancelButton>}
    </div>
    {locked && !busy && <p className="app-section-hint">{copy.locked}</p>}
    {result && <p role="status">{result}</p>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </section>;
}
