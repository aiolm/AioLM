import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { formatBytes, formatSpeedBps, isMmprojPath, markInstalled, quantLabel, shardTotal, validateHfRepoId } from "./discoverUtils";
import { MODEL_DOWNLOAD_TASK_ID, useModelDownload } from "../../shared/state/modelDownloadTask";
import { finishTask, registerTask } from "../../shared/state/taskRegistry";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayPath } from "../../shared/lib/displayPaths";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import { useDraftGuard } from '../../shared/state/draftGuard';
import { useModelSettings } from '../model-settings/ModelSettingsProvider';
import { previewExecution } from '../models/modelExecutionState';
import { invalidateModelCatalog } from '../model-settings/useModelCatalog';
import { modelActions } from '../../shared/i18n/modelActions';


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
  const modelSettings = useModelSettings();
  const modelCopy = modelActions(locale);
  const [downloadedChoice, setDownloadedChoice] = useState<{ path: string; projector: boolean } | null>(null);
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
    setSearching(true);
    try {
      const next = await api.hfSearchModels(term.trim(), 30, order);
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
  }, []);

  // Seed the listing the first time the panel is actually shown, so a panel
  // the user has never opened never spends a request.
  const opened = useRef(false);
  useEffect(() => {
    if (!active || opened.current) return;
    opened.current = true;
    void runSearch("", "downloads");
  }, [active, runSearch]);

  // Sort is part of the request, so changing it re-runs what is on screen.
  const changeSort = (order: api.HfSortKey) => {
    setSort(order);
    if (opened.current) void runSearch(query, order);
  };

  const inspect = async (model: api.HfModel) => {
    const generation = ++inspectGeneration.current;
    setSelected(model);
    setFiles(null);
    setError(null);
    setNotice(null);
    setLoadingFiles(true);
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

  const download = async (file: api.HfFile) => {
    if (!selected || !store.cfg) return;
    // Bind the transfer to the repository and destination it started from.
    // It outlives a selection change, and another repository's file of the
    // same name must not inherit its result.
    const repoId = selected.id;
    const destination = store.cfg.models_dir;
    if (!validateHfRepoId(selected.id)) {
      setError(t("ui.invalidRepoId"));
      return;
    }
    if (!["stopped", "failed", "crashed"].includes(store.status.state)) {
      setError(t("ui.stopBeforeDownload"));
      return;
    }
    setDownloading(file.path);
    // Show the row immediately, before the first native progress event, so the
    // strip and this card both have something the moment the click lands.
    registerTask({
      id: MODEL_DOWNLOAD_TASK_ID,
      kind: "model-download",
      label: file.path,
      phase: "starting",
      received: 0,
      total: file.size_bytes,
      interruptible: true,
      cancel: () => api.hfCancelDownload(),
    });
    setError(null);
    setNotice(null);
    try {
      const downloaded = await api.hfDownloadModel(repoId, file.path, destination);
      invalidateModelCatalog();
      // Mark it installed now and re-read after: the row must stop offering a
      // download the instant the transfer lands, and the lookup then confirms
      // it against the destination directory. Applied only while the panel is
      // still showing what was downloaded.
      setInstalledLookup((current) => matches(current, repoId, destination)
        ? { ...current!, entries: markInstalled(current!.entries, file.path, downloaded.path, downloaded.size_bytes) }
        : current);
      setInstalledRevision((revision) => revision + 1);
      if (modelSettings) {
        const projector = file.is_mmproj || isMmprojPath(file.path);
        setDownloadedChoice({ path: downloaded.path, projector });
        setNotice(t(projector ? 'ui.downloadedProjector' : 'ui.downloadedModel', { file: file.path }));
        return;
      }
      if (file.is_mmproj || isMmprojPath(file.path)) {
        await store.updateConfig({ mmproj: downloaded.path });
        setNotice(t("ui.downloadedProjector", { file: file.path }));
      } else {
        if (onSelectModel) await guard.run(async () => {
          if (!['stopped', 'failed', 'crashed'].includes(latestStore.current.status.state)) throw new Error(t('ui.stopBeforeDownload'));
          await onSelectModel(downloaded.path); onOpenModels?.();
        });
        else await store.updateConfig({ active_model: downloaded.path });
        setNotice(t("ui.downloadedModel", { file: file.path }));
      }
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      // A download that never reached the native stream ends here, so the row
      // has to be closed from this side or it would sit there running forever.
      finishTask(MODEL_DOWNLOAD_TASK_ID, "failed", message);
      setError(message);
    } finally {
      setDownloading(null);
    }
  };

  const cancel = async () => {
    try {
      await api.hfCancelDownload();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  // Only an answer read for what is on screen right now may mark a row.
  const lookup = selected && matches(installedLookup, selected.id, modelsDir) ? installedLookup : null;
  const installed = lookup?.entries ?? {};
  const installedUnknown = lookup?.state === "unavailable";
  // Until the first answer lands, whether a file is already there is unknown,
  // and a download started on a guess would collide at activation.
  const checkingInstalled = !!selected && !!files && files.length > 0 && lookup?.state !== "ready" && !installedUnknown;

  const progressPercent = progress && progress.total > 0
    ? Math.min(100, Math.round(progress.received / progress.total * 100))
    : 0;

  return (
    <div className="app-page-scroll discover-panel relative flex h-full min-h-0 flex-col">
      <div className="mb-4 flex min-w-0 flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="app-eyebrow">{t("section.discover")}</div>
          <h2 className="mt-1 text-[18px] font-semibold tracking-tight ui-color-ink" >{t("extra.discoverTitle")}</h2>
          <p className="mt-1 max-w-2xl text-xs leading-relaxed ui-color-muted" >{t("extra.discoverDescription")}</p>
        </div>
        <div className="rounded-lg border px-3.5 py-2 text-right text-xs ui-border-color-border ui-background-panel ui-color-faint" >
          <div className="text-xs">{t("panel.destination")}</div>
          <div className="mt-0.5 max-w-[18rem] app-text-wrap text-xs ui-color-ink"  title={store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}>{store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}</div>
        </div>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void runSearch(query, sort); }} className="mb-4 flex min-w-0 flex-wrap items-center gap-2.5" aria-busy={searching || loadingFiles || downloading !== null}>
        <label className="sr-only" htmlFor="discover-search">{t("extra.search")}</label>
        <input id="discover-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("extra.searchPlaceholder")} className="app-input h-9 min-w-48 flex-1 px-3.5 text-sm" />
        <CustomSelect ariaLabel={t("ui.discoverSort")} value={sort} size="sm" className="shrink-0" options={SORT_KEYS.map((key) => ({ value: key, label: t(SORT_LABELS[key]) }))} onChange={changeSort} />
        <button type="submit" disabled={searching} className="app-button app-button--primary shrink-0 ui-min-width-120px" ><StableLabel value={searching ? t("panel.scanning") : t("panel.searchModels")} labels={[t("panel.scanning"), t("panel.searchModels")]} /></button>
      </form>

      <PanelFeedback>
        {downloadedChoice && modelSettings && <FeedbackBanner tone="info" action={{ label: modelCopy.configure, onClick: () => {
          const cfg = latestStore.current.getConfig();
          if (!cfg) return;
          modelSettings.open({ target: { kind: 'default' }, config: downloadedChoice.projector
            ? { ...cfg, mmproj: downloadedChoice.path }
            : { ...cfg, ...previewExecution(cfg, downloadedChoice.path), active_model: downloadedChoice.path }, section: downloadedChoice.projector ? 'adapters' : 'runtime' });
        } }}>{downloadedChoice.path.split(/[\\/]/).pop()}</FeedbackBanner>}
        {error && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.downloadComplete")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>

      {downloading && progress && (
        <div className="discover-progress-card app-card app-card--accent mb-4" role="status">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 app-text-wrap font-medium ui-color-ink" >{t("ui.downloadingFile", { file: normalizeDisplayPath(progress.file_path) })}</span>
            <span className="shrink-0 tabular-nums font-semibold ui-color-accent" >{progressPercent}%</span>
          </div>
          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full ui-background-border" role="progressbar" aria-label={t("ui.downloadProgress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.total > 0 ? progressPercent : undefined}><div className="h-full rounded-full transition-[width] ui-background-accent-solid" style={{ width: `${progressPercent}%` }} /></div>
          <div className="mt-2.5 flex items-center justify-between gap-3"><span className="whitespace-nowrap text-xs tabular-nums ui-color-muted" >{t("ui.bytesOfTotal", { received: formatBytes(progress.received), total: formatBytes(progress.total) })}</span><span className="flex shrink-0 items-center gap-2.5"><span className="whitespace-nowrap text-right text-sm font-semibold tabular-nums ui-color-accent ui-min-width-120px" >{speedBps !== null ? formatSpeedBps(speedBps) : "—"}</span><LocalTaskCancelButton taskId={MODEL_DOWNLOAD_TASK_ID} onClick={() => void cancel()} className="app-button app-button--ghost app-button--sm">{t("panel.cancel")}</LocalTaskCancelButton></span></div>
        </div>
      )}

      <div className="discover-columns grid min-h-0 flex-1 gap-3 ">
        <section className="min-h-0 overflow-auto app-card app-card--flush" tabIndex={0} aria-label={t("extra.searchResults")}>
          <div className="sticky top-0 z-10 border-b px-4 py-2.5 text-xs font-semibold ui-border-color-border ui-background-surface-muted ui-color-faint" >{t("extra.searchResults")} {results.length ? `(${results.length})` : ""}</div>
          {searching && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.searching")}</div>}
          {!searching && results.length === 0 && <div className="p-6 text-center text-xs leading-relaxed ui-color-faint" >{listed ? t("ui.discoverNoResults") : t("ui.searchHint")}</div>}
          <div role="list">
            {results.map((model) => (
              <div key={model.id} role="listitem"><button type="button" onClick={() => void inspect(model)} aria-current={selected?.id === model.id ? "true" : undefined} className={[`block w-full border-b px-4 py-3 text-left last:border-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset ${selected?.id === model.id ? "" : "hover:bg-[var(--ui-surface-muted)]"}`, "ui-border-color-border", (selected?.id === model.id ? "ui-background-accent-soft" : "")].filter(Boolean).join(" ")} >
                <div className="app-text-wrap text-sm font-medium ui-color-ink" >{model.id}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums ui-color-faint" ><span>{formatCount(locale, model.downloads)} {t("panel.downloads")}</span><span><span aria-hidden="true">♥ </span><span className="sr-only">{t("panel.likes")} </span>{formatCount(locale, model.likes)}</span>{model.gated && <span className="ui-color-warning" >{t("panel.gated")}</span>}</div>
                {model.tags.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{model.tags.slice(0, 4).map((tag) => <span key={tag} className="rounded-full border px-1.5 py-0.5 text-xs ui-border-color-border ui-background-surface-muted ui-color-faint" >{tag}</span>)}</div>}
              </button></div>
            ))}
          </div>
        </section>

        <section className="min-h-0 overflow-auto app-card app-card--flush" tabIndex={0} aria-label={t("panel.ariaRepositoryFiles")}>
          {!selected && <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-xs leading-relaxed ui-color-faint" >{t("extra.selectRepository")}</div>}
          {selected && <>
            <div className="sticky top-0 z-10 border-b px-4 py-3 ui-border-color-border ui-background-surface-muted" ><div className="app-text-wrap text-sm font-semibold ui-color-ink" >{selected.id}</div><div className="mt-1 text-xs ui-color-faint" >{t("ui.repoFileHint")} · {selected.pipeline_tag || "llama.cpp"}</div>{checkingInstalled && <div className="mt-1 text-xs ui-color-faint"  role="status">{t("ui.discoverInstalledChecking")}</div>}{installedUnknown && <div className="mt-1 text-xs ui-color-warning"  role="status">{t("ui.discoverInstalledUnknown")}</div>}</div>
            {loadingFiles && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.readingFiles")}</div>}
            {!loadingFiles && files?.length === 0 && <div className="p-6 text-center text-xs ui-color-faint" >{t("extra.noFiles")}</div>}
            {!loadingFiles && files && files.length > 0 && <div role="list">
              {files.map((file) => {
                const activeDownload = downloading === file.path;
                const displayFilePath = normalizeDisplayPath(file.path);
                const present = installed[file.path];
                const canDownload = ["stopped", "failed", "crashed"].includes(store.status.state);
                const downloadActionLabel = present ? t("ui.discoverInstalled") : activeDownload ? `${t("extra.downloading")}` : file.is_mmproj ? t("extra.downloadProjector") : t("extra.download");
                const blockedReason = present ? t("ui.discoverInstalledAt", { path: normalizeDisplayPath(present.local_path) })
                  : checkingInstalled ? t("ui.discoverInstalledChecking")
                  : !canDownload ? t("ui.stopBeforeDownload") : undefined;
                return <div key={file.path} role="listitem" className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 last:border-0 ui-border-color-border" >
                  <div className="min-w-0 flex-1"><div className="app-text-wrap text-sm font-medium ui-color-ink"  title={displayFilePath}>{displayFilePath}</div><div className="mt-1 flex flex-wrap gap-2 text-xs ui-color-faint" ><span>{formatBytes(file.size_bytes)}</span><span>{file.is_mmproj ? t("ui.visionProjector") : quantLabel(file.path)}</span>{file.oid && <span title={file.oid}>{t("ui.checksumMetadata")}</span>}{present && present.missing_shards.length > 0 && <span className="ui-color-warning" >{t("ui.modelShardsMissing", { count: present.missing_shards.length, total: shardTotal(file.path) ?? present.missing_shards.length })}</span>}</div></div>
                  <button
                    type="button"
                    onClick={() => {
                      if (present) return;
                      if (!canDownload) {
                        setError(t("ui.stopBeforeDownload"));
                        return;
                      }
                      void download(file);
                    }}
                    disabled={!!downloading || !!present || checkingInstalled}
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
