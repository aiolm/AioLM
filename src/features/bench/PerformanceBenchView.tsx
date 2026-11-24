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
import { runSetupGapMessage } from '../../shared/runtime/runReadiness';
import { normalizeDisplayPath, normalizeDisplayText } from '../../shared/lib/displayPaths';
import { benchmarkHistoryModelLabel } from './performanceRecords';
import { PublicBenchmarkReview } from './PublicBenchmarkReview';
import { BenchmarkOwnedList } from './BenchmarkOwnedList';
import { BenchmarkEnvironment } from './BenchmarkEnvironment';
import { RecordedSettings, ServingResultTable } from './PublicBenchmarkSummary';
import { LocalTaskCancelButton } from '../../shared/ui/TaskCancellation';
import { formatBytes, formatCpuCores } from '../../shared/lib/units';
import BenchmarkExplorerActions from './BenchmarkExplorerActions';
import PanelFeedback, { ActivePanelContext } from '../../shared/ui/PanelFeedback';
import type { usePerformanceBench } from './usePerformanceBench';
import { CONCURRENCIES, CORPORA, OUTPUT_TOKENS, PROMPT_BYTES, TASK_ID, formatInputSize } from './performanceBenchConfig';

const STATUS_TONES = { complete: 'success', partial: 'warning', cancelled: 'neutral', failed: 'danger' } as const;

const startsOption = (token: string | undefined) => token !== undefined && /^--?[a-zA-Z]/.test(token);

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


export function PerformanceBenchView({ controller }: { controller: ReturnType<typeof usePerformanceBench> }) {
  const {
    store, active, setupFormId, locale, copy, explorerCopy, profileImport,
    modelCopy, modelSettings, installedRuntimes, sessionsError, stoppingSessions, promptBytes,
    setPromptBytes, concurrencies, setConcurrencies, corpus, setCorpus, phase,
    progress, rows, record, history, historyOffset,
    historyLoading, historyError, historyWarnings, exporting, exportFormat, setExportFormat,
    exportNotice, setExportNotice, sharingRevision, setSharingRevision, sharingBusy, setSharingBusy,
    pendingDelete, setPendingDelete, deleting, deleteError, setDeleteError, historyNotice,
    setHistoryNotice, selectedHistory, setSelectedHistory, error, setError, storageError,
    copied, copying, device, setAdmissionRevision, resetCopied, busy,
    otherBenchmark, valid, serverRunning, targetDiffers,
    displayedTarget, displayedModel, blockingSessions, setupGaps, admission, canRun,
    total, selectedRecord, localImportUnavailable, previousRecords, exportAllDiffers,
    visibleResult, provenance, selectedGpuLabel, modelHash,
    servingRecord, servingPoints, servingProvenance,
    modelSource, refreshSessions, loadHistory, editModel, stopSessions, cancel,
    run, toggle, statusLabel, progressMessage, copyResults,
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
          : <p className="performance-run-summary">{copy.totalTests}: <strong>{total}</strong>{!setupGaps.length && !admission && <span role="status" className="performance-run-pending"> · {copy.admissionPending}</span>}</p>}
        <p id="performance-validation" className={valid ? "sr-only" : "performance-validation"}>{copy.servingValidation}</p>
      </div>
      {busy ? <LocalTaskCancelButton taskId={TASK_ID} pending={phase === "cancelling"} className="app-button app-button--danger" disabled={phase === "cancelling"} onClick={() => void cancel()}><StableLabel value={phase === "cancelling" ? copy.cancelling : copy.cancel} labels={[copy.cancelling, copy.cancel]} /></LocalTaskCancelButton> : <button type="submit" form={setupFormId} className="app-button app-button--primary" disabled={!canRun} title={setupGaps.length > 0 ? setupGaps.map(gap => runSetupGapMessage(gap, locale)).join(' ') : undefined}>{copy.run}</button>}
    </div>
    {profileImport.importDialog}
    <ActivePanelContext.Provider value={active}><PanelFeedback>
      {profileImport.notice && <FeedbackBanner tone={profileImport.notice.error ? 'error' : 'success'} onDismiss={profileImport.dismissNotice}>{profileImport.notice.text}</FeedbackBanner>}
    </PanelFeedback></ActivePanelContext.Provider>
    {!setupGaps.length && !busy && admission && admission.status !== 'supported' && <FeedbackBanner tone="warning" className="performance-notice"
      action={modelSettings ? { label: copy.admissionConfigure, onClick: () => editModel('runtime') }
        : admission.status === 'unknown' ? { label: modelCopy.retry, onClick: () => setAdmissionRevision(value => value + 1) } : undefined}>
      <span role="status">{admission.status === 'unknown' ? copy.admissionUnknown : copy.admissionRequest}</span>
      {admission.detail && <details><summary>{copy.details}</summary>{normalizeDisplayText(admission.detail)}</details>}
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
            <label className="performance-field"><span>{copy.corpus}</span><CustomSelect ariaLabel={copy.corpus} value={corpus} disabled={busy} onChange={setCorpus} options={CORPORA.map(key => ({ value: key, label: copy[key] }))} /></label>
            <fieldset className="performance-choice">
              <legend>{copy.inputBytes}</legend>
              <div className="performance-chips">{PROMPT_BYTES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={promptBytes.includes(value)} onChange={() => toggle(value, promptBytes, setPromptBytes)} /><span>{formatInputSize(value)}</span></label>)}</div>
            </fieldset>
            <fieldset className="performance-choice" aria-describedby="performance-concurrency-hint">
              <legend>{copy.batchSizes}</legend>
              <div className="performance-chips performance-chips--quad">{CONCURRENCIES.map((value) => <label key={value} className="performance-chip"><input type="checkbox" checked={concurrencies.includes(value)} onChange={() => toggle(value, concurrencies, setConcurrencies)} /><span>{value}×</span></label>)}</div>
              <p id="performance-concurrency-hint" className="performance-hint">{copy.concurrencyHint}</p>
            </fieldset>
            <div className="performance-fixed-workload">
              <dl><div><dt>{copy.outputCap}</dt><dd>{OUTPUT_TOKENS.toLocaleString()}</dd></div></dl>
              <p className="performance-hint">{copy.coldPromptConditions}</p>
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
                options={[{ value: '', label: copy.current }, ...previousRecords.map((item) => ({ value: item.id,
                  label: `${new Date(item.createdAt).toLocaleString()} · ${benchmarkHistoryModelLabel(item) || copy.unavailable} · ${({ complete: copy.complete, partial: copy.partial, cancelled: copy.cancelled, failed: copy.failed })[item.result.status]}`,
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
                    <button type="button" className="app-button app-button--secondary app-button--sm" disabled={profileImport.importing || deleting || localImportUnavailable} aria-describedby={localImportUnavailable ? 'benchmark-import-unavailable' : undefined} onClick={() => void profileImport.importLocal(selectedRecord)}><StableLabel value={profileImport.importing ? explorerCopy.importing : explorerCopy.import} labels={[explorerCopy.importing, explorerCopy.import]} /></button>
                    <button type="button" className="app-button app-button--danger app-button--sm" disabled={busy || otherBenchmark || exporting || historyLoading || deleting || sharingBusy} data-icon="delete" onClick={() => { setDeleteError(false); setHistoryNotice(null); setPendingDelete(selectedRecord); }}><StableLabel value={deleting ? copy.deleting : copy.deleteHistory} labels={[copy.deleting, copy.deleteHistory]} /></button>
                  </div>}
                  {localImportUnavailable && <p id="benchmark-import-unavailable" className="performance-hint">{explorerCopy.unavailableSettings}</p>}
                  {(history.length > 0 || record) && <p className="performance-hint">{copy.localHistoryHint}</p>}
                </div>
              </details>}
            </div>}
          </div>
          {historyLoading && history.length === 0 && !record && <p role="status" className="performance-hint">{copy.historyLoading}</p>}
          {historyLoading && (history.length > 0 || !!record) && <span role="status" className="sr-only">{copy.historyLoading}</span>}
          {selectedRecord && <div className="performance-result-context">
            <strong className="performance-result-model"><ModelIcon model={selectedRecord.model} />{benchmarkHistoryModelLabel(selectedRecord) || copy.unavailable}</strong>
            <div className="performance-result-facts">
              <Badge tone={STATUS_TONES[selectedRecord.result.status]}>{statusLabel}</Badge>
              <span>{copy.method}: {selectedRecord.request.method.id}@{selectedRecord.request.method.version} · {copy[selectedRecord.request.context_profile]}</span>
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
          <ServingResultTable points={servingPoints} copy={copy} />
          {/* Reserve the result space whenever no table shows (idle, running before the first point, or failed), so later sections never jump. */}
          {!servingPoints.length && <div className="app-card performance-results-empty"><EmptyState title={copy.emptyTitle} description={copy.empty} /></div>}
          <div className="app-card app-card--flush performance-disclosures">
            {selectedRecord && <details className="performance-details"><summary>{copy.details}</summary><div className="performance-details-body"><dl className="performance-run-config">
              <div><dt>{copy.corpus}</dt><dd>{copy[selectedRecord.request.context_profile]}</dd></div>
              <div><dt>{copy.inputBytes}</dt><dd>{selectedRecord.request.prompt_bytes.map(formatInputSize).join(" / ")}</dd></div>
              <div><dt>{copy.outputCap}</dt><dd>{selectedRecord.request.max_output_tokens.toLocaleString()}</dd></div>
              <div><dt>{copy.batchSizes}</dt><dd>{selectedRecord.request.concurrencies.map((value) => `${value}×`).join(" / ")}</dd></div>
              <div><dt>{copy.repetitions}</dt><dd>{selectedRecord.request.repetitions}</dd></div>
              <div><dt>{copy.warmup}</dt><dd>{selectedRecord.request.warmup ? copy.enabled : copy.disabled}</dd></div>
              {servingRecord && <><div><dt>{copy.requestUsage}</dt><dd>{(servingProvenance?.workload.request_usage ?? servingRecord.request.request_usage) ? copy.enabled : copy.disabled}</dd></div><div><dt>{copy.cachePolicy}</dt><dd>{servingProvenance ? copy.coldPrompt : copy.unavailable}</dd></div></>}
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
              <div><dt>{copy.processor}</dt><dd>{provenance?.environment?.cpu ? `${normalizeDisplayText(provenance.environment.cpu.name ?? copy.unavailable)} · ${formatCpuCores(provenance.environment.cpu)}` : copy.unavailable}</dd></div>
              <div><dt>{copy.systemMemory}</dt><dd>{typeof provenance?.environment?.system_memory_bytes === 'number' ? formatBytes(provenance.environment.system_memory_bytes) : copy.unavailable}</dd></div>
              <div><dt>{copy.modelHash}</dt><dd>{typeof modelHash === 'string' ? modelHash : copy.unavailable}</dd></div>
            </dl>{servingProvenance && <><p>{copy.hostScope}</p><p>{copy.sourceHint}</p><h3 className="performance-details-heading">{copy.recordedSettings}</h3><RecordedSettings settings={servingProvenance.execution.settings} copy={copy} /></>}
              {servingRecord && <dl className="performance-run-config">{servingRecord.result.rows.map(row => <div key={row.id}><dt>{formatInputSize(row.input_bytes)} / {row.concurrency}× / {row.max_output_tokens} · {row.repetition}</dt><dd>{copy.usageStatus}: {({ complete: copy.usageComplete, partial: copy.usagePartial, missing: copy.usageMissing, invalid: copy.usageInvalid })[row.usage_status]} · {copy.finishReasons}: {row.finish_reasons.join(' / ')}</dd></div>)}</dl>}
            </div></details>}
            {visibleResult && visibleResult.args.length > 0 && <details className="performance-details"><summary>{copy.effectiveArgs}</summary><div className="performance-details-body"><code>{argumentLines(visibleResult.args).join("\n")}</code></div></details>}
            <details className="performance-details"><summary>{copy.metrics}</summary><div className="performance-details-body"><dl className="performance-metric-guide">
              <div><dt>{copy.firstOutput}</dt><dd>{copy.firstOutputHint}</dd></div>
              <div><dt>{copy.prefillRate}</dt><dd>{copy.prefillRateHint}</dd></div>
              <div><dt>{copy.decodeRate}</dt><dd>{copy.decodeRateHint}</dd></div>
              <div><dt>{copy.tpot}</dt><dd>{copy.tpotHint}</dd></div>
              <div><dt>{copy.reportedRate}</dt><dd>{copy.reportedRateHint}</dd></div>
              <div><dt>{copy.outputRate}</dt><dd>{copy.outputRateHint}</dd></div>
              <div><dt>{copy.e2e}</dt><dd>{copy.e2eHint}</dd></div>
              <div><dt>{copy.memory}</dt><dd>{copy.servingMemoryHint}</dd></div>
            </dl><p>{copy.medianHint}</p></div></details>
          </div>
        </section>
        <div className="performance-sharing">
          {selectedRecord && (selectedRecord.result.status === 'complete'
            ? <PublicBenchmarkReview key={selectedRecord.id} record={selectedRecord} busy={busy || otherBenchmark || deleting || !!pendingDelete} copy={copy} onWorkingChange={setSharingBusy} onPublished={() => setSharingRevision(value => value + 1)} />
            : <section className="app-card performance-share-note" aria-labelledby="performance-share-note-title"><h3 id="performance-share-note-title">{copy.publicReview}</h3><p>{copy.servingShareIncomplete}</p></section>)}
          <BenchmarkOwnedList busy={busy || otherBenchmark} copy={copy} revision={sharingRevision} />
        </div>
      </div>
    </div>
    <ConfirmDialog open={!!pendingDelete} title={copy.deleteTitle} confirmLabel={copy.deleteHistory} busy={deleting}
      confirmDisabled={busy || otherBenchmark || exporting || sharingBusy || historyLoading}
      description={<>{pendingDelete && <p><strong>{benchmarkHistoryModelLabel(pendingDelete) || copy.unavailable}</strong> · {new Date(pendingDelete.createdAt).toLocaleString()}</p>}<p>{copy.deleteHint}</p>{deleteError && <FeedbackBanner tone="error">{copy.deleteError}</FeedbackBanner>}</>}
      onConfirm={() => void deleteSelectedHistory()} onCancel={() => { if (!deleting) setPendingDelete(null); }} />
  </div>;
}
