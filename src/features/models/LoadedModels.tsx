import ModelName from '../../shared/ui/ModelName';
import ModelBadges from '../../shared/ui/ModelBadges';
import ModelIcon from '../../shared/ui/ModelIcon';
import StatusBadge from "../../shared/ui/StatusBadge";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import EmptyState from "../../shared/ui/EmptyState";
import Switch from "../../shared/ui/Switch";
import "./loaded-models.css";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { useI18n } from "../../shared/i18n/i18n";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { modelDisplayName, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { finishTask, getTaskSnapshot, registerTask, subscribeTasks, updateTask } from "../../shared/state/taskRegistry";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import { prepareSessionProfile } from "../model-settings/prepareSessionProfile";
import { anySessionActivity, sessionHasActivity } from "../../shared/state/sessionActivity";
import { settingsForSession } from "../../shared/config/executionSettings";
import { profileTargetKey } from "../../shared/config/settingsProfiles";
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import RuntimeFailureDetails from './RuntimeFailureDetails';
import { loadedModelsCopy } from './loadedModelsCopy';
import {
  DEFAULT_SESSION_ID,
  cloneGpuPlacement,
  defaultSessionDefinition,
  notifySessionStatusChanged,
  sessionConfig,
  sessionDefinitionFromStatus,
  sessionPort,
  sessionStatusLabel,
} from "../../shared/runtime/sessionUtils";

/** One delivery from the library's shared detailed session subscription. */
export type SessionPoll = { sessions: api.SessionStatus[]; error?: undefined } | { sessions: api.SessionStatus[]; error: unknown };

type PendingNavigation =
  | { kind: "select"; definition: api.SessionDefinition }
  | { kind: "new" }
  | { kind: "close" };

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

function isMissingSessionFacade(error: unknown): boolean {
  const message = errorText(error).toLowerCase();
  return message.includes("unknown command") || message.includes("command not found") || message.includes("session_start") && message.includes("not found");
}

function statusCopy(state: api.SessionStatus["state"], t: ReturnType<typeof useI18n>["t"]): string {
  const label = sessionStatusLabel(state);
  if (label === "running") return t("ui.sessionRunning");
  if (label === "starting") return t("ui.sessionStarting");
  if (label === "crashed") return t("ui.sessionCrashed");
  if (label === "failed") return t("ui.sessionFailed");
  return label === "stopping" ? t("status.working") : t("ui.sessionStopped");
}

function modelLabel(path: string, empty: string): string {
  if (!path.trim()) return empty;
  return modelDisplayName(path) || empty;
}

/**
 * Loaded, loading and failed models — the default target and every named
 * session, including sessions that are not saved and models outside the
 * scanned folder — with their own stop, unload, cancel and retry actions.
 * Saved-session creation and editing stay in a collapsed secondary area.
 *
 * Status comes from the library's single detailed session subscription, which
 * pauses while the page is hidden; this component adds no polling of its own.
 */
export default function LoadedModels({ store, poll, refresh }: { store: AppStore; poll: SessionPoll; refresh: () => Promise<void> }) {
  const { t, locale } = useI18n();
  const copy = loadedModelsCopy[locale];
  const modelSettings = useModelSettings();
  const cfg = store.cfg;
  const [definitions, setDefinitions] = useState<api.SessionDefinition[]>(() => cfg?.sessions ?? []);
  const [statuses, setStatuses] = useState<Record<string, api.SessionStatus>>({});
  const [selectedId, setSelectedId] = useState(DEFAULT_SESSION_ID);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editing, setEditing] = useState<api.SessionDefinition | null>(null);
  const [stopExisting, setStopExisting] = useState(cfg?.stop_existing_sessions_on_load ?? true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const loadCancelling = useSyncExternalStore(subscribeTasks,
    () => loadingId !== null && getTaskSnapshot().some(task => task.id === `session-load-${loadingId}` && task.state === 'cancelling'),
    () => false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const currentEdit = useRef("");
  currentEdit.current = JSON.stringify([selectedId, editing]);
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const currentLoad = useRef<object | null>(null);
  const saving = useRef(false);
  const legacyState = store.status.state;
  const legacyUrl = store.status.url;
  const legacyModel = loadedModelPath(store.status);
  const legacyMmproj = store.status.mmproj;
  const legacyPid = store.status.pid;
  const legacyActiveRequests = store.status.active_requests;
  const legacyIdleSeconds = store.status.idle_seconds;
  const legacyLogTail = store.status.log_tail;
  const legacyError = store.status.error;
  const legacyExecution = store.status.execution;
  const legacyEngine = store.status.engine;

  const defaultDefinition = useMemo(() => {
    const current = cfg ?? ({ active_model: "", mmproj: "", spec_draft_model: "", gpu: undefined } as api.AppConfig);
    return {
      ...defaultSessionDefinition(current),
      id: DEFAULT_SESSION_ID,
      name: t("ui.defaultSession"),
    };
  }, [cfg, t]);

  const definitionsById = useMemo(() => new Map(definitions.map((definition) => [definition.id, definition])), [definitions]);
  const allDefinitions = useMemo(() => {
    const knownIds = new Set([DEFAULT_SESSION_ID, ...definitions.map((definition) => definition.id), ...(editing ? [editing.id] : [])]);
    const liveDefinitions = Object.values(statuses)
      .filter((status) => !knownIds.has(status.id))
      .map((status): api.SessionDefinition => cfg ? sessionDefinitionFromStatus(status, cfg) : ({
        id: status.id,
        name: status.name || status.id,
        models: { primary_model: loadedModelPath(status), mmproj: status.mmproj ?? "", draft_model: status.draft_model ?? "" },
        gpu: cloneGpuPlacement(status.gpu),
        enabled: true,
      }));
    return [
      defaultDefinition,
      ...definitions.filter((definition) => definition.id !== DEFAULT_SESSION_ID),
      ...(editing && editing.id !== DEFAULT_SESSION_ID && !definitions.some((definition) => definition.id === editing.id) ? [editing] : []),
      ...liveDefinitions,
    ];
  }, [cfg, defaultDefinition, definitions, editing, statuses]);

  // Without a polled default entry the default row follows the app store's
  // own status, so it stays current where the session list is unavailable.
  const fallbackDefaultStatus = useCallback((): api.SessionStatus => ({
    id: DEFAULT_SESSION_ID,
    name: t("ui.defaultSession"),
    state: legacyState,
    url: legacyUrl,
    port: sessionPort({ url: legacyUrl }),
    model: legacyModel ?? cfg?.active_model,
    mmproj: legacyMmproj ?? cfg?.mmproj,
    draft_model: cfg?.spec_draft_model,
    pid: legacyPid,
    active_requests: legacyActiveRequests,
    idle_seconds: legacyIdleSeconds,
    log_tail: legacyLogTail,
    error: legacyError,
    gpu: cloneGpuPlacement(cfg?.gpu),
    // The loaded runtime, not a selection saved after the launch.
    execution: legacyExecution,
    engine: legacyEngine,
  }), [cfg?.active_model, cfg?.gpu, cfg?.mmproj, cfg?.spec_draft_model, legacyState, legacyUrl, legacyModel, legacyMmproj, legacyPid, legacyActiveRequests, legacyIdleSeconds, legacyLogTail, legacyError, legacyExecution, legacyEngine, t]);

  // Each poll replaces the previous snapshot, including the local placeholders
  // set while a load or cancellation was in flight.
  useEffect(() => {
    if (poll.error !== undefined) {
      if (!isMissingSessionFacade(poll.error)) setFailure(errorText(poll.error));
      setStatuses(current => {
        const next = { ...current };
        delete next[DEFAULT_SESSION_ID];
        return next;
      });
      return;
    }
    setStatuses(Object.fromEntries(poll.sessions.map((status) => [status.id, status])));
  }, [poll]);

  useEffect(() => {
    if (!cfg) return;
    setDefinitions(cfg.sessions ?? []);
    setStopExisting(cfg.stop_existing_sessions_on_load ?? true);
  }, [cfg, cfg?.sessions, cfg?.stop_existing_sessions_on_load]);

  const performSelection = (definition: api.SessionDefinition) => {
    setSelectedId(definition.id);
    setDetailsOpen(true);
    setEditing(definition.id === DEFAULT_SESSION_ID ? null : structuredClone(definition));
    setNotice(null);
    setFailure(null);
  };

  const selectDefinition = (definition: api.SessionDefinition) => {
    if (definition.id === selectedId) {
      setDetailsOpen(true);
      return;
    }
    if (hasUnsavedChanges) {
      setPendingNavigation({ kind: "select", definition });
      return;
    }
    performSelection(definition);
  };

  const saveDefinition = async () => {
    if (!editing || editing.id === DEFAULT_SESSION_ID || saving.current) return;
    const normalizedEditing = editing;
    const snapshot = currentEdit.current;
    saving.current = true;
    setSavingId(editing.id);
    const trimmed = normalizedEditing.name.trim();
    try {
      const saved = await store.updateConfig(current => {
        const latestDefinitions = current.sessions ?? [];
        const latestDefinition = latestDefinitions.find((definition) => definition.id === normalizedEditing.id);
        const nextDefinition = {
          ...(latestDefinition ?? normalizedEditing),
          name: trimmed || modelLabel(normalizedEditing.models.primary_model, normalizedEditing.id),
        };
        return { sessions: [...latestDefinitions.filter((definition) => definition.id !== nextDefinition.id), nextDefinition] };
      });
      setDefinitions(saved.sessions ?? []);
      if (currentEdit.current === snapshot) {
        setEditing(saved.sessions?.find((definition) => definition.id === normalizedEditing.id) ?? null);
        setNotice(t("ui.sessionSaved"));
      }
    } catch (error) {
      setFailure(errorText(error));
    } finally { saving.current = false; setSavingId(null); }
  };

  const addDefinition = () => {
    if (!cfg) return;
    const definition = defaultSessionDefinition(cfg);
    setSelectedId(definition.id);
    setDetailsOpen(true);
    setEditing(definition);
    setNotice(null);
    setFailure(null);
  };

  const requestNewDefinition = () => {
    if (hasUnsavedChanges) {
      setPendingNavigation({ kind: "new" });
      return;
    }
    addDefinition();
  };

  const load = async (definition: api.SessionDefinition) => {
    if (sessionHasActivity(definition.id) || (stopExisting && anySessionActivity())) {
      setFailure(t("ui.sessionActiveResponseLoad"));
      return;
    }
    const runnableDefinition = definition;
    if (!runnableDefinition.models.primary_model.trim()) {
      setFailure(t("ui.sessionNoModel"));
      return;
    }
    if (!cfg) return;
    const editSnapshot = currentEdit.current;
    const cleanEditor = editing?.id === runnableDefinition.id && !hasUnsavedChanges;
    let launchConfig = store.getConfig?.() ?? cfg;
    const loadOperation = {};
    currentLoad.current = loadOperation;
    const taskId = `session-load-${runnableDefinition.id}`;
    setBusyId(runnableDefinition.id);
    setLoadingId(runnableDefinition.id);
    setNotice(null);
    setFailure(null);
    setStatuses((current) => ({
      ...current,
      [runnableDefinition.id]: {
        id: runnableDefinition.id,
        name: runnableDefinition.name || runnableDefinition.id,
        state: "starting",
        model: runnableDefinition.models.primary_model,
        mmproj: runnableDefinition.models.mmproj,
        draft_model: runnableDefinition.models.draft_model,
      },
    }));
    registerTask({
      id: taskId,
      kind: "other",
      label: `${t("ui.sessionStart")}: ${runnableDefinition.name || runnableDefinition.id}`,
      phase: t("ui.sessionStarting"),
      interruptible: true,
      cancel: async () => {
        if (currentLoad.current !== loadOperation) return;
        try { await api.sessionStop(runnableDefinition.id); }
        catch (error) { if (currentLoad.current === loadOperation) throw error; }
      },
    });
    try {
      launchConfig = await prepareSessionProfile(store, runnableDefinition);
      // Profile preparation persists resolved execution settings. Keep an untouched
      // editor aligned with that save, while retaining user edits and later selections.
      if (cleanEditor) {
        const prepared = (store.getConfig?.() ?? store.cfg)?.sessions?.find(item => item.id === runnableDefinition.id);
        if (prepared) setEditing(current => currentSelection.current === runnableDefinition.id
          && JSON.stringify([runnableDefinition.id, current]) === editSnapshot ? structuredClone(prepared) : current);
      }
      if (getTaskSnapshot().find(task => task.id === taskId)?.state !== 'running') throw new Error('Session load cancelled.');
      const loaded = await api.sessionStart(runnableDefinition.id, launchConfig, stopExisting);
      notifySessionStatusChanged();
      setStatuses((current) => ({ ...current, [loaded.id]: loaded }));
      finishTask(taskId, "completed");
    } catch (error) {
      const message = errorText(error);
      // Preparation normalizes an acknowledged native launch cancellation.
      // The local sentinel covers cancellation before the native hand-off.
      const cancelled = message === 'Session load cancelled.' || message === 'server start cancelled';
      if (cancelled) {
        setNotice(t("ui.taskCancelled"));
        finishTask(taskId, "cancelled");
      } else if (runnableDefinition.id === DEFAULT_SESSION_ID && isMissingSessionFacade(error)) {
        try {
          await store.start(launchConfig);
          notifySessionStatusChanged();
          finishTask(taskId, "completed");
        } catch (fallbackError) {
          const message = errorText(fallbackError);
          setFailure(message);
          finishTask(taskId, "failed", message);
        }
      } else {
        setFailure(message);
        finishTask(taskId, "failed", message);
      }
    } finally {
      if (currentLoad.current === loadOperation) currentLoad.current = null;
      setBusyId(null);
      setLoadingId(null);
      await refresh();
    }
  };

  const stop = async (id: string, unload = false) => {
    if (sessionHasActivity(id)) {
      setFailure(t("ui.sessionActiveResponseUnload"));
      return;
    }
    setBusyId(id);
    setNotice(null);
    setFailure(null);
    try {
      if (unload) await api.sessionUnload(id);
      else await api.sessionStop(id);
      notifySessionStatusChanged();
      if (id === DEFAULT_SESSION_ID) await store.refreshStatus();
    } catch (error) {
      if (id === DEFAULT_SESSION_ID && isMissingSessionFacade(error)) {
        try {
          await store.stop();
          notifySessionStatusChanged();
        } catch (fallbackError) {
          setFailure(errorText(fallbackError));
        }
      } else {
        setFailure(errorText(error));
      }
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const cancelLoad = async (id: string) => {
    const loadOperation = currentLoad.current;
    updateTask(`session-load-${id}`, { state: "cancelling", phase: t("ui.taskCancelling") });
    setStatuses((current) => current[id]
      ? { ...current, [id]: { ...current[id], state: "stopping" } }
      : current);
    try {
      await api.sessionStop(id);
      if (currentLoad.current !== loadOperation) return;
      notifySessionStatusChanged();
    } catch (error) {
      if (currentLoad.current === loadOperation) setFailure(errorText(error));
    }
  };

  const remove = async (definition: api.SessionDefinition) => {
    if (definition.id === DEFAULT_SESSION_ID) return;
    if (sessionHasActivity(definition.id)) {
      setFailure(t("ui.sessionActiveResponseRemove"));
      return;
    }
    setBusyId(definition.id);
    setNotice(null);
    setFailure(null);
    try {
      await api.sessionUnload(definition.id);
      notifySessionStatusChanged();
      const saved = await store.updateConfig(current => {
        const sessions = (current.sessions ?? []).filter(item => item.id !== definition.id);
        const library = current.settings_profiles;
        const key = profileTargetKey(definition.models.primary_model, definition.id);
        if (!library || !Object.prototype.hasOwnProperty.call(library.applied, key)) return { sessions };
        const applied = { ...library.applied };
        delete applied[key];
        return { sessions, settings_profiles: { ...library, applied, revision: library.revision + 1 } };
      });
      setDefinitions(saved.sessions ?? []);
      if (currentSelection.current === definition.id) {
        setSelectedId(DEFAULT_SESSION_ID);
        setDetailsOpen(false);
        setEditing(null);
      }
      setNotice(t("ui.sessionDeleted"));
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const updateEditing = (patch: Partial<api.SessionDefinition>) => setEditing((current) => current ? { ...current, ...patch } : current);
  const currentDefinition = editing ?? (selectedId === DEFAULT_SESSION_ID ? defaultDefinition : definitionsById.get(selectedId));
  const liveBaseline = editing && statuses[editing.id]
    ? cfg ? sessionDefinitionFromStatus(statuses[editing.id], cfg) : {
        id: statuses[editing.id].id,
        name: statuses[editing.id].name || statuses[editing.id].id,
        models: { primary_model: loadedModelPath(statuses[editing.id]), mmproj: statuses[editing.id].mmproj ?? "", draft_model: statuses[editing.id].draft_model ?? "" },
        gpu: cloneGpuPlacement(statuses[editing.id].gpu),
        enabled: true,
      }
    : undefined;
  const savedDefinition = editing?.id === DEFAULT_SESSION_ID ? defaultDefinition : editing ? definitionsById.get(editing.id) ?? liveBaseline : undefined;
  const hasUnsavedChanges = Boolean(editing && JSON.stringify(editing) !== JSON.stringify(savedDefinition));
  const closeDetails = () => {
    if (hasUnsavedChanges) {
      setPendingNavigation({ kind: "close" });
      return;
    }
    setDetailsOpen(false);
    setEditing(null);
    setSelectedId(DEFAULT_SESSION_ID);
  };
  const openSettings = (target: api.SessionDefinition) => {
    if (!modelSettings || !cfg) return;
    const definition = structuredClone(target.id === selectedId && currentDefinition ? currentDefinition : target);
    const snapshot = currentEdit.current;
    modelSettings.open({
      target: definition.id === DEFAULT_SESSION_ID ? { kind: "default" } : { kind: "session", sessionId: definition.id },
      definition,
      ...(definition.id !== DEFAULT_SESSION_ID ? { config: sessionConfig(cfg, definition) } : {}),
      onApply: (applied) => {
        const saved = applied.sessions?.find((item) => item.id === definition.id) ?? settingsForSession(definition, applied);
        if (definition.id !== DEFAULT_SESSION_ID) setDefinitions((current) => [...current.filter((item) => item.id !== saved.id), saved]);
        if (currentEdit.current === snapshot && definition.id === selectedId) setEditing(definition.id === DEFAULT_SESSION_ID ? null : structuredClone(saved));
        setNotice(t("ui.sessionSaved"));
        void refresh();
      },
    });
  };

  // Polled state, kept as the local load or cancellation while that is in
  // flight: preparation can precede creation of the native session, and a
  // stopped poll must not erase it.
  const rowFor = (definition: api.SessionDefinition) => {
    const status = statuses[definition.id] ?? (definition.id === DEFAULT_SESSION_ID ? fallbackDefaultStatus() : undefined);
    const polledState = status?.state ?? "stopped";
    const state = loadingId === definition.id && (polledState === 'stopped' || loadCancelling && polledState === 'starting')
      ? loadCancelling ? 'stopping' : 'starting' : polledState;
    const rowDefinition = selectedId === definition.id && currentDefinition ? currentDefinition : definition;
    const live = state === "running" || state === "starting" || state === "stopping";
    const model = live ? loadedModelPath(status, rowDefinition.models.primary_model) : rowDefinition.models.primary_model;
    const runtime = live ? status?.execution ?? rowDefinition.execution : rowDefinition.execution;
    const runtimeConfig = { ...cfg, ...runtime, ...(live && status?.engine
      ? { active_provider: status.engine.provider, active_runtime: status.engine.runtime_id } : {}) };
    return { status, state, rowDefinition, model, runtimeConfig };
  };
  const controlsDisabled = busyId !== null || savingId !== null || store.busy;
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
    <span className="min-w-0"><span className="block app-text-wrap text-sm font-medium">{name}</span><span className="mt-0.5 block app-text-wrap text-xs ui-color-muted"><ModelIcon model={model} /><ModelName model={model} empty={t("ui.sessionNoModel")} /></span><ModelBadges mode="compact" model={model} localPath={model} /></span>;
  const rowName = (definition: api.SessionDefinition) => normalizeDisplayText(definition.name || (definitionsById.has(definition.id) ? definition.id : t("ui.newSession")));

  // A stopped default with nothing reported is not a resource; named sessions
  // appear while loading, loaded, stopping or failed, saved or not.
  const liveDefinitions = allDefinitions.filter(definition => rowFor(definition).state !== "stopped");
  const savedDefinitions = allDefinitions.filter(definition => definition.id !== DEFAULT_SESSION_ID
    && (definitionsById.has(definition.id) || editing?.id === definition.id));

  return (
    <section className="loaded-models" aria-labelledby="loaded-models-heading" data-testid="loaded-models">
      <div className="models-list-heading"><h2 id="loaded-models-heading">{t("ui.loadedModels")}</h2><span className="models-list-count">{liveDefinitions.length}</span></div>
      {(notice || failure) && <FeedbackBanner tone={failure ? "error" : "info"}>{normalizeDisplayText(failure ?? notice ?? "")}</FeedbackBanner>}
      {liveDefinitions.length === 0
        ? <p className="loaded-models-empty">{copy.empty}</p>
        : <div className="app-card app-card--tight sessions-list" role="group" aria-label={t("ui.loadedModels")}>
          {liveDefinitions.map((definition) => {
            const { status, state, rowDefinition, model, runtimeConfig } = rowFor(definition);
            const name = rowName(definition);
            const failed = state === "failed" || state === "crashed";
            return (
              <article key={definition.id} className="app-list-row session-entry" aria-label={name}>
                <div className="session-entry-main">
                  <div className="session-entry-name">{rowSummary(name, model)}</div>
                  <StatusBadge tone={statusTone(state)} label={statusCopy(state, t)} labels={SESSION_STATES.map(item => statusCopy(item, t))} />
                  <div className="session-entry-actions">
                    {settingsButton(definition)}
                    {lifecycleButton(definition, state, rowDefinition)}
                  </div>
                </div>
                {(status?.error || failed && status?.log_tail) && <FeedbackBanner tone="error" className="session-entry-error"><RuntimeFailureDetails error={status.error} log={failed ? status.log_tail : undefined} /></FeedbackBanner>}
                <details className="session-entry-disclosure">
                  <summary>{copy.details}</summary>
                  <div className="session-entry-details">
                    <div className="session-entry-diagnostics text-xs ui-color-muted">
                      <span><RuntimeSelectionLabel config={runtimeConfig} /></span>
                      {status && <span>{t("ui.sessionPortLabel", { port: sessionPort(status) || "—" })}</span>}
                      {status?.pid && <span>{t("ui.sessionPidLabel", { pid: status.pid })}</span>}
                      {status?.active_requests !== undefined && <span>{t("ui.sessionRequestsLabel", { count: status.active_requests })}</span>}
                    </div>
                    {!failed && <pre tabIndex={0} role="region" aria-label={t("ui.diagnosticsTitle")} className="session-entry-log">{normalizeDisplayText(status?.log_tail || t("ui.noDiagnostics"))}</pre>}
                    {definition.id !== DEFAULT_SESSION_ID && state === "running" && <div className="flex flex-wrap items-center gap-2">
                      <button type="button" className="app-button app-button--ghost app-button--sm" data-icon="stop" onClick={() => void stop(definition.id, true)} disabled={controlsDisabled}>{t("ui.sessionUnload")}</button>
                    </div>}
                  </div>
                </details>
              </article>
            );
          })}
        </div>}

      {/* Advanced: saved sessions with their own engine, profile and GPU
          assignment. Collapsed so the loaded models above stay the main view. */}
      <details className="loaded-models-saved">
        <summary><span>{copy.saved}</span> <span className="models-list-count">{definitions.length}</span></summary>
        <div className="loaded-models-saved-content">
          <div className="loaded-models-saved-heading">
            <p className="text-xs ui-color-muted">{t("ui.sessionsIntro")}</p>
            <button type="button" className="app-button app-button--secondary app-button--sm" onClick={requestNewDefinition} disabled={!cfg || busyId !== null}>{t("ui.newSession")}</button>
          </div>
          {savedDefinitions.length === 0
            ? <EmptyState title={copy.savedEmpty} description={t("ui.sessionEmpty")} />
            : <div className="app-card app-card--tight sessions-list" role="group" aria-label={copy.saved}>
              {savedDefinitions.map((definition) => {
                const { state, rowDefinition, model, runtimeConfig } = rowFor(definition);
                const expanded = detailsOpen && selectedId === definition.id;
                const name = rowName(definition);
                return (
                  <article key={definition.id} className={`app-list-row session-entry${expanded ? " is-selected" : ""}`} aria-label={name}>
                    <div className="session-entry-main">
                      <button type="button" className="app-list-row__action session-entry-name" onClick={() => expanded ? closeDetails() : selectDefinition(definition)} aria-expanded={expanded} aria-controls={expanded ? `session-details-${definition.id}` : undefined} title={copy.sessionDetails}>
                        <span className="session-entry-chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
                        {rowSummary(name, model)}
                      </button>
                      <StatusBadge tone={statusTone(state)} label={statusCopy(state, t)} labels={SESSION_STATES.map(item => statusCopy(item, t))} />
                      <div className="session-entry-actions">
                        {settingsButton(definition)}
                        {/* Lifecycle actions for a session that is loading, loaded or
                            failed live in the loaded list above, once per session. */}
                        {state === "stopped" && lifecycleButton(definition, state, rowDefinition)}
                      </div>
                    </div>
                    {expanded && <div id={`session-details-${definition.id}`} className="session-entry-details">
                      <div className="grid gap-3 app-form-grid">
                        <label className="text-xs ui-color-muted">{t("ui.sessionName")}<input className="app-input mt-1" value={normalizeDisplayText(rowDefinition.name)} onChange={(event) => updateEditing({ name: event.target.value })} placeholder={t("ui.sessionNamePlaceholder")} /></label>
                      </div>
                      <div className="session-entry-diagnostics text-xs ui-color-muted"><span><RuntimeSelectionLabel config={runtimeConfig} /></span></div>
                      <div className="flex flex-wrap items-center gap-2">
                        <button type="button" className="app-button app-button--primary app-button--sm" onClick={() => void saveDefinition()} disabled={controlsDisabled}>{t("ui.saveSession")}</button>
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
            <Switch id="sessions-stop-existing" checked={stopExisting} disabled={busyId !== null || store.busy} onChange={(next) => { setStopExisting(next); void store.updateConfig({ stop_existing_sessions_on_load: next }).catch((error) => { setStopExisting((store.getConfig?.() ?? cfg)?.stop_existing_sessions_on_load ?? true); setFailure(errorText(error)); }); }} />
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
