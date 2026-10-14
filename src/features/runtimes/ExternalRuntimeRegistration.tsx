import { runtimeAdapterCopy } from '../../shared/i18n/runtimeAdapterCopy';
import { useRef, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';

/** Selecting a manifest registers external files; it never installs or removes them. */
export default function ExternalRuntimeRegistration({ locked, onRegistered, onBusyChange }: { locked: boolean; onRegistered: (provider: api.ProviderId) => void; onBusyChange: (busy: boolean) => void }) {
  const { locale, t } = useI18n();
  const copy = runtimeAdapterCopy[locale];
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const operation = useRef<{ cancelled: boolean } | null>(null);
  const taskId = 'runtime-adapter-registration';
  const cancel = async (owner = operation.current) => {
    if (!owner || operation.current !== owner || owner.cancelled) return;
    owner.cancelled = true; updateTask(taskId, { state: 'cancelling' });
    try { await api.rtCancel(); }
    catch (cause) { if (operation.current === owner) { owner.cancelled = false; setError(String(cause)); updateTask(taskId, { state: 'running' }); } }
  };
  const register = async () => {
    if (locked || operation.current || !path.trim()) return;
    const owner = { cancelled: false }; operation.current = owner;
    setBusy(true); onBusyChange(true); setError(''); setResult('');
    registerTask({ id: taskId, kind: 'runtime', label: copy.title, interruptible: true, cancel: () => cancel(owner) });
    try {
      const registered = await api.runtimeAdapterRegister(path.trim());
      notifyRuntimeInventoryChanged();
      onRegistered(registered.engine_id);
      setResult(`${registered.display_name} · ${registered.runtime_id}`);
      finishTask(taskId, 'completed');
      try { await api.providerCatalog(true); }
      catch (cause) { setError(`${copy.refreshError} ${String(cause)}`); }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = message === 'runtime probe cancelled';
      if (!cancelled) setError(message);
      finishTask(taskId, cancelled ? 'cancelled' : 'failed', message);
    } finally { operation.current = null; setBusy(false); onBusyChange(false); }
  };
  return <section className="app-card app-card--tight mb-4">
    <h3 className="app-section-title">{copy.title}</h3>
    <p className="app-section-hint">{copy.hint}</p>
    <label>{copy.path}<input className="app-input" value={path} onChange={event => setPath(event.target.value)} disabled={busy || locked} /></label>
    <div className="app-page-actions mt-3">
      <button type="button" className="app-button app-button--secondary" disabled={busy || locked} onClick={() => void api.pickRuntimeAdapter().then(value => { if (value) setPath(value); }).catch(cause => setError(String(cause)))}>{copy.file}</button>
      <button type="button" className="app-button app-button--primary" disabled={busy || locked || !path.trim()} onClick={() => void register()}>{copy.register}</button>
      {busy && <LocalTaskCancelButton taskId={taskId} onClick={() => void cancel()} className="app-button app-button--danger">{t('common.cancel')}</LocalTaskCancelButton>}
    </div>
    {locked && !busy && <p>{copy.locked}</p>}
    {result && <p role="status">{result}</p>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </section>;
}
