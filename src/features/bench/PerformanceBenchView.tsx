import BenchmarkTableScroll from './BenchmarkTableScroll';
import ModelName from '../../shared/ui/ModelName';
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import { CustomSelect } from '../../shared/ui/CustomSelect';
import Badge from '../../shared/ui/Badge';
import EmptyState from '../../shared/ui/EmptyState';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';
import ConfirmDialog from '../../shared/ui/ConfirmDialog';
import ProgressBar from '../../shared/ui/ProgressBar';
import StableLabel from '../../shared/ui/StableLabel';
import { providerOf } from '../../shared/api/providers';
import { normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { benchmarkHistoryModelLabel, summarizePerformanceRows } from './performanceRecords';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { BenchmarkOwnedList } from './BenchmarkOwnedList';
import { BenchmarkEnvironment } from './BenchmarkEnvironment';
import { RecordedSettings, ServingResultTable } from './PublicBenchmarkSummary';
import { benchmarkCopy } from './benchmarkCopy';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { formatBenchmarkRuntimeVersion } from '../../shared/runtime/runtimeUtils';
import { formatBytes, formatCpuCores } from '../../shared/lib/units';
import BenchmarkExplorerActions from './BenchmarkExplorerActions';
import PanelFeedback, { ActivePanelContext } from '../../shared/ui/PanelFeedback';
import type { usePerformanceBench } from './usePerformanceBench';
import { CONCURRENCIES, CORPORA, OUTPUT_TOKEN_OPTIONS, PROMPT_BYTES, REPETITIONS, TASK_ID } from './performanceBenchConfig';

const STATUS_TONES = { complete: 'success', partial: 'warning', cancelled: 'neutral', failed: 'danger' } as const;
type Copy = ReturnType<typeof benchmarkCopy>;
type Summary = ReturnType<typeof summarizePerformanceRows>[number];

function numberLabel(value: number | null | undefined, copy: Copy, digits = 1): string {
  return value == null || !Number.isFinite(value) ? copy.unavailable : value.toFixed(digits);
}

const startsOption = (token: string | undefined) => token !== undefined && /^--?[a-zA-Z]/.test(token);

/** Selected values in run order, as their collapsed disclosure summarizes them. */
function selectionSummary(values: readonly number[], format: (value: number) => string, none: string): string {
  return values.length ? [...values].sort((a, b) => a - b).map(format).join(' · ') : none;
}

/** One line per launch argument: an option keeps the value it was given. */
function argumentLines(args: readonly string[]): string[] {
  const lines: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === undefined) continue;
    const option = JSON.stringify(normalizeDisplayText(token));
    const next = args[index + 1];
    // A following token that does not begin another option is this option's value.
    if (startsOption(token) && next !== undefined && !startsOption(next)) {
      lines.push(`${option} ${JSON.stringify(normalizeDisplayText(next))}`);
      index += 1;
    } else {
      lines.push(option);
    }
  }
  return lines;
}

function ResultTable({ rows, batch, copy }: { rows: Summary[]; batch: boolean; copy: Copy }) {
  if (!rows.length) return null;
  return <section className="app-card app-card--flush performance-card performance-results" aria-labelledby={batch ? "perf-batch-title" : "perf-single-title"}>
    <div className="performance-card-heading"><h3 id={batch ? "perf-batch-title" : "perf-single-title"}>{batch ? copy.batch : copy.single}</h3><Badge>{rows.length}</Badge></div>
    <BenchmarkTableScroll label={batch ? copy.batch : copy.single} copy={copy}>
      <table>
        <caption className="sr-only">{batch ? copy.batch : copy.single}</caption>
        <thead><tr>
          <th scope="col">{copy.test}</th>{batch && <th scope="col">{copy.concurrency}</th>}<th scope="col">{copy.repeat}</th>
          <th scope="col">{copy.ttft}<small>{copy.milliseconds}</small></th><th scope="col">{copy.tpot}<small>{copy.milliseconds}</small></th>
          <th scope="col" className="performance-phase-heading" title={copy.ppHint}>{copy.pp}<small>{copy.tokens}</small></th><th scope="col" className="performance-phase-heading" title={copy.tgHint}>{copy.tg}<small>{copy.tokens}</small></th>
          {batch && <th scope="col">{copy.speedup}</th>}<th scope="col">{copy.e2e}<small>{copy.seconds}</small></th><th scope="col" title={copy.throughputHint}>{copy.throughput}<small>{copy.tokens}</small></th><th scope="col" title={copy.memoryHint}>{copy.memory}</th>
        </tr></thead>
        <tbody>{rows.map((row) => <tr key={row.id}>
          <th scope="row">{row.prompt_tokens.toLocaleString()} / {row.generation_length.toLocaleString()}{row.error && <span className="performance-row-error">{normalizeDisplayText(row.error)}</span>}</th>
          {batch && <td>{row.concurrency}×</td>}<td>{row.samples}</td>
          <td>{numberLabel(row.ttft_ms, copy)}</td><td>{numberLabel(row.tpot_ms, copy, 2)}</td><td>{numberLabel(row.pp_tps, copy)}</td>
          <td className="performance-metric-primary">{numberLabel(row.tg_tps, copy)}{row.samples > 1 && row.tg_stddev != null && <small>± {numberLabel(row.tg_stddev, copy)}</small>}</td>
          {batch && <td>{row.speedup == null ? copy.unavailable : `${row.speedup.toFixed(2)}×`}</td>}
          <td>{row.error ? copy.unavailable : numberLabel(row.e2e_ms / 1000, copy, 2)}</td><td>{numberLabel(row.total_tps, copy)}</td><td>{row.peak_memory_bytes == null ? copy.unavailable : formatBytes(row.peak_memory_bytes)}</td>
        </tr>)}</tbody>
      </table>
    </BenchmarkTableScroll>
  </section>;
}

export function PerformanceBenchView({ controller }: { controller: ReturnType<typeof usePerformanceBench> }) {
  const {
    store, active, setupFormId, copy, explorerCopy, profileImport,
    modelCopy, modelSettings, installedRuntimes, sessionsError, stoppingSessions, promptBytes,
    setPromptBytes, concurrencies, setConcurrencies, warmup, setWarmup, outputTokens,
    setOutputTokens, repetitions, setRepetitions, corpus, setCorpus, phase,
    progress, rows, record, history, historyOffset,
    historyLoading, historyError, historyWarnings, exporting, exportFormat, setExportFormat,
    exportNotice, setExportNotice, sharingRevision, setSharingRevision, sharingBusy, setSharingBusy,
    pendingDelete, setPendingDelete, deleting, deleteError, setDeleteError, historyNotice,
    setHistoryNotice, selectedHistory, setSelectedHistory, error, setError, storageError,
    copied, copying, device, setAdmissionRevision, resetCopied, busy,
    otherBenchmark, valid, serverRunning, targetDiffers,
    displayedTarget, displayedModel, blockingSessions, setupGaps, admission, canRun,
    total, selectedRecord, localImportUnavailable, previousRecords, historyModelNames, exportAllDiffers,
    visibleRows, visibleResult, provenance, selectedGpuLabel, modelHash, legacyRecord,
    servingRecord, servingPoints, singleRows, batchRows, servingProvenance,
    modelSource, refreshSessions, loadHistory, editModel, stopSessions, cancel,
    run, toggle, advancedSummary, statusLabel, progressMessage, copyResults,
    exportResults, deleteSelectedHistory,
    importDefaultTarget,
  } = controller;
  return <div className="app-page-scroll performance-page">
    <header className="app-page-header performance-heading">
      <div><h1 className="app-page-title">{copy.title}</h1><p className="app-page-description">{copy.description}</p></div>
      <BenchmarkExplorerActions listenerReady={profileImport.listenerReady} />
    </header>
    <div className="app-card performance-run-bar">
      <div className="performance-run-status">
        {busy
          ? <section className="performance-progress" aria-label={copy.running}><div role="status" aria-live="polite"><strong>{progressMessage}</strong><span>{progress?.completed ?? 0} / {progress?.total ?? total}</span></div><ProgressBar label={copy.totalTests} value={(progress?.completed ?? 0) / Math.max(1, progress?.total ?? total) * 100} /></section>
          : <p className="performance-run-summary">{copy.totalTests}: <strong>{total}</strong></p>}
        <p id="performance-validation" className={valid ? "sr-only" : "performance-validation"}>{copy.servingValidation}</p>
      </div>
      {busy ? <LocalTaskCancelButton taskId={TASK_ID} pending={phase === "cancelling"} className="app-button app-button--danger" disabled={phase === "cancelling"} onClick={() => void cancel()}>{phase === "cancelling" ? copy.cancelling : copy.cancel}</LocalTaskCancelButton> : <button type="submit" form={setupFormId} className="app-button app-button--primary" disabled={!canRun}>{copy.run}</button>}
    </div>
    {profileImport.importDialog}
    <ActivePanelContext.Provider value={true}><PanelFeedback>
      {profileImport.notice && <FeedbackBanner tone={profileImport.notice.error ? 'error' : 'success'} onDismiss={profileImport.dismissNotice}>{profileImport.notice.text}</FeedbackBanner>}
    </PanelFeedback></ActivePanelContext.Provider>
    {!setupGaps.length && !busy && admission?.status !== 'supported' && <FeedbackBanner tone={admission ? 'warning' : 'info'} className="performance-notice"
      action={modelSettings ? { label: copy.admissionConfigure, onClick: () => editModel('runtime') }
        : admission?.status === 'unknown' ? { label: modelCopy.retry, onClick: () => setAdmissionRevision(value => value + 1) } : undefined}>
      <span role="status">{!admission ? copy.admissionPending : admission.status === 'unknown' ? copy.admissionUnknown
        : admission.reason === 'fixed_output' ? copy.admissionFixedOutput
        : admission.reason === 'stream_usage' ? copy.admissionUsage : copy.admissionRequest}</span>
      {admission?.detail && <details><summary>{copy.details}</summary>{normalizeDisplayText(admission.detail)}</details>}
    </FeedbackBanner>}
    {serverRunning && !busy && <FeedbackBanner tone="warning" className="performance-notice" action={{ label: copy.stopServer, disabled: store.busy, onClick: () => void store.stop().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught))) }}>{copy.stopHint}</FeedbackBanner>}
    {blockingSessions.length > 0 && !busy && <FeedbackBanner tone="warning" className="performance-notice" action={{ label: modelCopy.stopSessions, disabled: stoppingSessions, onClick: () => void stopSessions() }}>{`${modelCopy.sessionsHint} ${blockingSessions.map(session => normalizeDisplayText(session.name || session.id)).join(', ')}`}</FeedbackBanner>}
    {sessionsError && <FeedbackBanner tone="error" className="performance-notice" action={{ label: modelCopy.retry, onClick: () => void refreshSessions().catch(() => undefined) }}>{modelCopy.sessionsError}</FeedbackBanner>}
    {otherBenchmark && <FeedbackBanner tone="warning" className="performance-notice">{copy.activeElsewhere}</FeedbackBanner>}
    <div className="performance-workspace">
      <div className="performance-setup-column">
        <h2 id="performance-setup-title" className="performance-section-title">{copy.setupTitle}</h2>
        <form id={setupFormId} className="app-card app-card--flush performance-setup" aria-labelledby="performance-setup-title" onSubmit={(event) => { event.preventDefault(); void run(); }}>
          <div className="performance-setup-section performance-target">
            <div className="performance-target-identity"><span className="performance-target-label">{copy.model}</span>
              <strong className="performance-target-name" title={normalizeDisplayPath(displayedModel.model)}><ModelIcon model={displayedModel.model} /><span><ModelName model={displayedModel.model} empty={copy.noModel} /></span></strong>
            </div>
            <ModelBadges mode="compact" model={displayedModel.model} localPath={providerOf(displayedTarget?.config ?? {}) === 'llama.cpp' ? displayedModel.model : undefined} />
            {modelSettings && <div className="performance-target-actions">
              <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy} data-icon="settings" onClick={() => editModel('model')}>{modelCopy.settings}</button>
              {targetDiffers && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy} onClick={importDefaultTarget}>{modelCopy.importDefault}</button>}
            </div>}
          </div>
          {displayedTarget && <div className="performance-setup-section">
            <BenchmarkEnvironment config={displayedTarget.config} application={displayedTarget.application} device={device} runtimes={installedRuntimes} active={active} busy={busy || otherBenchmark} onRuntimeVerified={() => setAdmissionRevision(value => value + 1)} />
          </div>}
          <div className="performance-setup-section"><fieldset disabled={busy} className="performance-fields">
            <legend className="performance-column-title">{copy.conditions}</legend>
            <div className="performance-input-grid">
              <label className="performance-field"><span>{copy.corpus}</span><CustomSelect ariaLabel={copy.corpus} value={corpus} disabled={busy} onChange={setCorpus} options={CORPORA.map(key => ({ value: key, label: copy[key] }))} /></label>
              <label className="performance-field"><span>{copy.outputTokens}</span><CustomSelect id="performance-output-tokens" ariaLabel={copy.outputTokens} value={outputTokens} disabled={busy} onChange={setOutputTokens} options={OUTPUT_TOKEN_OPTIONS} /></label>
              <label className="performance-field"><span>{copy.repetitions}</span><CustomSelect id="performance-repetitions" ariaLabel={copy.repetitions} value={repetitions} disabled={busy} onChange={setRepetitions} options={REPETITIONS.map(value => ({ value, label: value.toLocaleString() }))} /></label>
            </div>
            <div className="performance-option-list">
              <details className="performance-option">
                <summary><span>{copy.inputBytes}</span><span className={promptBytes.length ? 'performance-option-value' : 'performance-option-value performance-option-value--empty'}>{selectionSummary(promptBytes, value => value.toLocaleString(), copy.noneSelected)}</span></summary>
                <fieldset className="performance-option-body"><legend className="sr-only">{copy.inputBytes}</legend><div className="performance-chips">{PROMPT_BYTES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={promptBytes.includes(value)} onChange={() => toggle(value, promptBytes, setPromptBytes)} /><span>{value.toLocaleString()}</span></label>)}</div></fieldset>
              </details>
              <details className="performance-option">
                <summary><span>{copy.batchSizes}</span><span className={concurrencies.length ? 'performance-option-value' : 'performance-option-value performance-option-value--empty'}>{selectionSummary(concurrencies, value => `${value}×`, copy.noneSelected)}</span></summary>
                <fieldset className="performance-option-body"><legend className="sr-only">{copy.batchSizes}</legend><div className="performance-chips">{CONCURRENCIES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={concurrencies.includes(value)} onChange={() => toggle(value, concurrencies, setConcurrencies)} /><span>{value}×</span></label>)}</div><p className="performance-hint">{copy.concurrencyHint}</p></fieldset>
              </details>
              <details className="performance-option">
                <summary><span>{copy.advanced}</span><span className="performance-option-value">{advancedSummary}</span></summary>
                <div className="performance-option-body">
                  <label className="performance-chip"><input type="checkbox" checked={warmup} onChange={event => setWarmup(event.target.checked)} /><span>{copy.warmup}</span></label>
                  <p className="performance-hint">{copy.fixedOutputConditions}</p>
                </div>
              </details>
            </div>
          </fieldset></div>
        </form>
      </div>
      <div className="performance-results-column">
        <section className="performance-results-area" aria-labelledby="performance-results-title">
          <div className="performance-results-toolbar">
            <h2 id="performance-results-title" className="performance-section-title">{copy.resultsTitle}</h2>
            {(history.length > 0 || rows.length > 0 || record || historyOffset !== null) && <div className="performance-history-controls">
              {previousRecords.length > 0 ? <label className="performance-history-select"><span>{copy.history}</span><CustomSelect ariaLabel={copy.history} value={selectedHistory} disabled={busy || exporting || deleting}
                onChange={value => { setSelectedHistory(value); resetCopied(); setError(null); setExportNotice(null); setHistoryNotice(null); }}
                options={[{ value: '', label: copy.current }, ...previousRecords.map((item, index) => ({ value: item.id,
                  label: `${new Date(item.createdAt).toLocaleString()} · ${item.schemaVersion === 2 ? benchmarkHistoryModelLabel(item) || copy.unavailable : historyModelNames[index]} · ${({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed })[item.result.status]}`,
                  icon: <ModelIcon model={item.model} /> }))]} /></label> : <span className="performance-history-current">{copy.current}</span>}
              {historyOffset !== null && <button type="button" className="app-button app-button--ghost app-button--sm" disabled={busy || historyLoading || deleting} data-icon="refresh" onClick={() => void loadHistory(true)}>{copy.loadMore}</button>}
              {selectedRecord && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={deleting || copying} aria-busy={copying} data-icon="copy" onClick={() => void copyResults()}><StableLabel value={copied ? copy.copied : copy.copy} labels={[copy.copy, copy.copied]} /></button>}
              {(selectedRecord || exportAllDiffers || historyOffset !== null) && <details className="performance-result-actions">
                <summary className="app-button app-button--secondary app-button--sm">{copy.resultActions}</summary>
                <div className="performance-result-actions-body">
                  <div className="performance-action-row">
                    <CustomSelect className="performance-export-format" size="sm" ariaLabel={copy.exportFormat} value={exportFormat} disabled={busy || exporting || deleting}
                      onChange={value => { setExportFormat(value); setExportNotice(null); }} options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV (.csv)' }]} />
                    {selectedRecord && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || exporting || deleting} data-icon="download" onClick={() => void exportResults(false)}>{copy.exportFile}</button>}
                    {(exportAllDiffers || historyOffset !== null) && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={busy || exporting || deleting} data-icon="download" onClick={() => void exportResults(true)}>{copy.exportAllCsv}</button>}
                  </div>
                  {selectedRecord && <div className="performance-action-row">
                    <button type="button" className="app-button app-button--secondary app-button--sm" disabled={profileImport.importing || deleting || localImportUnavailable} aria-describedby={localImportUnavailable ? 'benchmark-import-unavailable' : undefined} onClick={() => void profileImport.importLocal(selectedRecord)}>{profileImport.importing ? explorerCopy.importing : explorerCopy.import}</button>
                    <button type="button" className="app-button app-button--danger app-button--sm" disabled={busy || otherBenchmark || exporting || historyLoading || deleting || sharingBusy} data-icon="delete" onClick={() => { setDeleteError(false); setHistoryNotice(null); setPendingDelete(selectedRecord); }}>{deleting ? copy.deleting : copy.deleteHistory}</button>
                  </div>}
                  {localImportUnavailable && <p id="benchmark-import-unavailable" className="performance-hint">{explorerCopy.unavailableSettings}</p>}
                  {(history.length > 0 || record) && <p className="performance-hint">{copy.localHistoryHint}</p>}
                </div>
              </details>}
            </div>}
          </div>
          {historyLoading && <p role="status" className="performance-hint">{copy.historyLoading}</p>}
          {selectedRecord && <div className="performance-result-context">
            <strong className="performance-result-model"><ModelIcon model={selectedRecord.model} />{selectedRecord.schemaVersion === 2 ? benchmarkHistoryModelLabel(selectedRecord) || copy.unavailable : <><ModelName model={selectedRecord.model} /><ModelBadges mode="compact" model={selectedRecord.model} /></>}</strong>
            <div className="performance-result-facts">
              <Badge tone={STATUS_TONES[selectedRecord.result.status]}>{statusLabel}</Badge>
              <span>{selectedRecord.schemaVersion === 1 ? `${copy.legacy} · ${selectedRecord.backend} · ${formatBenchmarkRuntimeVersion(selectedRecord.result, selectedRecord.build, copy.unavailable)}` : `${copy.method}: ${selectedRecord.request.method.id}@${selectedRecord.request.method.version}`} · {copy[selectedRecord.request.context_profile]}</span>
              <span>{selectedRecord.localState === 'cached' ? copy.localCached : copy.localRecovery}</span>
            </div>
            {visibleResult?.message && <p>{normalizeDisplayText(visibleResult.message)}</p>}
          </div>}
          {error && <FeedbackBanner tone="error" className="performance-notice performance-error">{normalizeDisplayText(error)}</FeedbackBanner>}
          {storageError && !selectedHistory && <FeedbackBanner tone="warning" className="performance-notice">{copy.storageError}</FeedbackBanner>}
          {historyError && <FeedbackBanner tone="error" className="performance-notice" action={{ label: modelCopy.retry, disabled: busy || historyLoading || deleting, onClick: () => void loadHistory() }}>{copy.historyError}</FeedbackBanner>}
          {historyWarnings && <FeedbackBanner tone="warning" className="performance-notice">{copy.historyWarning}</FeedbackBanner>}
          {exportNotice && <FeedbackBanner tone="success" className="performance-notice">{exportNotice}</FeedbackBanner>}
          {historyNotice && <FeedbackBanner tone="success" className="performance-notice">{historyNotice}</FeedbackBanner>}
          {legacyRecord ? <><ResultTable rows={singleRows} batch={false} copy={copy} /><ResultTable rows={batchRows} batch copy={copy} /></> : <ServingResultTable points={servingPoints} copy={copy} fixedOutput={!selectedRecord || selectedRecord.schemaVersion === 2 && selectedRecord.request.method.version === 2} />}
          {!visibleRows.length && !visibleResult && !busy && !error && <EmptyState title={copy.emptyTitle} description={copy.empty} />}
          <div className="app-card app-card--flush performance-disclosures">
            {selectedRecord && <details className="performance-details"><summary>{copy.details}</summary><div className="performance-details-body"><dl className="performance-run-config">
              <div><dt>{copy.corpus}</dt><dd>{copy[selectedRecord.request.context_profile]}</dd></div>
              <div><dt>{selectedRecord.schemaVersion === 2 ? copy.inputBytes : copy.promptLengths}</dt><dd>{(selectedRecord.schemaVersion === 2 ? selectedRecord.request.prompt_bytes : selectedRecord.request.prompt_lengths).map((value) => value.toLocaleString()).join(" / ")}</dd></div>
              <div><dt>{selectedRecord.schemaVersion === 2 ? selectedRecord.request.method.version === 2 ? copy.outputTokens : copy.outputCap : copy.generation}</dt><dd>{(selectedRecord.schemaVersion === 2 ? selectedRecord.request.max_output_tokens : selectedRecord.request.generation_length).toLocaleString()}</dd></div>
              <div><dt>{copy.batchSizes}</dt><dd>{(selectedRecord.schemaVersion === 2 ? selectedRecord.request.concurrencies : [1, ...selectedRecord.request.batch_sizes]).map((value) => `${value}×`).join(" / ")}</dd></div>
              <div><dt>{copy.repetitions}</dt><dd>{selectedRecord.request.repetitions}</dd></div>
              <div><dt>{copy.warmup}</dt><dd>{selectedRecord.request.warmup ? copy.enabled : copy.disabled}</dd></div>
              {legacyRecord && <>
                <div><dt>{copy.contextSize}</dt><dd>{legacyRecord.result.context_size > 0 ? legacyRecord.result.context_size.toLocaleString() : copy.unavailable}</dd></div>
                <div><dt>{copy.parallel}</dt><dd>{legacyRecord.result.parallel > 0 ? legacyRecord.result.parallel : copy.unavailable}</dd></div>
                <div><dt>{copy.runtimeVersion}</dt><dd>{formatBenchmarkRuntimeVersion(legacyRecord.result, legacyRecord.build, copy.unavailable)}</dd></div>
              </>}
              {servingRecord && <><div><dt>{copy.requestUsage}</dt><dd>{servingRecord.request.request_usage ? copy.enabled : copy.disabled}</dd></div><div><dt>{copy.cachePolicy}</dt><dd>{copy.asConfigured}</dd></div></>}
              {servingProvenance && <>
                <div><dt>{copy.runtimeName}</dt><dd>{servingProvenance.runtime.name ?? copy.unavailable}</dd></div>
                <div><dt>{copy.runtimeVersion}</dt><dd>{servingProvenance.runtime.version ?? copy.unavailable}</dd></div>
                <div><dt>{copy.shareBackend}</dt><dd>{servingProvenance.runtime.backend ?? copy.unavailable}</dd></div>
                <div><dt>{copy.runtimeBuild}</dt><dd>{servingProvenance.runtime.build ?? copy.unavailable}</dd></div>
                <div><dt>{copy.runtimeVariant}</dt><dd>{servingProvenance.runtime.variant ?? copy.unavailable}</dd></div>
                <div><dt>{copy.runtimePlugin}</dt><dd>{servingProvenance.runtime.plugin_version ?? copy.unavailable}</dd></div>
                <div><dt>{copy.shareAppVersion}</dt><dd>{servingProvenance.app_version}</dd></div>
                <div><dt>{copy.topology}</dt><dd>{servingProvenance.execution.topology}</dd></div>
                <div><dt>{copy.memoryScope}</dt><dd>{servingProvenance.execution.memory_scope}</dd></div>
                <div><dt>{copy.modelFormat}</dt><dd>{servingProvenance.model.format}</dd></div>
                {servingProvenance.model.format === 'gguf' && servingProvenance.model.metadata && <div><dt>{copy.shareModelName}</dt><dd>{[servingProvenance.model.metadata.name, servingProvenance.model.metadata.architecture, servingProvenance.model.metadata.size_label, servingProvenance.model.metadata.quantization].filter(Boolean).join(' · ') || copy.unavailable}</dd></div>}
                <div><dt>{copy.modelStatus}</dt><dd>{servingProvenance.model.status}</dd></div>
                <div><dt>{copy.shareModelSize}</dt><dd>{servingProvenance.model.size_bytes == null ? copy.unavailable : formatBytes(servingProvenance.model.size_bytes)}</dd></div>
                <div><dt>{copy.modelSource}</dt><dd>{modelSource?.repository ?? copy.unavailable}</dd></div>
                <div><dt>{copy.modelRevision}</dt><dd>{modelSource?.revision ?? copy.unavailable}</dd></div>
                {servingProvenance.workload.inputs.map(input => <div key={input.bytes}><dt>{copy.inputHash} · {input.bytes}</dt><dd>{input.sha256}</dd></div>)}
              </>}
              <div><dt>{copy.executionDevice}</dt><dd>{provenance?.environment?.execution?.mode === 'cpu' ? 'CPU' : selectedGpuLabel || copy.unavailable}</dd></div>
              <div><dt>{copy.shareOs}</dt><dd>{provenance?.environment ? `${provenance.environment.os} · ${provenance.environment.arch}` : copy.unavailable}</dd></div>
              <div><dt>{copy.processor}</dt><dd>{provenance?.environment?.cpu ? `${normalizeDisplayText(provenance.environment.cpu.name)} · ${formatCpuCores(provenance.environment.cpu)}` : copy.unavailable}</dd></div>
              <div><dt>{copy.systemMemory}</dt><dd>{typeof provenance?.environment?.system_memory_bytes === 'number' ? formatBytes(provenance.environment.system_memory_bytes) : copy.unavailable}</dd></div>
              <div><dt>{copy.modelHash}</dt><dd>{typeof modelHash === 'string' ? modelHash : copy.unavailable}</dd></div>
            </dl>{servingProvenance && <><p>{copy.hostScope}</p><p>{copy.sourceHint}</p><h3 className="performance-details-heading">{copy.recordedSettings}</h3><RecordedSettings settings={servingProvenance.execution.settings} copy={copy} /></>}
              {servingRecord && <dl className="performance-run-config">{servingRecord.result.rows.map(row => <div key={row.id}><dt>{row.input_bytes.toLocaleString()} / {row.concurrency}× / {row.max_output_tokens} · {row.repetition}</dt><dd>{copy.usageStatus}: {({ complete: copy.usageComplete, partial: copy.usagePartial, missing: copy.usageMissing, invalid: copy.usageInvalid })[row.usage_status]} · {copy.finishReasons}: {row.finish_reasons.join(' / ')}{row.reported_completion_tokens_by_request && <> · {copy.requestOutputTokens}: {row.reported_completion_tokens_by_request.map(value => value.toLocaleString()).join(' / ')}</>}</dd></div>)}</dl>}
            </div></details>}
            {visibleResult && visibleResult.args.length > 0 && <details className="performance-details"><summary>{copy.effectiveArgs}</summary><div className="performance-details-body"><code>{argumentLines(visibleResult.args).join("\n")}</code></div></details>}
            <details className="performance-details"><summary>{copy.metrics}</summary><div className="performance-details-body"><dl className="performance-metric-guide">
              {legacyRecord ? <>
                <div><dt>{copy.ttft}</dt><dd>{copy.ttftHint}</dd></div>
                <div><dt>{copy.tpot}</dt><dd>{copy.tpotHint}</dd></div>
                <div><dt>{copy.pp}</dt><dd>{copy.ppHint}</dd></div>
                <div><dt>{copy.tg}</dt><dd>{copy.tgHint}</dd></div>
                <div><dt>{copy.throughput}</dt><dd>{copy.throughputHint}</dd></div>
                <div><dt>{copy.memory}</dt><dd>{copy.memoryHint}</dd></div>
                <div><dt>{copy.speedup}</dt><dd>{copy.speedupHint}</dd></div>
              </> : <>
                <div><dt>{copy.firstOutput}</dt><dd>{copy.firstOutputHint}</dd></div>
                <div><dt>{copy.outputRate}</dt><dd>{copy.outputRateHint}</dd></div>
                <div><dt>{copy.outputBytes}</dt><dd>{copy.emptyOutputHint}</dd></div>
                <div><dt>{copy.memory}</dt><dd>{copy.servingMemoryHint}</dd></div>
              </>}
            </dl><p>{legacyRecord ? copy.metricsHint : copy.medianHint}</p></div></details>
          </div>
        </section>
        <div className="performance-sharing">
          {selectedRecord && (selectedRecord.schemaVersion === 1 || selectedRecord.result.status === 'complete'
            ? <PublicBenchmarkReview key={selectedRecord.id} record={selectedRecord} busy={busy || otherBenchmark || deleting || !!pendingDelete} copy={copy} onWorkingChange={setSharingBusy} onPublished={() => setSharingRevision(value => value + 1)} />
            : <section className="app-card performance-share-note" aria-labelledby="performance-share-note-title"><h3 id="performance-share-note-title">{copy.publicReview}</h3><p>{copy.servingShareIncomplete}</p></section>)}
          <BenchmarkOwnedList busy={busy || otherBenchmark} copy={copy} revision={sharingRevision} />
        </div>
      </div>
    </div>
    <ConfirmDialog open={!!pendingDelete} title={copy.deleteTitle} confirmLabel={copy.deleteHistory} busy={deleting}
      confirmDisabled={busy || otherBenchmark || exporting || sharingBusy || historyLoading}
      description={<>{pendingDelete && <p><strong>{pendingDelete.schemaVersion === 2 ? benchmarkHistoryModelLabel(pendingDelete) || copy.unavailable : <ModelName model={pendingDelete.model} />}</strong> · {new Date(pendingDelete.createdAt).toLocaleString()}</p>}<p>{copy.deleteHint}</p>{deleteError && <FeedbackBanner tone="error">{copy.deleteError}</FeedbackBanner>}</>}
      onConfirm={() => void deleteSelectedHistory()} onCancel={() => { if (!deleting) setPendingDelete(null); }} />
  </div>;
}
