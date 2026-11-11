import { runtimeAdapterCopy } from '../../shared/i18n/runtimeAdapterCopy';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import * as api from '../../shared/api';
import { useI18n } from '../../shared/i18n/i18n';
import { providerCopy } from '../../shared/i18n/providerCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { finishTask, registerTask, updateTask } from '../../shared/state/taskRegistry';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import Badge from '../../shared/ui/Badge';
import { providerDisplayName, isExternalProvider } from '../../shared/api/providers';
import { notifyRuntimeInventoryChanged } from '../../shared/runtime/runtimeInventoryEvents';
import { buildPhaseLabelKey } from '../../shared/runtime/runtimeUtils';
import { adapterCatalogCopy } from '../../shared/i18n/adapterCatalogCopy';
import { runtimeInstanceLabel } from '../../shared/i18n/runtimeInstanceText';
import { shouldConfirmDestructive } from '../../shared/config/preferences';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import { providerRuntimeReferences } from './runtimeReferences';
import { RuntimeRemovalTargets } from './RuntimeRemovalNotice';
import { normalizeDisplayText } from '../../shared/lib/displayPaths';
import { runtimeAutoCopy } from '../../shared/i18n/runtimeAutoCopy';

const TASK_ID = 'provider-environment-operation';
const CANCELLATION_MESSAGES = new Set([
  'runtime installation cancelled',
  'runtime probe cancelled',
  'portable runtime export cancelled',
  'portable runtime import cancelled',
  'portable runtime operation cancelled',
]);

export default function ProviderEnvironments({ active, provider: selectedProvider, revision: refreshRevision = 0, cfg, resourcesInUse = false, operationBusy = false, onBusyChange }: { active: boolean; provider?: api.ProviderId; revision?: number; cfg?: api.AppConfig | null; resourcesInUse?: boolean; operationBusy?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const { locale, t } = useI18n(); const copy = providerCopy[locale];
  const [catalog, setCatalog] = useState<api.ProviderDescription[]>([]);
  const [runtimes, setRuntimes] = useState<api.RuntimeInstance[]>([]);
  const [python, setPython] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [pendingRemoval, setPendingRemoval] = useState<api.RuntimeInstance | null>(null);
  const removalCopy = runtimeAdapterCopy[locale];
  const removalReferences = pendingRemoval ? providerRuntimeReferences(cfg, pendingRemoval.provider, pendingRemoval.id) : [];
  const lockReason = resourcesInUse ? t('ui.stopSessionsBeforeRuntime') : operationBusy ? runtimeAutoCopy[locale].operationLocked : undefined;
  const blocked = resourcesInUse || operationBusy;
  const operationLock = useRef<{ cancelRequested: boolean } | null>(null);
  const [cancellable, setCancellable] = useState(false);
  const [progress, setProgress] = useState(''); const [revision, setRevision] = useState(0);
  const runtimesByProvider = useMemo(() => {
    const grouped = new Map<string, api.RuntimeInstance[]>();
    for (const runtime of runtimes) {
      const owned = grouped.get(runtime.provider);
      if (owned) owned.push(runtime);
      else grouped.set(runtime.provider, [runtime]);
    }
    return grouped;
  }, [runtimes]);
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
      const phase = t(`ui.${buildPhaseLabelKey(event.payload.phase)}`);
      setProgress(`${phase}: ${event.payload.line}`);
      updateTask(TASK_ID, { phase, detail: event.payload.line });
    })).then(stop => { if (closed) stop(); else unlisten = stop; }).catch(cause => setError(String(cause)));
    return () => { closed = true; unlisten?.(); };
  }, [active, busy, t]);
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
    if (operationLock.current || blocked) return;
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
  const removeRuntime = (runtime: api.RuntimeInstance) => run(`${providerDisplayName(runtime.provider)} · ${copy.remove}`, async () => {
    try { await api.providerRemove(runtime.provider, runtime.id); }
    finally { setPendingRemoval(null); }
  }, { inventory: true });
  const requestRemoval = (runtime: api.RuntimeInstance) => {
    if (operationLock.current || blocked) return;
    if (shouldConfirmDestructive()) setPendingRemoval(runtime);
    else void removeRuntime(runtime);
  };
  const headingId = useId();
  const managed = !selectedProvider || !isExternalProvider(selectedProvider);
  return <section className="app-card provider-env" aria-labelledby={headingId}>
    <h3 id={headingId} className="app-section-title">{copy.environment}</h3>
    {lockReason && <FeedbackBanner tone="info">{lockReason}</FeedbackBanner>}
    {managed && <label className="provider-env__field"><span>{copy.python}</span><input className="app-input" value={python} onChange={event => setPython(event.target.value)} disabled={busy} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} /></label>}
    {catalog.filter(provider => provider.id !== 'llama.cpp' && (!selectedProvider || provider.id === selectedProvider)).map(provider => {
      const providerRuntimes = runtimesByProvider.get(provider.id) ?? [];
      const external = isExternalProvider(provider.id);
      return <div key={provider.id} className="provider-env__provider">
      <div className="provider-env__provider-header">
        <div className="provider-env__identity">
          <h4 className="provider-env__name">{providerDisplayName(provider.id)} · {provider.managed_variant ?? provider.server}</h4>
          {provider.managed_variant === 'vllm-metal' && provider.availability.supported && <p className="app-section-hint">{provider.availability.detail}</p>}
          {!provider.availability.supported && <p className="provider-env__unsupported">{copy.unsupported} {provider.availability.detail}</p>}
          {external && <p className="app-section-hint">{runtimeAdapterCopy[locale].capabilities}</p>}
        </div>
        {!external && <div className="app-page-actions">
          <button type="button" className="app-button app-button--primary" disabled={busy || blocked || !provider.availability.supported} title={lockReason} onClick={() => void run(`${provider.engine} · ${copy.install}`, () => api.providerInstall(provider.id, python.trim() || undefined), { cancellable: true, notifyDownload: true, inventory: true })}>{copy.install}{provider.availability.supported && provider.managed_version ? ` ${provider.managed_version}` : ''}</button>
          <button type="button" className="app-button app-button--secondary" disabled={busy || blocked || !python.trim() || !provider.availability.supported} title={lockReason} onClick={() => void run(`${provider.engine} · ${copy.register}`, () => api.providerRegister(provider.id, python.trim()), { inventory: true })}>{copy.register}</button>
        </div>}
      </div>
      <div className="provider-runtime-list" role="group" aria-label={`${providerDisplayName(provider.id)} · ${copy.runtime}`}>
      {providerRuntimes.map(runtime => <div key={runtime.id} className="app-list-row provider-runtime-row">
        <span className="provider-runtime-row__identity">
          <strong>{runtimeInstanceLabel(runtime, locale)}</strong>
          <Badge tone={runtime.available ? 'info' : 'warning'}>{runtime.available ? (external ? adapterCatalogCopy[locale].runtimeFound : copy.ready) : copy.notReady}</Badge>
          {runtime.problems.length > 0 && <small>{runtime.problems.join('; ')}</small>}
        </span>
        <div className="app-page-actions">
          {!external && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || blocked} title={lockReason} onClick={() => runPortableExport(provider.id, runtime.id, `${provider.engine} · ${t('ui.exportProviderRuntimeBundle')}`)}>{t('ui.exportProviderRuntimeBundle')}</button>}
          <button type="button" className="app-button app-button--ghost app-button--danger app-button--sm" disabled={busy || blocked} title={lockReason} onClick={() => requestRemoval(runtime)}>{copy.remove}</button>
        </div>
      </div>)}
      {providerRuntimes.length === 0 && <p className="app-section-hint">{copy.noRuntimes}</p>}
      </div>
    </div>;
    })}
    {managed && <div className="app-page-actions provider-env__footer">
      <button type="button" className="app-button app-button--secondary" disabled={busy || blocked} title={lockReason} onClick={() => runPortableImport(t('ui.importProviderRuntimeBundle'))}>{t('ui.importProviderRuntimeBundle')}</button>
    </div>}
    {(cancellable || progress || result) && <div className="provider-env__status">
      {progress && <pre role="status" className="provider-env__progress">{progress}</pre>}
      {result && <p role="status" data-testid="portable-result" className="provider-env__result">{result}</p>}
      {cancellable && <LocalTaskCancelButton taskId={TASK_ID} onClick={() => void cancelOperation()} className="app-button app-button--danger">{t('common.cancel')}</LocalTaskCancelButton>}
    </div>}
    {error && <FeedbackBanner tone="error">{error}</FeedbackBanner>}
    <ConfirmDialog open={pendingRemoval !== null} title={t('ui.removeRuntimeTitle')} confirmLabel={copy.remove}
      busy={busy} confirmDisabled={blocked} onConfirm={() => { if (pendingRemoval) void removeRuntime(pendingRemoval); }}
      onCancel={() => { if (!busy) setPendingRemoval(null); }}
      description={pendingRemoval ? <div className="runtime-removal-notice">
        <p>{normalizeDisplayText(`${providerDisplayName(pendingRemoval.provider)} · ${runtimeInstanceLabel(pendingRemoval, locale)}`)}</p>
        <p>{pendingRemoval.installation === 'managed' ? removalCopy.removeManaged : removalCopy.removeExternal}</p>
        <p className="app-section-hint">{removalCopy.removeSavedSelections}</p>
        {removalReferences.length > 0 && <>
          <p className="app-section-hint">{removalCopy.removeAffected}</p>
          <RuntimeRemovalTargets t={t} references={removalReferences} />
        </>}
        {lockReason && <p>{lockReason}</p>}
      </div> : ''} />
  </section>;
}
