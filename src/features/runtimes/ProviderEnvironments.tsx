import { useEffect, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import Badge from '../../shared/ui/Badge';
import { providerDisplayName } from '../../shared/api/providers';

const TASK_ID = 'provider-environment-operation';

export default function ProviderEnvironments({ active, provider: selectedProvider, revision: refreshRevision = 0, onBusyChange }: { active: boolean; provider?: api.ProviderId; revision?: number; onBusyChange?: (busy: boolean) => void }) {
  const { locale, t } = useI18n(); const copy = providerCopy[locale];
  const [catalog, setCatalog] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [python, setPython] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const operationLock = useRef(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState(''); const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    void Promise.all([api.providerCatalog(), api.providerRuntimes()]).then(([catalog, runtimes]) => { if (current) { setCatalog(catalog); setRuntimes(runtimes); } }).catch(cause => { if (current) setError(String(cause)); });
    return () => { current = false; };
  }, [active, revision, refreshRevision]);
  useEffect(() => { onBusyChange?.(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if ((!active && !busy) || !api.isNativeRuntimeAvailable()) return;
    let closed = false; let unlisten: (() => void) | undefined;
    void import('@tauri-apps/api/event').then(({ listen }) => listen<{ phase: string; line: string }>('provider-install-progress', event => {
      if (closed || !operationLock.current) return;
      setProgress(`${event.payload.phase}: ${event.payload.line}`);
      updateTask(TASK_ID, { phase: event.payload.phase, detail: event.payload.line });
    })).then(stop => { if (closed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { closed = true; unlisten?.(); };
  }, [active, busy]);
  const run = async (label: string, operation: () => Promise<unknown>, installs = false) => {
    if (operationLock.current) return; operationLock.current = true;
    setBusy(true); setInstalling(installs); setError(''); setProgress(''); setResult('');
    registerTask({ id: TASK_ID, kind: 'runtime', label, interruptible: true,
      ...(installs ? { cancel: api.rtCancel, notifyOnComplete: 'download' as const } : {}) });
    try { await operation(); setRevision(value => value + 1); finishTask(TASK_ID, 'completed'); }
    catch (cause) { const message = String(cause); setError(message); finishTask(TASK_ID, /cancel/i.test(message) ? 'cancelled' : 'failed', message); }
    finally { operationLock.current = false; setBusy(false); setInstalling(false); }
  };
  const runPortableExport = (providerId: api.ProviderId, runtimeId: string, label: string) =>
    void run(label, async () => {
      const info = await api.providerPortableExport(providerId, runtimeId);
      setResult(`${t('ui.exportProviderRuntimeBundle')} · ${info.wheels}: ${info.path} · SHA-256 ${info.archive_sha256}`);
    }, true);
  const runPortableImport = (label: string) =>
    void run(label, async () => {
      const imported = await api.providerPortableImport();
      setResult(`${t('ui.importProviderRuntimeBundle')} · ${providerDisplayName(imported.provider)} · ${imported.id}`);
    }, true);
  return <section className="app-card app-card--tight">
    <h3 className="app-section-title">{copy.environment}</h3>
    <label>{copy.python}<input className="app-input" value={python} onChange={event => setPython(event.target.value)} disabled={busy} /></label>
    {catalog.filter(provider => provider.id !== 'llama.cpp' && (!selectedProvider || provider.id === selectedProvider)).map(provider => <div key={provider.id} className="app-card app-card--tight">
      <h4>{providerDisplayName(provider.id)} · {provider.managed_variant ?? provider.server}</h4>
      {provider.managed_variant === 'vllm-metal' && provider.availability.supported && <p>{provider.availability.detail}</p>}
      {!provider.availability.supported && <p>{copy.unsupported} {provider.availability.detail}</p>}
      <button type="button" className="app-button app-button--secondary" disabled={busy || !provider.availability.supported} onClick={() => void run(`${provider.engine} · ${copy.install}`, () => api.providerInstall(provider.id, python.trim() || undefined), true)}>{copy.install} {provider.managed_version}</button>
      <button type="button" className="app-button app-button--secondary" disabled={busy || !python.trim() || !provider.availability.supported} onClick={() => void run(`${provider.engine} · ${copy.register}`, () => api.providerRegister(provider.id, python.trim()))}>{copy.register}</button>
      <div className="provider-runtime-list" aria-label={`${providerDisplayName(provider.id)} · ${copy.runtime}`}>
      {runtimes.filter(runtime => runtime.provider === provider.id).map(runtime => <div key={runtime.id} className="app-list-row provider-runtime-row"><span><strong>{api.runtimeLabel(runtime)}</strong><Badge tone={runtime.available ? 'info' : 'warning'}>{runtime.available ? copy.ready : copy.notReady}</Badge><small>{runtime.problems.join('; ')}</small></span><div className="app-page-actions"><button type="button" className="app-button app-button--secondary" disabled={busy} onClick={() => runPortableExport(provider.id, runtime.id, `${provider.engine} · ${t('ui.exportProviderRuntimeBundle')}`)}>{t('ui.exportProviderRuntimeBundle')}</button><button type="button" className="app-button app-button--danger" disabled={busy} onClick={() => void run(`${provider.engine} · ${copy.remove}`, () => api.providerRemove(provider.id, runtime.id))}>{copy.remove}</button></div></div>)}
      {!runtimes.some(runtime => runtime.provider === provider.id) && <p className="app-section-hint">{copy.noRuntimes}</p>}
      </div>
    </div>)}
    <div className="app-card app-card--tight">
      <h4>{t('ui.importProviderRuntimeBundle')}</h4>
      <button type="button" className="app-button app-button--primary" disabled={busy} onClick={() => runPortableImport(t('ui.importProviderRuntimeBundle'))}>{t('ui.importProviderRuntimeBundle')}</button>
    </div>
    {installing && <LocalTaskCancelButton taskId={TASK_ID} onClick={() => void api.rtCancel().catch(cause => setError(String(cause)))} className="app-button app-button--danger">{t('common.cancel')}</LocalTaskCancelButton>}
    {progress && <pre role="status" className="whitespace-pre-wrap">{progress}</pre>}{result && <p role="status" data-testid="portable-result">{result}</p>}{error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </section>;
}
