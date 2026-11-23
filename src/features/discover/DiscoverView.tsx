import { useId, useRef } from 'react';
import ModelBadges from '../../shared/ui/ModelBadges';
import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import Badge from "../../shared/ui/Badge";
import ProgressBar from "../../shared/ui/ProgressBar";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { providerCopy } from '../../shared/i18n/providerCopy';
import { modelDisplayName, normalizeDisplayPath } from "../../shared/lib/displayPaths";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import ModelIcon from '../../shared/ui/ModelIcon';
import { formatDuration } from '../../shared/lib/units';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import { discoverRecoveryCopy } from './discoverRecoveryCopy';
import type { HfSearchFormat, HfSortKey } from '../../shared/api/index';
import { MODEL_DOWNLOAD_TASK_ID } from '../../shared/state/modelDownloadTask';
import { formatBytes, formatSpeedBps, groupHfFiles, groupSafetensorsFiles, quantLabel, selectedBundleContains, shardTotal, validateHfRepoId } from './discoverUtils';
import type { useDiscoverController } from './useDiscoverController';

type ArtifactFormat = HfSearchFormat;
/**
 * Discover opens on every model repository whatever engine is configured. A
 * specific format is an optional search filter, never an engine choice, and
 * what can be downloaded in-app is read from the selected repository's files.
 */
const FILTER_OPTIONS: { value: Exclude<ArtifactFormat, 'all'>; label: string }[] = [
  { value: 'gguf', label: 'GGUF' },
  { value: 'safetensors', label: 'HF Safetensors' },
  { value: 'mlx', label: 'MLX Safetensors' },
];

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

const SORT_KEYS = Object.keys(SORT_LABELS) as HfSortKey[];

export default function DiscoverView({ controller }: { controller: ReturnType<typeof useDiscoverController> }) {
  const { store, t, locale, tokenCopy, modelCopy, modelsDir, query, setQuery, sort, results, listed, selected, searching,
    loadingFiles, downloading, format, changeFormat, changeSort, runSearch, error, setError, notice, setNotice,
    downloadBusy, progress, progressPercent, downloadTask, speedBps, remainingSeconds, cancel, pending,
    resumePending, requestDiscard, currentDownloadedChoice, configureDownloaded, inspect, fileFormats,
    checkingInstalled, installedUnknown, files, includeCompanions, setIncludeCompanions, snapshotCandidate,
    downloadSnapshot, wholeSnapshots, installedSnapshot, checkingSnapshots, currentInspectionError,
    noInAppDownload, safetensorsFiles, repoSnapshots, transferOrigin, installed, download,
    discarding, discardBusy, discardPending, setDiscarding, openModelCard,
    fileFilter, setFileFilter, hfTokenConfigured, hfTokenInput, setHfTokenInput, hfTokenBusy, hfTokenFeedback, setHfTokenFeedback,
    hfTokenOpen, setHfTokenOpen, saveHfToken, clearHfToken } = controller;
  const fileFilterId = useId();
  const tokenInputId = useId();
  const tokenInputRef = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const normalizedFileFilter = fileFilter.trim().toLowerCase();
  const safetensorsGroups = safetensorsFiles
    ? groupSafetensorsFiles(safetensorsFiles, currentDownloadedChoice ? [...repoSnapshots, currentDownloadedChoice] : repoSnapshots)
    : [];
  const filteredSafetensorsGroups = normalizedFileFilter
    ? safetensorsGroups.filter(group =>
        `${group.displayPath} ${group.files.map(part => part.path).join(' ')}`.toLowerCase().includes(normalizedFileFilter))
    : safetensorsGroups;
  const ggufGroups = files ? groupHfFiles(files) : [];
  const filteredGgufGroups = normalizedFileFilter
    ? ggufGroups.filter(group =>
        `${group.displayPath} ${quantLabel(group.file.path)} ${group.files.map(part => part.path).join(' ')}`.toLowerCase().includes(normalizedFileFilter))
    : ggufGroups;
  const totalFileGroups = safetensorsGroups.length + ggufGroups.length;
  const filteredTotalFileGroups = filteredSafetensorsGroups.length + filteredGgufGroups.length;
  return (
    <div className="app-page-scroll discover-panel relative flex h-full min-h-0 flex-col">
      <header className="app-page-header">
        <div className="min-w-0">
          <h1 className="app-page-title">{providerCopy[locale].discoverTitle}</h1>
          <p className="app-page-description" >{providerCopy[locale].discoverDescription}</p>
        </div>
        <div className="app-card app-card--tight flex items-center gap-2 text-start text-xs ui-color-faint">
          <span className="shrink-0">{t("panel.destination")}:</span>
          <span className="max-w-[20rem] truncate text-xs font-medium ui-color-ink" title={store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}>{store.cfg?.models_dir ? normalizeDisplayPath(store.cfg.models_dir) : t("panel.loading")}</span>
        </div>
      </header>

      <form onSubmit={(event) => { event.preventDefault(); void runSearch(query, sort); }} className="discover-toolbar" aria-busy={searching || loadingFiles || downloading !== null}>
        <label className="discover-toolbar-field discover-toolbar-search" htmlFor="discover-search">{t("extra.search")}
          <div className="app-search-field">
            <input ref={searchInputRef} id="discover-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={providerCopy[locale].discoverPlaceholder} className="app-input" />
            {query && (
              <button
                type="button"
                onClick={() => { setQuery(""); searchInputRef.current?.focus(); }}
                className="app-search-clear app-icon-button app-icon-button--sm"
                aria-label={tokenCopy.clearFilter}
                title={tokenCopy.clearFilter}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
              </button>
            )}
          </div>
        </label>
        <label className="discover-toolbar-field">{t("ui.discoverSort")}
          <CustomSelect ariaLabel={t("ui.discoverSort")} value={sort} options={SORT_KEYS.map((key) => ({ value: key, label: t(SORT_LABELS[key]) }))} onChange={changeSort} />
        </label>
        <label className="discover-toolbar-field">{providerCopy[locale].formats}<CustomSelect ariaLabel={providerCopy[locale].formats} value={format}
          options={[{ value: 'all', label: providerCopy[locale].allFormats }, ...FILTER_OPTIONS]}
          disabled={downloadBusy}
          onChange={changeFormat} /></label>
        <button type="submit" disabled={searching} className="app-button app-button--primary shrink-0 ui-min-width-120px" ><StableLabel value={searching ? t("panel.scanning") : t("panel.searchModels")} labels={[t("panel.scanning"), t("panel.searchModels")]} /></button>
      </form>

      <details
        className="discover-token-disclosure app-card app-card--tight mb-2"
        open={hfTokenOpen}
        onToggle={(event) => setHfTokenOpen(event.currentTarget.open)}
      >
        <summary className="discover-token-summary cursor-pointer text-xs font-medium ui-color-ink">
          <span>{tokenCopy.tokenTitle}</span>
          <Badge tone={hfTokenConfigured ? 'success' : 'neutral'}><StableLabel value={hfTokenConfigured ? tokenCopy.tokenConfigured : tokenCopy.tokenNotConfigured} labels={[tokenCopy.tokenConfigured, tokenCopy.tokenNotConfigured]} /></Badge>
        </summary>
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="min-w-0 flex-[1_1_16rem]">
              <label htmlFor={tokenInputId} className="block text-xs ui-color-muted">{tokenCopy.tokenLabel}</label>
              <input
                ref={tokenInputRef}
                id={tokenInputId}
                type="password"
                autoComplete="off"
                value={hfTokenInput}
                onChange={(event) => setHfTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void saveHfToken();
                  }
                }}
                placeholder={tokenCopy.tokenPlaceholder}
                disabled={hfTokenBusy}
                className="app-input mt-1"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" onClick={() => void saveHfToken()} disabled={hfTokenBusy || !hfTokenInput.trim()} className="app-button app-button--primary app-button--sm">{tokenCopy.tokenSave}</button>
              {hfTokenConfigured && <button type="button" onClick={() => void clearHfToken()} disabled={hfTokenBusy} className="app-button app-button--secondary app-button--sm">{tokenCopy.tokenClear}</button>}
            </div>
          </div>
          <p className="text-xs ui-color-faint">{tokenCopy.tokenHint}</p>
          {hfTokenFeedback && (
            <FeedbackBanner tone={hfTokenFeedback.tone === 'error' ? 'error' : 'success'} onDismiss={() => setHfTokenFeedback(null)}>
              {hfTokenFeedback.message}
            </FeedbackBanner>
          )}
        </div>
      </details>

      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("error.wrong")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice?.repo === selected?.id && notice?.destination === modelsDir && <FeedbackBanner tone="success" title={t("panel.downloadComplete")} onDismiss={() => setNotice(null)}>{notice.message}</FeedbackBanner>}
      </PanelFeedback>

      {downloadBusy && progress && (
        <div className="discover-progress-card app-card app-card--accent mb-4" role="status">
          <div className="flex items-center justify-between gap-3 text-xs">
            <span className="min-w-0 app-text-wrap font-medium ui-color-ink" >{t(downloadTask?.phase === 'verifying' ? "ui.downloadVerifying" : "ui.downloadingFile", { file: normalizeDisplayPath(progress.file_path) })}</span>
            <span className="shrink-0 tabular-nums font-semibold ui-color-accent" >{progressPercent !== undefined ? `${progressPercent}%` : t("extra.downloading")}</span>
          </div>
          <ProgressBar label={t("ui.downloadProgress")} value={progress.total > 0 ? progressPercent : undefined} className="mt-2.5" />
          <div className="discover-progress-summary mt-2.5 flex items-center justify-between gap-3">
            <span className="discover-progress-bytes text-xs tabular-nums ui-color-muted">{progress.total > 0 ? t("ui.bytesOfTotal", { received: formatBytes(progress.received), total: formatBytes(progress.total) }) : formatBytes(progress.received)}</span>
            <span className="discover-progress-actions flex items-center justify-end gap-2.5">
              <span className="discover-progress-rate text-right text-sm font-semibold tabular-nums ui-color-accent">{speedBps !== null ? formatSpeedBps(speedBps) : "—"}</span>
              {remainingSeconds !== null && <span className="discover-progress-remaining text-xs tabular-nums ui-color-muted">{t("ui.timeRemaining", { time: formatDuration(remainingSeconds) })}</span>}
              <LocalTaskCancelButton taskId={MODEL_DOWNLOAD_TASK_ID} onClick={() => void cancel()} className="app-button app-button--ghost app-button--sm">{t("ui.downloadPause")}</LocalTaskCancelButton>
            </span>
          </div>
        </div>
      )}
      {!downloadBusy && pending.length > 0 && <section className="discover-pending app-card mb-4" aria-labelledby="discover-pending-title">
        <h2 id="discover-pending-title" className="text-sm font-semibold ui-color-ink">{t("ui.pendingDownloadsTitle")}</h2>
        <p className="mt-1 text-xs ui-color-muted">{t("ui.pendingDownloadsHint")}</p>
        <div role="list" className="mt-3 space-y-2">
          {pending.map(entry => {
            const label = normalizeDisplayPath(entry.label);
            const percent = entry.total > 0 ? Math.min(100, Math.round(entry.received / entry.total * 100)) : undefined;
            return <div key={entry.id} role="listitem" className="app-list-row flex min-w-0 flex-wrap items-center justify-between gap-3">
              <div className="min-w-0 flex-[1_1_14rem]">
                <div className="app-text-wrap text-sm font-medium ui-color-ink">{label}</div>
                <div className="mt-0.5 app-text-wrap text-xs ui-color-faint">{entry.repo_id}</div>
                <ProgressBar label={label} value={percent} className="mt-2" />
                <div className="mt-1 text-xs tabular-nums ui-color-muted">{t("ui.bytesOfTotal", { received: formatBytes(entry.received), total: formatBytes(entry.total) })}{percent !== undefined ? ` · ${percent}%` : ''}</div>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-2">
                <button type="button" className="app-button app-button--primary app-button--sm" disabled={store.busy || discardBusy} aria-label={`${t("ui.pendingResume")}: ${label}`} onClick={() => void resumePending(entry)}>{t("ui.pendingResume")}</button>
                <button type="button" className="app-button app-button--ghost app-button--sm" disabled={discardBusy} aria-label={`${t("ui.pendingDiscard")}: ${label}`} onClick={() => requestDiscard(entry)}>{t("ui.pendingDiscard")}</button>
              </div>
            </div>;
          })}
        </div>
      </section>}
      {currentDownloadedChoice && !currentDownloadedChoice.selected_file && <div className="discover-download-complete">
        <p className="min-w-0 app-text-wrap">{modelDisplayName(currentDownloadedChoice.path)}</p>
        <button type="button" className="app-button app-button--primary" data-icon="settings" onClick={() => configureDownloaded(currentDownloadedChoice)}>{modelCopy.configure}</button>
      </div>}

      {/* Each scrolling column is its own containing block: otherwise absolutely
          positioned descendants (screen-reader labels, badge measurers) of rows
          scrolled out of view resolve against the panel and stretch the page
          with empty space below the columns. */}
      <div className="discover-columns grid min-h-0 flex-1 gap-4">
        <div className="discover-results relative min-h-0 overflow-auto app-card app-card--flush" role="region" tabIndex={0} aria-label={t("extra.searchResults")}>
          <div className="sticky top-0 z-10 border-b px-4 py-2.5 text-xs font-semibold ui-border-color-border ui-background-surface-muted ui-color-faint" >{t("extra.searchResults")} {results.length ? `(${results.length})` : ""}</div>
          {searching && results.length === 0 && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.searching")}</div>}
          {searching && results.length > 0 && <span className="sr-only" role="status">{t("extra.searching")}</span>}
          {!searching && results.length === 0 && <div className="p-6 text-center text-xs leading-relaxed ui-color-faint" >{listed ? t("ui.discoverNoResults") : t("ui.searchHint")}</div>}
          {results.length > 0 && <div role="list" className="space-y-1 p-1.5">
            {results.map((model) => (
              <div key={model.id} role="listitem"><button type="button" onClick={() => void inspect(model)} aria-current={selected?.id === model.id ? "true" : undefined} className={`app-list-row block w-full${selected?.id === model.id ? " is-selected" : ""}`}>
                <div className="flex min-w-0 items-center gap-2"><ModelIcon model={model.id} /><span className="min-w-0 app-text-wrap text-sm font-medium ui-color-ink">{model.id}</span></div><ModelBadges mode="compact" model={model.id} repository={model.id} tags={[...model.tags, ...(model.pipeline_tag ? [model.pipeline_tag] : [])]} />
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums ui-color-faint" ><span>{formatCount(locale, model.downloads)} {t("panel.downloads")}</span><span><span aria-hidden="true">♥ </span><span className="sr-only">{t("panel.likes")} </span>{formatCount(locale, model.likes)}</span>{model.gated && <Badge tone="warning">{t("panel.gated")}</Badge>}</div>
              </button></div>
            ))}
          </div>}
        </div>

        <div className="discover-detail relative min-h-0 overflow-auto app-card app-card--flush" role="region" tabIndex={0} aria-label={t("panel.ariaRepositoryFiles")}>
          {!selected && <div className="flex h-full min-h-48 items-center justify-center p-6 text-center text-xs leading-relaxed ui-color-faint" >{providerCopy[locale].discoverSelect}</div>}
          {selected && <>
            <div className="discover-repository border-b px-4 py-3 ui-border-color-border ui-background-surface-muted"><div className="flex min-w-0 items-center gap-2"><ModelIcon model={selected.id} /><span className="min-w-0 app-text-wrap text-sm font-semibold ui-color-ink">{selected.id}</span></div><ModelBadges mode="detail" model={selected.id} repository={selected.id} tags={[...selected.tags, ...(selected.pipeline_tag ? [selected.pipeline_tag] : [])]} />
              {validateHfRepoId(selected.id) && <a
                className="mt-2 inline-flex items-center gap-1 text-xs font-medium underline underline-offset-4 ui-color-accent"
                href={`https://huggingface.co/${selected.id}`} target="_blank" rel="noopener noreferrer"
                onClick={openModelCard}
              >{t("ui.discoverModelCard")}<span aria-hidden="true">↗</span></a>}{(fileFormats.length > 0 || checkingInstalled) && <div className="mt-1 flex flex-wrap items-center gap-x-2 text-xs ui-color-faint">{fileFormats.length > 0 && <span>{providerCopy[locale].formats} · {fileFormats.join(' · ')}</span>}{checkingInstalled && <span role="status">{t("ui.discoverInstalledChecking")}</span>}</div>}{installedUnknown && <div className="mt-1 text-xs ui-color-warning"  role="status">{t("ui.discoverInstalledUnknown")}</div>}</div>
            {files?.some(file => file.companions_available) && <div className="border-b ui-border-color-border p-3 text-xs ui-color-muted"><p>{providerCopy[locale].ggufPrerequisites}</p>
              <label className="mt-2 flex items-center gap-2"><input type="checkbox" checked={includeCompanions} disabled={downloadBusy} onChange={event => setIncludeCompanions(event.target.checked)} />{providerCopy[locale].ggufCompanions}</label>
            </div>}
            {snapshotCandidate && <div className="border-b px-3 py-3 ui-border-color-border">
              <div className="flex flex-wrap items-center gap-2">
                <button type="button" className="app-button app-button--primary" disabled={downloadBusy || store.busy || checkingSnapshots}
                  onClick={() => void downloadSnapshot()}><StableLabel value={wholeSnapshots.some(artifact => artifact.incomplete) ? modelCopy.retry : providerCopy[locale].snapshot} labels={[modelCopy.retry, providerCopy[locale].snapshot]} /></button>
                {installedSnapshot && <Badge tone="neutral">{t('ui.discoverInstalled')}</Badge>}
                {installedSnapshot && <button type="button" className="app-button app-button--ghost" onClick={() => configureDownloaded({ path: installedSnapshot.path, projector: false })}>{modelCopy.configure}</button>}
              </div>
              {wholeSnapshots.some(artifact => artifact.incomplete || artifact.missing.length > 0) && <p role="status" className="mt-2 text-xs ui-color-warning">{providerCopy[locale].files}</p>}
            </div>}
            {selected.gated && !hfTokenConfigured && (
              <FeedbackBanner
                tone="warning"
                className="m-3"
                title={tokenCopy.gatedTitle}
                action={{
                  label: tokenCopy.gatedConfigure,
                  onClick: () => {
                    setHfTokenOpen(true);
                    window.requestAnimationFrame(() => tokenInputRef.current?.focus());
                  },
                }}
              >
                {tokenCopy.gatedBody}
              </FeedbackBanner>
            )}
            {loadingFiles && <div className="p-6 text-center text-sm ui-color-muted"  role="status">{t("extra.readingFiles")}</div>}
            {!loadingFiles && currentInspectionError && <FeedbackBanner tone="error" className="m-3" title={discoverRecoveryCopy[locale]}
              action={{ label: t("panel.retry"), onClick: () => void inspect(selected) }}>{currentInspectionError.message}</FeedbackBanner>}
            {!loadingFiles && noInAppDownload && <div className="p-6 text-center text-xs ui-color-faint" role="status">{providerCopy[locale].noInAppDownload}</div>}
            {!loadingFiles && totalFileGroups > 1 && (
              <div className="discover-file-filter px-3 pt-2.5">
                <label className="sr-only" htmlFor={fileFilterId}>{tokenCopy.filterFiles}</label>
                <div className="app-search-field">
                  <input
                    id={fileFilterId}
                    type="search"
                    value={fileFilter}
                    onChange={(event) => setFileFilter(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape' && fileFilter.length > 0) {
                        event.preventDefault();
                        event.stopPropagation();
                        setFileFilter('');
                      }
                    }}
                    placeholder={tokenCopy.filterFilesPlaceholder}
                    aria-label={tokenCopy.filterFiles}
                    className="app-input"
                  />
                  {fileFilter && (
                    <button
                      type="button"
                      onClick={() => setFileFilter('')}
                      className="app-search-clear app-icon-button app-icon-button--sm"
                      aria-label={tokenCopy.clearFilter}
                      title={tokenCopy.clearFilter}
                    >
                      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
                    </button>
                  )}
                </div>
              </div>
            )}
            {!loadingFiles && normalizedFileFilter && totalFileGroups > 0 && filteredTotalFileGroups === 0 && (
              <div className="p-4 text-center text-xs ui-color-faint">
                <p>{tokenCopy.noMatchingFiles}</p>
                <button type="button" onClick={() => setFileFilter('')} className="app-button app-button--secondary app-button--sm mt-2">{tokenCopy.clearFilter}</button>
              </div>
            )}
            {!loadingFiles && filteredSafetensorsGroups.length > 0 && <>
              <p className="px-3 py-2 text-xs ui-color-muted">{providerCopy[locale].safetensorsBundle}</p>
              <div role="list" className="space-y-1 p-1.5">
                {filteredSafetensorsGroups.map(group => {
                  const path = group.file.path;
                  const matchingSnapshots = repoSnapshots.filter(artifact => selectedBundleContains(artifact, path));
                  const present = matchingSnapshots.find(artifact => !artifact.incomplete && artifact.missing.length === 0);
                  const completed = currentDownloadedChoice && selectedBundleContains(currentDownloadedChoice, path) ? currentDownloadedChoice : null;
                  const readyPath = present?.path ?? completed?.path;
                  const incomplete = matchingSnapshots.some(artifact => artifact.incomplete || artifact.missing.length > 0);
                  const activeDownload = downloading === path && transferOrigin.current?.repo === selected.id;
                  const displayPath = normalizeDisplayPath(group.displayPath);
                  const canDownload = ['stopped', 'failed', 'crashed'].includes(store.status.state);
                  const action = readyPath ? t('ui.discoverInstalled') : activeDownload ? t('extra.downloading') : incomplete ? modelCopy.retry : t('extra.download');
                  return <div key={path} role="listitem" className="app-list-row flex min-w-0 flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0 flex-[1_1_12rem]">
                      <div className="app-text-wrap text-sm font-medium ui-color-ink" title={displayPath}>{displayPath}</div>
                      <div className="mt-1 flex flex-wrap gap-2 text-xs ui-color-faint">
                        <span>{formatBytes(group.sizeBytes)}</span><span>Safetensors</span>
                        {group.shardCount > 1 && <Badge>{t('ui.modelShards', { count: group.shardCount })}</Badge>}
                        {group.missingParts > 0 && <Badge tone="warning">{t('ui.modelShardsMissing', { count: group.missingParts, total: group.shardCount })}</Badge>}
                        {group.files.some(part => part.oid) && <span>{t('ui.checksumMetadata')}</span>}
                      </div>
                      {incomplete && !readyPath && <p role="status" className="mt-1 text-xs ui-color-warning">{providerCopy[locale].files}</p>}
                    </div>
                    <div className="flex max-w-full flex-wrap items-center gap-2">
                      <button type="button" className={`app-button app-button--primary app-button--sm shrink-0${!canDownload ? " opacity-80" : ""}`}
                        disabled={downloadBusy || store.busy || checkingSnapshots || !!readyPath || group.missingParts > 0}
                        aria-disabled={!canDownload ? 'true' : undefined}
                        title={readyPath ? t('ui.discoverInstalledAt', { path: normalizeDisplayPath(readyPath) }) : !canDownload ? t('ui.stopBeforeDownload') : undefined}
                        aria-label={`${action}: ${displayPath}`} onClick={() => void downloadSnapshot(group)}><StableLabel value={action} labels={[t('extra.download'), t('extra.downloading'), modelCopy.retry, t('ui.discoverInstalled')]} /></button>
                      {readyPath && <button type="button" className="app-button app-button--ghost app-button--sm"
                        aria-label={`${modelCopy.configure}: ${displayPath}`}
                        onClick={() => configureDownloaded({ path: readyPath, projector: false })}>{modelCopy.configure}</button>}
                    </div>
                  </div>;
                })}
              </div>
            </>}
            {!loadingFiles && filteredGgufGroups.length > 0 && <div role="list" className={`space-y-1 p-1.5${filteredSafetensorsGroups.length > 0 ? " border-t ui-border-color-border" : ""}`}>
              {filteredGgufGroups.map((group) => {
                const { file } = group;
                const activeDownload = downloading === file.path && transferOrigin.current?.repo === selected.id;
                const displayFilePath = normalizeDisplayPath(group.displayPath);
                const firstPresent = installed[file.path];
                const present = firstPresent?.missing_shards.length === 0 && group.files.every(part => installed[part.path]) ? firstPresent : undefined;
                const missing = firstPresent?.missing_shards.length ?? (shardTotal(file.path) ? (shardTotal(file.path)! - group.files.filter(part => installed[part.path]).length) : 0);
                const canDownload = ["stopped", "failed", "crashed"].includes(store.status.state);
                const downloadCompanions = includeCompanions && file.companions_available;
                const downloadActionLabel = present && !downloadCompanions ? t("ui.discoverInstalled") : activeDownload ? `${t("extra.downloading")}` : file.is_mmproj ? t("extra.downloadProjector") : t("extra.download");
                const blockedReason = present ? t("ui.discoverInstalledAt", { path: normalizeDisplayPath(present.local_path) })
                  : checkingInstalled ? t("ui.discoverInstalledChecking")
                  : !canDownload ? t("ui.stopBeforeDownload") : undefined;
                return <div key={file.path} role="listitem" className="app-list-row flex min-w-0 flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 flex-[1_1_12rem]"><div className="app-text-wrap text-sm font-medium ui-color-ink"  title={displayFilePath}>{displayFilePath}</div><div className="mt-1 flex flex-wrap gap-2 text-xs ui-color-faint" ><span>{formatBytes(group.sizeBytes)}</span><span>{file.is_mmproj ? t("ui.visionProjector") : quantLabel(file.path)}</span>{shardTotal(file.path) && <Badge>{t('ui.modelShards', { count: shardTotal(file.path)! })}</Badge>}{group.files.some(part => part.oid) && <span>{t("ui.checksumMetadata")}</span>}{missing > 0 && group.files.some(part => installed[part.path]) && <Badge tone="warning">{t("ui.modelShardsMissing", { count: missing, total: shardTotal(file.path) ?? missing })}</Badge>}</div></div>
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
                    <StableLabel value={downloadActionLabel} labels={[t("extra.download"), t("extra.downloadProjector"), t("extra.downloading"), t("ui.discoverInstalled")]} />
                  </button>
                </div>;
              })}
            </div>}
          </>}
        </div>
      </div>
      <ConfirmDialog
        open={discarding !== null}
        title={t("ui.pendingDiscardTitle")}
        description={t("ui.pendingDiscardBody", { file: discarding ? normalizeDisplayPath(discarding.label) : "" })}
        confirmLabel={t("ui.pendingDiscard")}
        cancelLabel={t("common.cancel")}
        busy={discardBusy}
        onConfirm={() => { if (discarding) void discardPending(discarding); }}
        onCancel={() => { if (!discardBusy) setDiscarding(null); }}
      />
    </div>
  );
}
