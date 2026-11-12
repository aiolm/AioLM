import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import { useI18n } from '../../shared/i18n/i18n';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import { onBenchmarkProfileImport, openAiolmWebsite, openBenchmarkExplorer, readPublicBenchmark } from '../../shared/api/benchmarkExplorer';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { profileLibrary } from '../model-settings/profileEditor';
import { benchmarkExplorerCopy } from './benchmarkExplorerCopy';
import { benchmarkSettingsProfile, publicBenchmarkProfileSource, localBenchmarkProfileSource, type BenchmarkProfileSource } from './benchmarkProfile';
import { providerOf, type ProviderId } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';
import type { SettingsProfile } from '../../shared/config/settingsProfiles';
import { emptyGpuPlacement } from '../../shared/runtime/sessionUtils';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import { ProviderRuntimeControl } from '../model-settings/ProviderControls';
import { useProfileRuntimeSchema } from '../model-settings/useProfileRuntimeSchema';
import type { PerformanceBenchmarkRecord } from '../../shared/api/benchmarkHistory';

interface PendingImport {
  epoch: number;
  id: string;
  load: () => Promise<BenchmarkProfileSource>;
  source?: BenchmarkProfileSource;
  error?: string;
}

export function useBenchmarkProfileImport(store: AppStore) {
  const { locale } = useI18n();
  const copy = benchmarkExplorerCopy(locale);
  const { getConfig } = store;
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<PendingImport | null>(null);
  const [destination, setDestination] = useState<AppConfig>();
  const [ready, setReady] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const epoch = useRef(0);
  const savingLock = useRef(false);
  const checked = useProfileRuntimeSchema(destination, !!pending && ready === true);
  const [previewRevision, setPreviewRevision] = useState(0);
  const source = pending?.source;
  const effective = checked.view;
  const previewRequest = useRef<object | null>(null);
  const [preview, setPreview] = useState<{ source: BenchmarkProfileSource; destination: AppConfig; effective: NonNullable<typeof effective>; revision: number; profile?: SettingsProfile; omitted?: boolean; reused?: boolean; error?: string }>();
  const currentPreview = source && destination && effective && preview?.source === source
    && preview.destination === destination && preview.effective === effective && preview.revision === previewRevision ? preview : undefined;
  const loadSource = useCallback(async (request: PendingImport) => {
    try {
      const source = await request.load();
      if (epoch.current === request.epoch) setPending({ ...request, source });
    } catch (cause) {
      if (epoch.current === request.epoch) setPending({ ...request, error: String(cause) });
    }
  }, []);
  const importProfile = useCallback(async (id: string, load: PendingImport['load']) => {
    if (savingLock.current) return;
    const current = getConfig();
    if (!current) { setNotice({ error: true, text: copy.failed }); return; }
    const request = { epoch: ++epoch.current, id, load };
    // The current provider is only an initial destination tab. Even its runtime
    // must be explicitly selected; source identity never chooses an engine.
    setDestination({ ...current, active_runtime: '', active_backend: '', active_build: '',
      active_model: '', mmproj: '', spec_draft_model: '', provider_options: {},
      gpu: emptyGpuPlacement(), server_args: [], chat_options: {} });
    setPending(request); setReady(null); setSaveError(''); setNotice(null);
    await loadSource(request);
  }, [getConfig, copy.failed, loadSource]);
  useEffect(() => {
    if (!pending || !source || !destination || !effective || ready !== true
      || effective.help_state === 'stale' || effective.help_state === 'unchecked') return;
    const request = {};
    previewRequest.current = request;
    const owner = pending.epoch;
    void benchmarkSettingsProfile(source, pending.id, { cfg: destination, effective }).then(result => {
      if (epoch.current !== owner || previewRequest.current !== request) return;
      const provider = providerOf(destination);
      const existing = getConfig()?.settings_profiles?.entries.find(entry =>
        (entry.provider ?? 'llama.cpp') === provider && (entry.id === result.profile.id || entry.id === `profile-benchmark-${pending.id}`));
      setPreview({ source, destination, effective, revision: previewRevision, ...result,
        ...(existing ? { profile: existing, reused: true } : {}) });
    }).catch(cause => {
      if (epoch.current === owner && previewRequest.current === request) {
        setPreview({ source, destination, effective, revision: previewRevision, error: String(cause) });
      }
    });
    return () => { if (previewRequest.current === request) previewRequest.current = null; };
  }, [pending, source, destination, effective, ready, previewRevision, getConfig]);
  useEffect(() => () => { epoch.current++; previewRequest.current = null; }, []);
  const chooseProvider = useCallback((provider: ProviderId) => {
    if (savingLock.current) return;
    setDestination(current => current ? { ...current, active_provider: provider, active_runtime: '', active_backend: '', active_build: '' } : current);
    setSaveError('');
  }, []);
  const changeDestination = useCallback((patch: Partial<AppConfig>) => {
    if (savingLock.current) return;
    setDestination(current => current ? { ...current, ...patch } : current);
    setSaveError('');
  }, []);
  const cancel = () => {
    if (savingLock.current) return;
    epoch.current++; previewRequest.current = null; setPending(null); setDestination(undefined); setSaveError('');
  };
  const confirm = async () => {
    if (savingLock.current || !pending || !currentPreview?.profile || ready !== true || checked.pending || checked.error) return;
    const owner = pending.epoch;
    const id = pending.id;
    const profile = currentPreview.profile;
    const provider = profile.provider ?? 'llama.cpp';
    savingLock.current = true; setSaving(true); setSaveError('');
    try {
      let savedId = profile.id;
      const saved = await store.updateConfig(current => {
        if (epoch.current !== owner) return {};
        const library = profileLibrary(current);
        const existing = library.entries.find(entry => (entry.provider ?? 'llama.cpp') === provider
          && (entry.id === profile.id || entry.id === `profile-benchmark-${id}`));
        if (existing) { savedId = existing.id; return {}; }
        return { settings_profiles: { ...library, revision: library.revision + 1, entries: [...library.entries, profile] } };
      });
      if (epoch.current !== owner) return;
      const name = saved.settings_profiles?.entries.find(entry => entry.id === savedId)?.name ?? profile.name;
      setNotice({ error: false, text: `${copy.saved} ${name}${currentPreview.omitted ? ` ${copy.omitted}` : ''}` });
      setSaving(false); epoch.current++; setPending(null); setDestination(undefined);
    } catch (cause) {
      if (epoch.current === owner) setSaveError(`${copy.failed} ${String(cause)}`);
    } finally {
      savingLock.current = false;
      if (epoch.current === owner) setSaving(false);
    }
  };
  const handler = useRef(importProfile);
  useEffect(() => { handler.current = importProfile; }, [importProfile]);
  const [listenerReady, setListenerReady] = useState(false);
  useEffect(() => {
    if (!isNativeRuntimeAvailable()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onBenchmarkProfileImport(id => {
      if (disposed || !/^[A-Za-z0-9_-]{1,110}$/.test(id)) return;
      void handler.current(id, async () => publicBenchmarkProfileSource(await readPublicBenchmark(id), id));
    }).then(stop => {
      if (disposed) stop();
      else { unlisten = stop; setListenerReady(true); }
    }).catch(cause => { if (!disposed) setNotice({ error: true, text: `${copy.openFailed} ${String(cause)}` }); });
    return () => { disposed = true; unlisten?.(); };
  }, [copy.openFailed]);
  const noSettings = currentPreview?.profile && !Object.keys(currentPreview.profile.settings).length;
  const schemaUnchecked = effective?.help_state === 'stale' || effective?.help_state === 'unchecked';
  const importDialog = pending && destination ? <ConfirmDialog open tone="primary" title={copy.import}
    confirmLabel={noSettings ? copy.defaultConfirm : copy.confirm} busy={saving} scrollableDescription
    confirmDisabled={!currentPreview?.profile || ready !== true || checked.pending || !!checked.error || !!schemaUnchecked}
    onConfirm={() => void confirm()} onCancel={cancel} description={<>
      <p>{copy.importHint}</p>
      <section aria-label={copy.destination}>
        <ProviderRuntimeControl cfg={destination} disabled={saving} autoSelect={false} onProvider={chooseProvider} onChange={changeDestination} onReady={setReady} />
      </section>
      {!source && !pending.error && <p role="status">{copy.loading}</p>}
      {pending.error && <FeedbackBanner tone="error" action={{ label: copy.retry, disabled: saving, onClick: () => {
        if (savingLock.current) return;
        const request = { epoch: ++epoch.current, id: pending.id, load: pending.load };
        setPending(request); void loadSource(request);
      } }}>{pending.error}</FeedbackBanner>}
      {ready !== true && <p>{copy.selectRuntime}</p>}
      {source && ready === true && (checked.pending || !currentPreview && !checked.error && !schemaUnchecked) && <p role="status">{copy.checking}</p>}
      {(checked.error || schemaUnchecked) && <FeedbackBanner tone="error" action={{ label: copy.retry, disabled: saving || checked.pending, onClick: checked.retry }}>{checked.error || copy.unchecked}</FeedbackBanner>}
      {currentPreview?.error && <FeedbackBanner tone="error" action={{ label: copy.retry, disabled: saving, onClick: () => setPreviewRevision(value => value + 1) }}>{currentPreview.error}</FeedbackBanner>}
      {currentPreview?.profile && <section aria-label={copy.preview}>
        <h3>{copy.preview}</h3>
        {currentPreview.reused && <p>{copy.existing}</p>}
        {noSettings ? <FeedbackBanner tone="warning">{copy.noSettings}</FeedbackBanner>
          : <pre>{JSON.stringify(currentPreview.profile.settings, null, 2)}</pre>}
        {currentPreview.omitted && <FeedbackBanner tone="warning">{copy.omitted}</FeedbackBanner>}
      </section>}
      {saveError && <FeedbackBanner tone="error">{saveError}</FeedbackBanner>}
    </>} /> : null;
  return { notice, importing: !!pending, listenerReady, pendingSource: pending?.source ?? null, importDialog,
    dismissNotice: () => setNotice(null),
    importLocal: (record: PerformanceBenchmarkRecord) => {
      if (record.schemaVersion === 2 && !record.result.provenance) {
        setNotice({ error: true, text: copy.unavailableSettings });
        return;
      }
      return importProfile(`local-${record.id}`, async () => localBenchmarkProfileSource(record));
    } };
}

export default function BenchmarkExplorerActions({ listenerReady }: { listenerReady: boolean }) {
  const { locale } = useI18n();
  const copy = benchmarkExplorerCopy(locale);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState(false);
  const open = async (explorer: boolean) => {
    setOpening(true); setError(false);
    try {
      if (explorer) await openBenchmarkExplorer(locale, copy.import, copy.importHint);
      else await openAiolmWebsite(locale);
    } catch { setError(true); }
    finally { setOpening(false); }
  };
  return <section className="performance-explorer-actions">
    <div className="performance-target-actions">
      <button type="button" className="app-button app-button--secondary" disabled={opening || !listenerReady} onClick={() => void open(true)}>{copy.browse}</button>
      <button type="button" className="app-button app-button--secondary" disabled={opening} onClick={() => void open(false)}>{copy.website}</button>
    </div>
    <p className="performance-hint">{copy.browseHint}</p>
    {error && <FeedbackBanner tone="error">{copy.openFailed}</FeedbackBanner>}
  </section>;
}
