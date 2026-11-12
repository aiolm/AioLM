import * as api from "../../shared/api/index";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import {
  DEFAULT_SESSION_ID,
  sessionPort,
  sessionStatusLabel
} from "../../shared/runtime/sessionUtils";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import EmptyState from "../../shared/ui/EmptyState";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import ModelName from '../../shared/ui/ModelName';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import StatusBadge from "../../shared/ui/StatusBadge";
import Switch from "../../shared/ui/Switch";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import RuntimeFailureDetails from './RuntimeFailureDetails';
import "./loaded-models.css";
import { useLoadedModelsController, type LoadedModelsProps } from "./useLoadedModelsController";
/** One delivery from the library's shared detailed session subscription. */
export type SessionPoll = { sessions: api.SessionStatus[]; error?: undefined } | { sessions: api.SessionStatus[]; error: unknown };
const SESSION_STATES = ["stopped", "starting", "running", "stopping", "failed", "crashed"] as const;
function statusTone(state: api.SessionStatus["state"]): "neutral" | "success" | "warning" | "danger" {
  const label = sessionStatusLabel(state);
  if (label === "running") return "success";
  if (label === "starting" || label === "stopping") return "warning";
  return label === "failed" || label === "crashed" ? "danger" : "neutral";
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function statusCopy(state: api.SessionStatus["state"], t: ReturnType<typeof useI18n>["t"]): string {
  const label = sessionStatusLabel(state);
  if (label === "running") return t("ui.sessionRunning");
  if (label === "starting") return t("ui.sessionStarting");
  if (label === "crashed") return t("ui.sessionCrashed");
  if (label === "failed") return t("ui.sessionFailed");
  return label === "stopping" ? t("status.working") : t("ui.sessionStopped");
}
/**
 * Named sessions in the model library: saved ones, the one being edited and
 * any unsaved session that is loading, loaded or failed, each with its own
 * load, stop, cancel, unload and failure details. The default target is
 * controlled from the header and the conversation, so the library does not
 * repeat it as a separate loaded-model list.
 *
 * Status comes from the library's single detailed session subscription, which
 * pauses while the page is hidden; this component adds no polling of its own.
 */
export default function LoadedModels(props: LoadedModelsProps) {
  const { store } = props;
  const { allDefinitions, t, locale, copy, cfg, definitions, selectedId, setSelectedId, detailsOpen, setDetailsOpen, editing, setEditing, stopExisting, setStopExistingDraft, busyId, loadingId, notice, failure, setFailure, pendingNavigation, setPendingNavigation, definitionsById, performSelection, selectDefinition, saveDefinition, addDefinition, requestNewDefinition, load, stop, cancelLoad, remove, updateEditing, closeDetails, openSettings, rowFor, controlsDisabled, modelSettings } = useLoadedModelsController(props);
  const settingsButton = (definition: api.SessionDefinition) =>
    // Opening settings only reads; the apply itself is what has to wait for a
    // transition, and it says so, so a loading or stopping model stays inspectable.
    <button type="button" className="app-button app-button--secondary app-button--sm" disabled={!modelSettings} data-icon="settings" onClick={() => openSettings(definition)}>{modelSettingsCopy[locale].title}</button>;
  const lifecycleButton = (definition: api.SessionDefinition, state: api.SessionStatus["state"], rowDefinition: api.SessionDefinition) =>
    (loadingId === definition.id || state === "starting") && state !== "stopping"
      ? <LocalTaskCancelButton taskId={`session-load-${definition.id}`} className="app-button app-button--secondary app-button--sm" onClick={() => void cancelLoad(definition.id)} disabled={busyId !== null && busyId !== definition.id}>{t("common.cancel")}</LocalTaskCancelButton>
      : state === "running"
        ? <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="stop" onClick={() => void stop(definition.id)} disabled={controlsDisabled}>{t("ui.sessionStop")}</button>
        : <button type="button" className="app-button app-button--secondary app-button--sm" data-icon="play" onClick={() => void load(rowDefinition)} disabled={controlsDisabled || state === "stopping" || !rowDefinition.models.primary_model.trim()} title={!rowDefinition.models.primary_model.trim() ? t("ui.sessionNoModel") : undefined}>{state === "stopping" ? t("status.working") : t("ui.sessionStart")}</button>;
  const rowSummary = (name: string, model: string) =>
    <span className="min-w-0"><span className="block app-text-wrap text-sm font-medium">{name}</span><span className="mt-0.5 block app-text-wrap text-xs ui-color-muted"><ModelIcon model={model} /><ModelName model={model} empty={t("ui.sessionNoModel")} /></span></span>;
  const rowName = (definition: api.SessionDefinition) => normalizeDisplayText(definition.name || (definitionsById.has(definition.id) ? definition.id : t("ui.newSession")));

  // Saved sessions, the one being edited, and a named session that is live
  // without being saved, so every loaded or failed named session keeps its
  // controls here.
  const sessionDefinitions = allDefinitions.filter(definition => definition.id !== DEFAULT_SESSION_ID
    && (definitionsById.has(definition.id) || editing?.id === definition.id || rowFor(definition).state !== "stopped"));

  return (
    <section className="loaded-models" aria-label={copy.saved} data-testid="loaded-models">
      {(notice || failure) && <FeedbackBanner tone={failure ? "error" : "info"}>{normalizeDisplayText(failure ?? notice ?? "")}</FeedbackBanner>}
      <details className="loaded-models-saved">
        <summary><span>{copy.saved}</span> <span className="models-list-count">{definitions.length}</span></summary>
        <div className="loaded-models-saved-content">
          <div className="loaded-models-saved-heading">
            <p className="text-xs ui-color-muted">{t("ui.sessionsIntro")}</p>
            <button type="button" className="app-button app-button--secondary app-button--sm" onClick={requestNewDefinition} disabled={!cfg || busyId !== null}>{t("ui.newSession")}</button>
          </div>
          {sessionDefinitions.length === 0
            ? <EmptyState title={copy.savedEmpty} description={t("ui.sessionEmpty")} />
            : <div className="app-card app-card--tight sessions-list" role="group" aria-label={copy.saved}>
              {sessionDefinitions.map((definition) => {
                const { status, state, rowDefinition, model, runtimeConfig } = rowFor(definition);
                const expanded = detailsOpen && selectedId === definition.id;
                const name = rowName(definition);
                const failed = state === "failed" || state === "crashed";
                return (
                  <article key={definition.id} className={`app-list-row session-entry${expanded ? " is-selected" : ""}`} aria-label={name}>
                    <div className="session-entry-main">
                      <button type="button" className="app-list-row__action session-entry-name" onClick={() => expanded ? closeDetails() : selectDefinition(definition)} aria-expanded={expanded} aria-controls={expanded ? `session-details-${definition.id}` : undefined} title={copy.sessionDetails}>
                        <span className="session-entry-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                        {rowSummary(name, model)}
                      </button>
                      <StatusBadge tone={statusTone(state)} label={statusCopy(state, t)} labels={SESSION_STATES.map(item => statusCopy(item, t))} />
                      <span className="session-entry-runtime"><RuntimeSelectionLabel config={runtimeConfig} /></span>
                      <div className="session-entry-actions">
                        {settingsButton(definition)}
                        {lifecycleButton(definition, state, rowDefinition)}
                      </div>
                    </div>
                    {(status?.error || failed && status?.log_tail) && <FeedbackBanner tone="error" className="session-entry-error"><RuntimeFailureDetails error={status.error} log={failed ? status.log_tail : undefined} /></FeedbackBanner>}
                    {expanded && <div id={`session-details-${definition.id}`} className="session-entry-details">
                      <ModelBadges mode="detail" model={model} localPath={model} />
                      {status && state !== "stopped" && <div className="session-entry-diagnostics text-xs ui-color-muted">
                        <span>{t("ui.sessionPortLabel", { port: sessionPort(status) || "—" })}</span>
                        {status.pid && <span>{t("ui.sessionPidLabel", { pid: status.pid })}</span>}
                        {status.active_requests !== undefined && <span>{t("ui.sessionRequestsLabel", { count: status.active_requests })}</span>}
                      </div>}
                      {!failed && state !== "stopped" && <pre tabIndex={0} role="region" aria-label={t("ui.diagnosticsTitle")} className="session-entry-log">{normalizeDisplayText(status?.log_tail || t("ui.noDiagnostics"))}</pre>}
                      <div className="grid gap-3 app-form-grid">
                        <label className="text-xs ui-color-muted">{t("ui.sessionName")}<input className="app-input mt-1" value={normalizeDisplayText(rowDefinition.name)} onChange={(event) => updateEditing({ name: event.target.value })} placeholder={t("ui.sessionNamePlaceholder")} /></label>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="app-button app-button--primary app-button--sm" onClick={() => void saveDefinition()} disabled={controlsDisabled}>{t("ui.saveSession")}</button>
                        {state === "running" && <button type="button" className="app-button app-button--ghost app-button--sm" data-icon="stop" onClick={() => void stop(definition.id, true)} disabled={controlsDisabled}>{t("ui.sessionUnload")}</button>}
                        <button type="button" className="app-button app-button--ghost app-button--sm ml-auto" data-icon="delete" onClick={() => void remove(rowDefinition)} disabled={controlsDisabled}>{t("ui.sessionDelete")}</button>
                      </div>
                    </div>}
                  </article>
                );
              })}
            </div>}
          {/* A single switch that changes what Load does for every session. */}
          <div className="loaded-models-option text-xs ui-color-muted">
            <span className="loaded-models-option-title">{copy.options}</span>
            <Switch id="sessions-stop-existing" checked={stopExisting} disabled={busyId !== null || store.busy} onChange={(next) => {
              const draft = { value: next };
              setStopExistingDraft(draft);
              void store.updateConfig({ stop_existing_sessions_on_load: next })
                .catch(error => setFailure(errorText(error)))
                .finally(() => setStopExistingDraft(current => current === draft ? null : current));
            }} />
            <label htmlFor="sessions-stop-existing">{t("ui.sessionStopExisting")}</label>
          </div>
        </div>
      </details>
      <ConfirmDialog open={pendingNavigation !== null} title={t("ui.gpuUnsaved")} description={t("ui.sessionUnsavedSwitchHint")} confirmLabel={t("ui.undoProfileChanges")} tone="danger" onConfirm={() => {
        const next = pendingNavigation;
        setPendingNavigation(null);
        if (next?.kind === "select") performSelection(next.definition);
        else if (next?.kind === "new") addDefinition();
        else if (next?.kind === "close") {
          setEditing(null);
          setSelectedId(DEFAULT_SESSION_ID);
          setDetailsOpen(false);
        }
      }} onCancel={() => setPendingNavigation(null)} />
    </section>
  );
}
