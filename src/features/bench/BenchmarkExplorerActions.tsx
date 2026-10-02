import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import { useI18n } from '../../shared/i18n/i18n';
import { isNativeRuntimeAvailable } from '../../shared/api/transport';
import { onBenchmarkProfileImport, openAiolmWebsite, openBenchmarkExplorer, readPublicBenchmark } from '../../shared/api/benchmarkExplorer';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import { profileLibrary } from '../model-settings/profileEditor';
import { benchmarkExplorerCopy } from './benchmarkExplorerCopy';
import { benchmarkSettingsProfile, publicBenchmarkProfileSource, localBenchmarkProfileSource, type BenchmarkProfileSource } from './benchmarkProfile';
import type { PerformanceBenchmarkRecord } from './performanceRecords';

export function useBenchmarkProfileImport(store: AppStore) {
  const { locale } = useI18n();
  const copy = benchmarkExplorerCopy(locale);
  const [notice, setNotice] = useState<{ error: boolean; text: string } | null>(null);
  const [importing, setImporting] = useState(false);
  const inFlight = useRef(false);
  const importProfile = useCallback(async (id: string, source: () => Promise<BenchmarkProfileSource>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setImporting(true);
    setNotice(null);
    try {
      const { profile, omitted } = benchmarkSettingsProfile(await source(), id);
      const saved = await store.updateConfig(current => {
        const library = profileLibrary(current);
        if (library.entries.some(entry => entry.id === profile.id)) return {};
        return { settings_profiles: { ...library, revision: library.revision + 1, entries: [...library.entries, profile] } };
      });
      const name = saved.settings_profiles?.entries.find(entry => entry.id === profile.id)?.name ?? profile.name;
      setNotice({ error: false, text: `${copy.saved} ${name} ${copy.importHint}${omitted ? ` ${copy.omitted}` : ''}` });
    } catch {
      setNotice({ error: true, text: copy.failed });
    } finally {
      inFlight.current = false;
      setImporting(false);
    }
  }, [store, copy]);
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
    }).catch(() => setNotice({ error: true, text: copy.openFailed }));
    return () => { disposed = true; unlisten?.(); };
  }, [copy.openFailed]);
  return { notice, importing, listenerReady, dismissNotice: () => setNotice(null),
    importLocal: (record: PerformanceBenchmarkRecord) => importProfile(`local-${record.id}`, async () => localBenchmarkProfileSource(record)) };
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
