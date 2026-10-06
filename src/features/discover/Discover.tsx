import ModelBadges from '../../shared/ui/ModelBadges';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { firstShard, formatBytes, formatSpeedBps, groupHfFiles, isMmprojPath, markInstalled, quantLabel, shardTotal, validateHfRepoId, type HfFileGroup } from "./discoverUtils";
import { MODEL_DOWNLOAD_TASK_ID, useModelDownload } from "../../shared/state/modelDownloadTask";
import { finishTask, getTaskSnapshot, registerTask, updateTask } from "../../shared/state/taskRegistry";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import Badge from "../../shared/ui/Badge";
import ProgressBar from "../../shared/ui/ProgressBar";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { useI18n } from "../../shared/i18n/i18n";
import { providerCopy } from '../../shared/i18n/providerCopy';
import { normalizeDisplayPath } from "../../shared/lib/displayPaths";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from '../models/modelExecutionState';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import { modelActions } from '../../shared/i18n/modelActions';
import ModelIcon from '../../shared/ui/ModelIcon';
import EngineSelect from '../../shared/ui/EngineSelect';


function formatCount(locale: string, value: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

/** Listing orders the API ranks by, in the order the picker offers them. */
const SORT_LABELS = {
  downloads: "ui.discoverSortDownloads",
  likes: "ui.discoverSortLikes",
  lastModified: "ui.discoverSortUpdated",
  trendingScore: "ui.discoverSortTrending",
} as const;

const SORT_KEYS = Object.keys(SORT_LABELS) as api.HfSortKey[];

interface InstalledLookup {
  repoId: string;
  modelsDir: string;
  entries: Record<string, api.HfInstalledFile>;
  /** `pending` until the first answer for this identity has arrived. */
  state: "pending" | "ready" | "unavailable";
}

function matches(lookup: InstalledLookup | null, repoId: string, modelsDir: string): boolean {
  return !!lookup && lookup.repoId === repoId && lookup.modelsDir === modelsDir;
}

export default function DiscoverPanel({ store, active = true, onSelectModel, onOpenModels }: { store: AppStore; active?: boolean; onSelectModel?: (path: string) => Promise<void>; onOpenModels?: () => void }) {
  const { t, locale } = useI18n();
  const [provider, setProvider] = useState<api.ProviderId>(() => api.providerOf(store.cfg ?? {}));
  const configuredProvider = api.providerOf(store.cfg ?? {});
  const previousConfiguredProvider = useRef(configuredProvider);
  useEffect(() => {
    if (previousConfiguredProvider.current !== configuredProvider) { previousConfiguredProvider.current = configuredProvider; setProvider(configuredProvider); }
  }, [configuredProvider]);
  const defaultFormat = provider === 'mlx-vlm' ? 'mlx' : provider === 'vllm' ? 'safetensors' : 'gguf';
  const [format, setFormat] = useState<'gguf' | 'safetensors' | 'mlx'>(defaultFormat);
  const [includeCompanions, setIncludeCompanions] = useState(false);
  const modelSettings = useModelSettings();
  const modelCopy = modelActions(locale);
  const [downloadedChoice, setDownloadedChoice] = useState<{ path: string; projector: boolean; provider?: api.ProviderId; runtime?: string } | null>(null);
  const guard = useDraftGuard();
  const latestStore = useRef(store); latestStore.current = store;

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<api.HfSortKey>("downloads");
  const [results, setResults] = useState<api.HfModel[]>([]);
  const [listed, setListed] = useState(false);
  const [selected, setSelected] = useState<api.HfModel | null>(null);
  const [files, setFiles] = useState<api.HfFile[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const transferOrigin = useRef<{ repo: string; file: string } | null>(null);
  // Which of the selected repository's files this machine already holds.
  // Activation refuses to overwrite, so offering a download for one of these
  // could only ever produce an error; the row says "Installed" instead.
  //
  // The answer is stamped with the repository and destination it was read for
  // and only used while both still match. Two repositories routinely publish
  // the same file name, so an answer carried across a selection change would
  // mark the wrong rows — and it would do so during the render before the
  // lookup effect had a chance to clear anything.
  const [installedLookup, setInstalledLookup] = useState<InstalledLookup | null>(null);
  const [installedRevision, setInstalledRevision] = useState(0);
  // The progress stream is owned app-wide so it survives leaving this page;
  // this panel just renders the record it publishes.
  const downloadTask = useModelDownload();
  const progress = downloadTask && downloadTask.received !== undefined
    ? { file_path: downloadTask.label, received: downloadTask.received, total: downloadTask.total ?? 0 }
    : null;
  const speedBps = downloadTask?.speedBps ?? null;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const searchGeneration = useRef(0);
  const inspectGeneration = useRef(0);
  const installedGeneration = useRef(0);
  const modelsDir = store.cfg?.models_dir ?? "";
  const downloadBusy = !!downloading || downloadTask?.state === 'running' || downloadTask?.state === 'cancelling';
  const [snapshots, setSnapshots] = useState<{ repo: string; destination: string; artifacts: api.ModelArtifact[] } | null>(null);
  const [checkingSnapshots, setCheckingSnapshots] = useState(false);
  const previousProvider = useRef(provider);
  useEffect(() => {
    if (previousProvider.current === provider) return;
    previousProvider.current = provider;
    searchGeneration.current += 1; inspectGeneration.current += 1;
    setSelected(null); setFiles(null); setResults([]); setLoadingFiles(false);
    setFormat(defaultFormat); opened.current = '';
  }, [provider, defaultFormat]);

  // An empty query is a listing, not a mistake: the panel opens on the catalog
  // in the selected order and the search box narrows it from there.
  const runSearch = useCallback(async (term: string, order: api.HfSortKey) => {
    const generation = ++searchGeneration.current;
    // A file listing already in flight belongs to a repository that is about
    // to leave the results, so retire it with the selection it was for.
    inspectGeneration.current += 1;
    setError(null);
    setNotice(null);
    setSelected(null);
    setFiles(null);
    setLoadingFiles(false);
    setSearching(true);
    try {
      const next = format === 'gguf' ? await api.hfSearchModels(term.trim(), 30, order) : await api.hfSearchModels(term.trim(), 30, order, format);
      if (generation !== searchGeneration.current) return;
      setResults(next);
      setListed(true);
    } catch (caught) {
      if (generation !== searchGeneration.current) return;
      setResults([]);
      setListed(true);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === searchGeneration.current) setSearching(false);
    }
  }, [format]);

  // Seed the listing the first time the panel is actually shown, so a panel
  // the user has never opened never spends a request.
  const opened = useRef('');
  useEffect(() => {
    const identity = `${provider}:${format}`;
    if (!active || opened.current === identity) return;
    opened.current = identity;
    void runSearch(query, sort);
  }, [active, runSearch, query, sort, provider, format]);

  useEffect(() => () => {
    searchGeneration.current += 1; inspectGeneration.current += 1; installedGeneration.current += 1;
  }, []);

  // Sort is part of the request, so changing it re-runs what is on screen.
  const changeSort = (order: api.HfSortKey) => {
    setSort(order);
    if (opened.current) void runSearch(query, order);
  };

  const inspect = async (model: api.HfModel) => {
    const generation = ++inspectGeneration.current;
    setSelected(model);
    setIncludeCompanions(false);
    setFiles(null);
    setError(null);
    setNotice(null);
    setLoadingFiles(true);
    if (format !== 'gguf') { setLoadingFiles(false); return; }
    try {
      const next = await api.hfModelFiles(model.id);
      if (generation === inspectGeneration.current) setFiles(next);
    } catch (caught) {
      if (generation === inspectGeneration.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === inspectGeneration.current) setLoadingFiles(false);
    }
  };

  useEffect(() => {
    const generation = ++installedGeneration.current;
    if (!selected || !files || files.length === 0) {
      setInstalledLookup(null);
      return;
    }
    const repoId = selected.id;
    const destination = modelsDir;
    const paths = files.map((file) => file.path);
    // Re-reading the same repository keeps the marks it already has, so a
    // refresh does not flicker; a different repository or destination starts
    // from nothing known.
    setInstalledLookup((current) => matches(current, repoId, destination)
      ? { ...current!, state: "pending" }
      : { repoId, modelsDir: destination, entries: {}, state: "pending" });
    void (async () => {
      try {
        const found = await api.hfInstalledFiles(repoId, paths, destination);
        if (generation !== installedGeneration.current) return;
        setInstalledLookup({ repoId, modelsDir: destination, entries: Object.fromEntries(found.map((entry) => [entry.path, entry])), state: "ready" });
      } catch {
        if (generation !== installedGeneration.current) return;
        // A supporting lookup: losing it costs fresh marks, not the panel,
        // and a download that then collides still reports its own error. Say
        // so in the header, and keep what is already known — a file this
        // session just downloaded is still on disk whatever the lookup says.
        setInstalledLookup((current) => matches(current, repoId, destination)
          ? { ...current!, state: "unavailable" }
          : { repoId, modelsDir: destination, entries: {}, state: "unavailable" });
      }
    })();
  }, [selected, files, modelsDir, installedRevision]);

  useEffect(() => {
    let retired = false;
    setSnapshots(null);
    if (!selected || format === 'gguf') { setCheckingSnapshots(false); return; }
    const repo = selected.id;
    setCheckingSnapshots(true);
    void api.hfInstalledSnapshots(repo, modelsDir).then(artifacts => {
      if (!retired) setSnapshots({ repo, destination: modelsDir, artifacts });
    }).catch(() => { /* Lookup failure still allows a verified, no-replace retry. */ }).finally(() => {
      if (!retired) setCheckingSnapshots(false);
    });
    return () => { retired = true; };
  }, [selected, format, modelsDir, installedRevision]);

  const transferActive = () => getTaskSnapshot().some(task => task.id === MODEL_DOWNLOAD_TASK_ID && ['running', 'cancelling'].includes(task.state));

  const download = async ({ file, files: parts, displayPath, sizeBytes }: HfFileGroup) => {
    if (!selected || !store.cfg || transferActive()) return;
    // Bind the transfer to the repository and destination it started from.
    // It outlives a selection change, and another repository's file of the
    // same name must not inherit its result.
    const repoId = selected.id;
    const destination = store.cfg.models_dir;
    const execution = { provider, runtime: provider === api.providerOf(store.cfg) ? store.cfg.active_runtime ?? '' : '' };
    if (!validateHfRepoId(selected.id)) {
      setError(t("ui.invalidRepoId"));
      return;
    }
    if (!["stopped", "failed", "crashed"].includes(store.status.state)) {
      setError(t("ui.stopBeforeDownload"));
      return;
    }
    setDownloading(file.path);
    transferOrigin.current = { repo: repoId, file: file.path };
    setDownloadedChoice(null);
    // Show the row immediately, before the first native progress event, so the
    // strip and this card both have something the moment the click lands.
    registerTask({
      id: MODEL_DOWNLOAD_TASK_ID,
      kind: "model-download",
      label: displayPath,
      phase: "starting",
      received: 0,
      total: sizeBytes,
      interruptible: true,
      cancel: () => api.hfCancelDownload(),
    });
    setError(null);
    setNotice(null);
    let transferred = false;
    try {
      const downloaded = provider === 'vllm' && includeCompanions && file.companions_available
        ? await api.hfDownloadModel(repoId, file.path, destination, true)
        : await api.hfDownloadModel(repoId, file.path, destination);
      transferred = true;
      finishTask(MODEL_DOWNLOAD_TASK_ID, 'completed');
      invalidateModelCatalog();
      // Mark it installed now and re-read after: the row must stop offering a
      // download the instant the transfer lands, and the lookup then confirms
      // it against the destination directory. Applied only while the panel is
      // still showing what was downloaded.
      setInstalledLookup((current) => {
        if (!matches(current, repoId, destination)) return current;
        let entries = current!.entries;
        const parent = downloaded.path.slice(0, Math.max(downloaded.path.lastIndexOf('/'), downloaded.path.lastIndexOf('\\')) + 1);
        for (const part of parts) entries = markInstalled(entries, part.path, parent + part.path.split('/').pop()!, part.size_bytes);
        return { ...current!, entries };
      });
      setInstalledRevision((revision) => revision + 1);
      let modelPath = downloaded.path;
      if (shardTotal(file.path)) {
        const entries = await api.hfInstalledFiles(repoId, [firstShard(file.path)], destination);
        const first = entries.find(entry => entry.path === firstShard(file.path));
        if (!first || first.missing_shards.length > 0) {
          setNotice(t('ui.downloadedModel', { file: file.path })); return;
        }
        modelPath = first.local_path;
      }
      if (modelSettings) {
        const projector = file.is_mmproj || isMmprojPath(file.path);
        setDownloadedChoice({ path: modelPath, projector, ...execution });
        setNotice(t(projector ? 'ui.downloadedProjector' : 'ui.downloadedModel', { file: file.path }));
        return;
      }
      if (file.is_mmproj || isMmprojPath(file.path)) {
        await guard.run(async () => {
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
          await latestStore.current.updateConfig({ mmproj: downloaded.path });
        });
        setNotice(t("ui.downloadedProjector", { file: file.path }));
      } else {
        if (onSelectModel) await guard.run(async () => {
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
          await onSelectModel(modelPath); onOpenModels?.();
        });
        else await guard.run(async () => {
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
          await latestStore.current.updateConfig({ active_model: modelPath });
        });
        setNotice(t("ui.downloadedModel", { file: file.path }));
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A download that never reached the native stream ends here, so the row
      // has to be closed from this side or it would sit there running forever.
      if (!transferred) finishTask(MODEL_DOWNLOAD_TASK_ID, message === 'model download cancelled' ? 'cancelled' : 'failed', message);
      if (message !== 'model download cancelled') setError(message);
    } finally {
      if (!transferred) {
        invalidateModelCatalog();
        setInstalledRevision(revision => revision + 1);
      }
      setDownloading(null);
    }
  };

  const cancel = async () => {
    updateTask(MODEL_DOWNLOAD_TASK_ID, { state: 'cancelling' });
    try {
      await api.hfCancelDownload();
    } catch (caught) {
      updateTask(MODEL_DOWNLOAD_TASK_ID, { state: 'running' });
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const downloadSnapshot = async () => {
    if (!selected || !store.cfg || transferActive()) return;
    if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state) || latestStore.current.busy) {
      setError(t('ui.stopBeforeDownload')); return;
    }
    const repo = selected.id;
    const destination = store.cfg.models_dir;
    const execution = { provider, runtime: provider === api.providerOf(store.cfg) ? store.cfg.active_runtime ?? '' : '' };
    setDownloadedChoice(null);
    setDownloading(repo); setError(null);
    registerTask({ id: MODEL_DOWNLOAD_TASK_ID, kind: 'model-download', label: repo, phase: 'starting',
      received: 0, total: 0, interruptible: true, cancel: () => api.hfCancelDownload() });
    try {
      const artifact = await api.hfDownloadSnapshot(repo, destination);
      invalidateModelCatalog(); finishTask(MODEL_DOWNLOAD_TASK_ID, 'completed');
      setInstalledRevision(revision => revision + 1);
      setDownloadedChoice({ path: artifact.path, projector: false, ...execution });
      setNotice(t('ui.downloadedModel', { file: repo }));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      finishTask(MODEL_DOWNLOAD_TASK_ID, message === 'model download cancelled' ? 'cancelled' : 'failed', message);
      if (message !== 'model download cancelled') setError(message);
      setInstalledRevision(revision => revision + 1);
    } finally { setDownloading(null); }
  };

  // Only an answer read for what is on screen right now may mark a row.
  const lookup = selected && matches(installedLookup, selected.id, modelsDir) ? installedLookup : null;
  const installed = lookup?.entries ?? {};
  const installedUnknown = lookup?.state === "unavailable";
  // Until the first answer lands, whether a file is already there is unknown,
  // and a download started on a guess would collide at activation.
  const checkingInstalled = !!selected && !!files && files.length > 0 && lookup?.state !== "ready" && !installedUnknown;
  const repoSnapshots = snapshots?.repo === selected?.id && snapshots?.destination === modelsDir ? snapshots.artifacts : [];
  const installedSnapshot = repoSnapshots.find(artifact => !artifact.incomplete && artifact.missing.length === 0);

  const configureDownloaded = (choice: NonNullable<typeof downloadedChoice>) => {
    const cfg = latestStore.current.getConfig();
    if (!cfg) return;
    try {
      const config = choice.projector ? { ...cfg, mmproj: choice.path }
        : { ...cfg, ...previewExecution({ ...cfg, active_provider: choice.provider ?? api.providerOf(cfg), active_runtime: choice.runtime ?? cfg.active_runtime }, choice.path), active_provider: choice.provider ?? api.providerOf(cfg), active_runtime: choice.runtime ?? cfg.active_runtime, active_model: choice.path };
      if (modelSettings) modelSettings.open({ target: { kind: 'default' }, config, section: choice.projector ? 'adapters' : 'model' });
      else void guard.run(async () => {
        if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
        await latestStore.current.updateConfig(current => choice.projector ? { mmproj: choice.path }
          : { ...previewExecution({ ...current, active_provider: choice.provider ?? api.providerOf(current), active_runtime: choice.runtime ?? current.active_runtime }, choice.path), active_provider: choice.provider ?? api.providerOf(current), active_runtime: choice.runtime ?? current.active_runtime, active_model: choice.path });
        if (onSelectModel && !choice.projector) await onSelectModel(choice.path);
        onOpenModels?.();
      }).catch(cause => setError(cause instanceof Error ? cause.message : String(cause)));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };

  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100))
    : 0;

  return (
    <div className="app-page-scroll discover-panel relative flex h-full min-h-0 flex-col">
      <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 className="app-page-title" >{providerCopy[locale].discoverTitle}</h2>
          <p className="app-page-description" >{providerCopy[locale].discoverDescription}</p>
        </div>
        <div className="app-card app-card--tight text-right text-xs ui-color-faint">
          <div className="text-xs">{t("panel.destination")}</div>
          <div className="mt-0.5 max-w-[18rem] app-text-wrap text-xs ui-color-ink"  title={store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}>{store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}</div>
        </div>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void runSearch(query, sort); }} className="mb-4 flex min-w-0 flex-wrap items-center gap-2.5" aria-busy={searching || loadingFiles || downloading !== null}>
        <EngineSelect value={provider} onChange={setProvider} disabled={downloadBusy} />
        <label>{providerCopy[locale].formats}<CustomSelect ariaLabel={providerCopy[locale].formats} value={format}
          options={provider === 'llama.cpp' ? [{ value: 'gguf', label: 'GGUF' }] : provider === 'mlx-vlm' ? [{ value: 'mlx', label: 'MLX Safetensors' }] : [{ value: 'safetensors', label: 'HF Safetensors' }, { value: 'gguf', label: 'GGUF' }]}
          disabled={downloadBusy}
          onChange={value => { searchGeneration.current += 1; inspectGeneration.current += 1; setFormat(value as typeof format); setSelected(null); setFiles(null); setLoadingFiles(false); setResults([]); opened.current = ''; }} /></label>
        <label className="sr-only" htmlFor="discover-search">{t("extra.search")}</label>
        <input id="discover-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={providerCopy[locale].discoverPlaceholder} className="app-input min-w-48 flex-1" />
        <CustomSelect ariaLabel={t("ui.discoverSort")} value={sort} size="sm" className="shrink-0" options={SORT_KEYS.map((key) => ({ value: key, label: t(SORT_LABELS[key]) }))} onChange={changeSort} />
        <button type="submit" disabled={searching} className="app-button app-button--primary shrink-0 ui-min-width-120px" ><StableLabel value={searching ? t("panel.scanning") : t("panel.searchModels")} labels={[t("panel.scanning"), t("panel.searchModels")]} /></button>
      </form>

      <PanelFeedback>
        {downloadedChoice && <FeedbackBanner tone="info" action={{ label: modelCopy.configure, onClick: () => configureDownloaded(downloadedChoice) }}>{downloadedChoice.path.split(/[\\/]/).pop()}</FeedbackBanner>}
        {error && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.downloadComplete")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>

      {downloadBusy && progress && (
        <div className="discover-progress-card app-card app-card--accent mb-4" role="status">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 app-text-wrap font-medium ui-color-ink" >{t("ui.downloadingFile", { file: normalizeDisplayPath(progress.file_path) })}</span>
            <span className="shrink-0 tabular-nums font-semibold ui-color-accent" >{progressPercent}%</span>
          </div>
          <ProgressBar label={t("ui.downloadProgress")} value={progress.total > 0 ? progressPercent : undefined} className="mt-2.5" />
          <div className="mt-2.5 flex items-center justify-between gap-3"><span className="whitespace-nowrap text-xs tabular-nums ui-color-muted" >{t("ui.bytesOfTotal", { received: formatBytes(progress.received), total: formatBytes(progress.total) })}</span><span className="flex shrink-0 items-center gap-2.5"><span className="whitespace-nowrap text-right text-sm font-semibold tabular-nums ui-color-accent ui-min-width-120px" >{speedBps !== null ? formatSpeedBps(speedBps) : "—"}</span><LocalTaskCancelButton taskId={MODEL_DOWNLOAD_TASK_ID} onClick={() => void cancel()} className="app-button app-button--ghost app-button--sm">{t("panel.cancel")}</LocalTaskCancelButton></span></div>
        </div>
      )}

      <div className="discover-columns grid min-h-0 flex-1 gap-3 ">
        <section className="min-h-0 overflow-auto app-card app-card--flush" tabIndex={0} aria-label={t("extra.searchResults")}>
          <div className="sticky top-0 z-10 border-b px-4 py-2.5 text-xs font-semibold ui-border-color-border ui-background-surface-muted ui-color-faint" >{t("extra.searchResults")} {results.length ? `(${results.length})` : ""}</div>
          {searching && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.searching")}</div>}
          {!searching && results.length === 0 && <div className="p-6 text-center text-xs leading-relaxed ui-color-faint" >{listed ? t("ui.discoverNoResults") : t("ui.searchHint")}</div>}
          <div role="list" className="space-y-1.5 p-2">
            {results.map((model) => (
              <div key={model.id} role="listitem"><button type="button" onClick={() => void inspect(model)} aria-current={selected?.id === model.id ? "true" : undefined} className={`app-list-row block w-full${selected?.id === model.id ? " is-selected" : ""}`}>
                <div className="flex min-w-0 items-center gap-2.5"><ModelIcon model={model.id} size={32} /><span className="min-w-0 app-text-wrap text-sm font-medium ui-color-ink">{model.id}</span></div><ModelBadges mode="compact" model={model.id} repository={model.id} tags={[...model.tags, ...(model.pipeline_tag ? [model.pipeline_tag] : [])]} />
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums ui-color-faint" ><span>{formatCount(locale, model.downloads)} {t("panel.downloads")}</span><span><span aria-hidden="true">♥ </span><span className="sr-only">{t("panel.likes")} </span>{formatCount(locale, model.likes)}</span>{model.gated && <Badge tone="warning">{t("panel.gated")}</Badge>}</div>
              </button></div>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-auto app-card app-card--flush" tabIndex={0} aria-label={t("panel.ariaRepositoryFiles")}>
          {!selected && <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-xs leading-relaxed ui-color-faint" >{providerCopy[locale].discoverSelect}</div>}
          {selected && <>
            {format !== 'gguf' && <><button type="button" className="app-button app-button--primary m-3" disabled={downloadBusy || store.busy || checkingSnapshots}
              onClick={() => void downloadSnapshot()}>{repoSnapshots.some(artifact => artifact.incomplete) ? modelCopy.retry : providerCopy[locale].snapshot}</button>
              {installedSnapshot && <Badge tone="neutral">{t('ui.discoverInstalled')}</Badge>}
              {installedSnapshot && <button type="button" className="app-button app-button--ghost" onClick={() => configureDownloaded({ path: installedSnapshot.path, projector: false, provider, runtime: provider === api.providerOf(store.cfg ?? {}) ? store.cfg?.active_runtime ?? '' : '' })}>{modelCopy.configure}</button>}
              {repoSnapshots.some(artifact => artifact.incomplete || artifact.missing.length > 0) && <p role="status" className="px-3 text-xs ui-color-warning">{providerCopy[locale].files}</p>}</>}
            {format === 'gguf' && provider === 'vllm' && <div className="p-3 text-xs ui-color-muted"><p>{providerCopy[locale].ggufPrerequisites}</p>
              {files?.some(file => file.companions_available) && <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={includeCompanions} disabled={downloadBusy} onChange={event => setIncludeCompanions(event.target.checked)} />{providerCopy[locale].ggufCompanions}</label>}
            </div>}
            <div className="border-b px-4 py-3 ui-border-color-border ui-background-surface-muted" ><div className="flex min-w-0 items-center gap-2.5"><ModelIcon model={selected.id} size={32} /><span className="min-w-0 app-text-wrap text-sm font-semibold ui-color-ink">{selected.id}</span></div><ModelBadges mode="detail" model={selected.id} repository={selected.id} tags={[...selected.tags, ...(selected.pipeline_tag ? [selected.pipeline_tag] : [])]} />
              {validateHfRepoId(selected.id) && <a
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4 ui-color-accent"
                href={`https://huggingface.co/${selected.id}`} target="_blank" rel="noopener noreferrer"
                onClick={(event) => {
                  if (!api.isNativeRuntimeAvailable()) return;
                  event.preventDefault();
                  void api.hfOpenModelCard(selected.id).catch((caught: unknown) => {
                    setError(caught instanceof Error ? caught.message : String(caught));
                  });
                }}
              >{t("ui.discoverModelCard")}<span aria-hidden="true">↗</span></a>}<div className="mt-1 text-xs ui-color-faint" >{providerCopy[locale].formats} · {selected.pipeline_tag || (format === 'gguf' ? 'GGUF' : format === 'mlx' ? 'MLX Safetensors' : 'HF Safetensors')}</div>{checkingInstalled && <div className="mt-1 text-xs ui-color-faint"  role="status">{t("ui.discoverInstalledChecking")}</div>}{installedUnknown && <div className="mt-1 text-xs ui-color-warning"  role="status">{t("ui.discoverInstalledUnknown")}</div>}</div>
            {loadingFiles && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.readingFiles")}</div>}
            {!loadingFiles && files?.length === 0 && <div className="p-6 text-center text-xs ui-color-faint" >{t("extra.noFiles")}</div>}
            {!loadingFiles && files && files.length > 0 && <div role="list" className="space-y-1.5 p-2">
              {groupHfFiles(files).map((group) => {
                const { file } = group;
                const activeDownload = downloading === file.path && transferOrigin.current?.repo === selected.id;
                const displayFilePath = normalizeDisplayPath(group.displayPath);
                const firstPresent = installed[file.path];
                const present = firstPresent?.missing_shards.length === 0 && group.files.every(part => installed[part.path]) ? firstPresent : undefined;
                const missing = firstPresent?.missing_shards.length ?? (shardTotal(file.path) ? (shardTotal(file.path)! - group.files.filter(part => installed[part.path]).length) : 0);
                const canDownload = ["stopped", "failed", "crashed"].includes(store.status.state);
                const downloadCompanions = provider === 'vllm' && includeCompanions && file.companions_available;
                const downloadActionLabel = present && !downloadCompanions ? t("ui.discoverInstalled") : activeDownload ? `${t("extra.downloading")}` : file.is_mmproj ? t("extra.downloadProjector") : t("extra.download");
                const blockedReason = present ? t("ui.discoverInstalledAt", { path: normalizeDisplayPath(present.local_path) })
                  : checkingInstalled ? t("ui.discoverInstalledChecking")
                  : !canDownload ? t("ui.stopBeforeDownload") : undefined;
                return <div key={file.path} role="listitem" className="app-list-row flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-1"><div className="app-text-wrap text-sm font-medium ui-color-ink"  title={displayFilePath}>{displayFilePath}</div><div className="mt-1 flex flex-wrap gap-2 text-xs ui-color-faint" ><span>{formatBytes(group.sizeBytes)}</span><span>{file.is_mmproj ? t("ui.visionProjector") : quantLabel(file.path)}</span>{shardTotal(file.path) && <Badge>{t('ui.modelShards', { count: shardTotal(file.path)! })}</Badge>}{group.files.some(part => part.oid) && <span>{t("ui.checksumMetadata")}</span>}{missing > 0 && group.files.some(part => installed[part.path]) && <Badge tone="warning">{t("ui.modelShardsMissing", { count: missing, total: shardTotal(file.path) ?? missing })}</Badge>}</div></div>
                  <button
                    type="button"
                    onClick={() => {
                      if (present && !downloadCompanions) return;
                      if (!canDownload) {
                        setError(t("ui.stopBeforeDownload"));
                        return;
                      }
                      void download(group);
                    }}
                    disabled={downloadBusy || store.busy || (!!present && !downloadCompanions) || checkingInstalled}
                    aria-disabled={!canDownload ? "true" : undefined}
                    title={blockedReason}
                    aria-label={`${downloadActionLabel}: ${displayFilePath}`}
                    className={`app-button app-button--primary app-button--sm shrink-0 ${!canDownload ? "opacity-80" : ""}`}
                  >
                    {downloadActionLabel}
                  </button>
                </div>;
              })}
            </div>}
          </>}
        </section>
      </div>
    </div>
  );
}
