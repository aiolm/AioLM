import { runtimeAdapterCopy } from '../../shared/i18n/runtimeAdapterCopy';
import { useEffect, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import Badge from '../../shared/ui/Badge';
import { providerDisplayName, isExternalProvider } from '../../shared/api/providers';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';
import { adapterCatalogCopy } from '../../shared/i18n/adapterCatalogCopy';

const TASK_ID = 'provider-environment-operation';
const CANCELLATION_MESSAGES = new Set([
  'runtime installation cancelled',
  'runtime probe cancelled',
  'portable runtime export cancelled',
  'portable runtime import cancelled',
  'portable runtime operation cancelled',
]);

export default function ProviderEnvironments({ active, provider: selectedProvider, revision: refreshRevision = 0, resourcesInUse = false, onBusyChange }: { active: boolean; provider?: api.ProviderId; revision?: number; resourcesInUse?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { locale, t } = useI18n(); const copy = providerCopy[locale];
  const [catalog, setCatalog] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [python, setPython] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const lockReason = resourcesInUse ? t('ui.stopSessionsBeforeRuntime') : undefined;
  const operationLock = useRef<{ cancelRequested: boolean } | null>(null);
  const [cancellable, setCancellable] = useState(false);
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
  const cancelOperation = async (currentOperation = operationLock.current) => {
    if (!currentOperation || operationLock.current !== currentOperation || currentOperation.cancelRequested) return;
    currentOperation.cancelRequested = true;
    setError('');
    updateTask(TASK_ID, { state: 'cancelling', detail: undefined });
    try { await api.rtCancel(); }
    catch (cause) {
      if (operationLock.current !== currentOperation) return;
      const message = cause instanceof Error ? cause.message : String(cause);
      currentOperation.cancelRequested = false;
      updateTask(TASK_ID, { state: 'running', detail: message });
      setError(message);
    }
  };
  const run = async (label: string, operation: () => Promise<unknown>, options: { cancellable?: boolean; notifyDownload?: boolean; inventory?: boolean } = {}) => {
    if (operationLock.current || resourcesInUse) return;
    const currentOperation = { cancelRequested: false };
    operationLock.current = currentOperation;
    setBusy(true); setCancellable(options.cancellable ?? false); setError(''); setProgress(''); setResult('');
    registerTask({ id: TASK_ID, kind: 'runtime', label, interruptible: true,
      ...(options.cancellable ? { cancel: () => cancelOperation(currentOperation) } : {}),
      ...(options.notifyDownload ? { notifyOnComplete: 'download' as const } : {}) });
    try { await operation(); setRevision(value => value + 1); if (options.inventory) notifyRuntimeInventoryChanged(); finishTask(TASK_ID, 'completed'); }
    catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      const cancelled = CANCELLATION_MESSAGES.has(message);
      if (!cancelled) setError(message);
      finishTask(TASK_ID, cancelled ? 'cancelled' : 'failed', message);
    }
    finally { operationLock.current = null; setBusy(false); setCancellable(false); }
  };
  const runPortableExport = (providerId: api.ProviderId, runtimeId: string, label: string) =>
    void run(label, async () => {
      const info = await api.providerPortableExport(providerId, runtimeId);
      setResult(`${t('ui.exportProviderRuntimeBundle')} · ${info.wheels}: ${info.path} · SHA-256 ${info.archive_sha256}`);
    }, { cancellable: true });
  const runPortableImport = (label: string) =>
    void run(label, async () => {
      const imported = await api.providerPortableImport();
      setResult(`${t('ui.importProviderRuntimeBundle')} · ${providerDisplayName(imported.provider)} · ${imported.id}`);
    }, { cancellable: true, inventory: true });
  return <section className="app-card app-card--tight">
    {lockReason && <FeedbackBanner tone="info" className="mb-3">{lockReason}</FeedbackBanner>}
    <h3 className="app-section-title">{copy.environment}</h3>
    {(!selectedProvider || !isExternalProvider(selectedProvider)) && <label>{copy.python}<input className="app-input" value={python} onChange={event => setPython(event.target.value)} disabled={busy} /></label>}
    {catalog.filter(provider => provider.id !== 'llama.cpp' && (!selectedProvider || provider.id === selectedProvider)).map(provider => <div key={provider.id} className="app-card app-card--tight">
      <h4>{providerDisplayName(provider.id)} · {provider.managed_variant ?? provider.server}</h4>
      {provider.managed_variant === 'vllm-metal' && provider.availability.supported && <p>{provider.availability.detail}</p>}
      {!provider.availability.supported && <p>{copy.unsupported} {provider.availability.detail}</p>}
      {!isExternalProvider(provider.id) && <><button type="button" className="app-button app-button--secondary" disabled={busy || resourcesInUse || !provider.availability.supported} title={lockReason} onClick={() => void run(`${provider.engine} · ${copy.install}`, () => api.providerInstall(provider.id, python.trim() || undefined), { cancellable: true, notifyDownload: true, inventory: true })}>{copy.install} {provider.managed_version}</button>
      <button type="button" className="app-button app-button--secondary" disabled={busy || resourcesInUse || !python.trim() || !provider.availability.supported} title={lockReason} onClick={() => void run(`${provider.engine} · ${copy.register}`, () => api.providerRegister(provider.id, python.trim()), { inventory: true })}>{copy.register}</button></>}
      {isExternalProvider(provider.id) && <p className="app-section-hint">{runtimeAdapterCopy[locale].capabilities}</p>}
      <div className="provider-runtime-list" role="group" aria-label={`${providerDisplayName(provider.id)} · ${copy.runtime}`}>
      {runtimes.filter(runtime => runtime.provider === provider.id).map(runtime => <div key={runtime.id} className="app-list-row provider-runtime-row"><span><strong>{api.runtimeLabel(runtime)}</strong><Badge tone={runtime.available ? 'info' : 'warning'}>{runtime.available ? (isExternalProvider(provider.id) ? adapterCatalogCopy[locale].runtimeFound : copy.ready) : copy.notReady}</Badge><small>{runtime.problems.join('; ')}</small></span><div className="app-page-actions">{!isExternalProvider(provider.id) && <button type="button" className="app-button app-button--secondary" disabled={busy || resourcesInUse} title={lockReason} onClick={() => runPortableExport(provider.id, runtime.id, `${provider.engine} · ${t('ui.exportProviderRuntimeBundle')}`)}>{t('ui.exportProviderRuntimeBundle')}</button>}<button type="button" className="app-button app-button--danger" disabled={busy || resourcesInUse} title={lockReason} onClick={() => void run(`${provider.engine} · ${copy.remove}`, () => api.providerRemove(provider.id, runtime.id), { inventory: true })}>{copy.remove}</button></div></div>)}
      {!runtimes.some(runtime => runtime.provider === provider.id) && <p className="app-section-hint">{copy.noRuntimes}</p>}
      </div>
    </div>)}
    <div className="app-card app-card--tight">
      <h4>{t('ui.importProviderRuntimeBundle')}</h4>
      <button type="button" className="app-button app-button--primary" disabled={busy || resourcesInUse} title={lockReason} onClick={() => runPortableImport(t('ui.importProviderRuntimeBundle'))}>{t('ui.importProviderRuntimeBundle')}</button>
    </div>
    {cancellable && <LocalTaskCancelButton taskId={TASK_ID} onClick={() => void cancelOperation()} className="app-button app-button--danger">{t('common.cancel')}</LocalTaskCancelButton>}
    {progress && <pre role="status" className="whitespace-pre-wrap">{progress}</pre>}{result && <p role="status" data-testid="portable-result">{result}</p>}{error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
  </section>;
}
