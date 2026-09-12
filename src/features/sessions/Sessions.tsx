import StableLabel from "../../shared/ui/StableLabel";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { useI18n } from "../../shared/i18n/i18n";
import ConfirmDialog from "../../shared/ui/ConfirmDialog";
import { modelDisplayName, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { finishTask, registerTask, updateTask } from "../../shared/state/taskRegistry";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import { anySessionActivity, sessionHasActivity } from "../../shared/state/sessionActivity";
import { settingsForSession } from "../../shared/config/executionSettings";
import {
  DEFAULT_SESSION_ID,
  SESSION_STATUS_CHANGED_EVENT,
  cloneGpuPlacement,
  defaultSessionDefinition,
  notifySessionStatusChanged,
  sessionConfig,
  sessionDefinitionFromStatus,
  sessionPort,
  sessionStatusLabel,
} from "../../shared/runtime/sessionUtils";

type PendingNavigation =
  | { kind: "select"; definition: api.SessionDefinition }
  | { kind: "new" };

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

export default function SessionsPanel({ store, active = true }: { store: AppStore; active?: boolean }) {
  const { t, locale } = useI18n();
  const modelSettings = useModelSettings();
  const cfg = store.cfg;
  const [definitions, setDefinitions] = useState<api.SessionDefinition[]>(() => cfg?.sessions ?? []);
  const [statuses, setStatuses] = useState<Record<string, api.SessionStatus>>({});
  const [selectedId, setSelectedId] = useState(DEFAULT_SESSION_ID);
  const [editing, setEditing] = useState<api.SessionDefinition | null>(null);
  const [stopExisting, setStopExisting] = useState(cfg?.stop_existing_sessions_on_load ?? true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const currentEdit = useRef("");
  currentEdit.current = JSON.stringify([selectedId, editing]);
  const saving = useRef(false);
  const legacyState = store.status.state;
  const legacyUrl = store.status.url;
  const legacyModel = store.status.model;
  const legacyMmproj = store.status.mmproj;
  const legacyPid = store.status.pid;
  const legacyActiveRequests = store.status.active_requests;
  const legacyIdleSeconds = store.status.idle_seconds;
  const legacyLogTail = store.status.log_tail;
  const legacyError = store.status.error;

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
        models: { primary_model: status.model ?? "", mmproj: status.mmproj ?? "", draft_model: status.draft_model ?? "" },
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

  const fallbackDefaultStatus = useCallback((): api.SessionStatus => ({
    id: DEFAULT_SESSION_ID,
    name: t("ui.defaultSession"),
    state: legacyState,
    url: legacyUrl,
    port: sessionPort({ url: legacyUrl }, cfg?.port ?? 0),
    model: legacyModel ?? cfg?.active_model,
    mmproj: legacyMmproj ?? cfg?.mmproj,
    draft_model: cfg?.spec_draft_model,
    pid: legacyPid,
    active_requests: legacyActiveRequests,
    idle_seconds: legacyIdleSeconds,
    log_tail: legacyLogTail,
    error: legacyError,
    gpu: cloneGpuPlacement(cfg?.gpu),
  }), [cfg?.active_model, cfg?.gpu, cfg?.mmproj, cfg?.port, cfg?.spec_draft_model, legacyState, legacyUrl, legacyModel, legacyMmproj, legacyPid, legacyActiveRequests, legacyIdleSeconds, legacyLogTail, legacyError, t]);

  const refresh = useCallback(async () => {
    const defaultStatus = fallbackDefaultStatus();
    try {
      const listed = api.normalizeSessionList(await api.sessionList());
      setStatuses(Object.fromEntries([defaultStatus, ...listed].map((status) => [status.id, status])));
    } catch (error) {
      if (!isMissingSessionFacade(error)) setFailure(errorText(error));
      setStatuses((current) => ({ ...current, [DEFAULT_SESSION_ID]: defaultStatus }));
    }
  }, [fallbackDefaultStatus]);


  useEffect(() => {
    if (!cfg) return;
    setDefinitions(cfg.sessions ?? []);
    setStopExisting(cfg.stop_existing_sessions_on_load ?? true);
  }, [cfg, cfg?.sessions, cfg?.stop_existing_sessions_on_load]);

  useEffect(() => {
    if (!active) return;
    let refreshing = false;
    const poll = () => {
      if (refreshing) return;
      refreshing = true;
      void refresh().finally(() => { refreshing = false; });
    };
    poll();
    const interval = window.setInterval(poll, 3000);
    window.addEventListener(SESSION_STATUS_CHANGED_EVENT, poll);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener(SESSION_STATUS_CHANGED_EVENT, poll);
    };
  }, [active, refresh]);

  const persist = async (next: api.SessionDefinition[]) => {
    await store.updateConfig({ sessions: next });
    setDefinitions(next);
  };

  const performSelection = (definition: api.SessionDefinition) => {
    setSelectedId(definition.id);
    setEditing(definition.id === DEFAULT_SESSION_ID ? null : structuredClone(definition));
    setNotice(null);
    setFailure(null);
  };

  const selectDefinition = (definition: api.SessionDefinition) => {
    if (definition.id === selectedId) return;
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
    const trimmed = normalizedEditing.name.trim();
    const latestDefinitions = (store.getConfig?.() ?? cfg)?.sessions ?? definitions;
    const latestDefinition = latestDefinitions.find((definition) => definition.id === normalizedEditing.id);
    const nextDefinition = {
      ...(latestDefinition ?? normalizedEditing),
      name: trimmed || modelLabel(normalizedEditing.models.primary_model, normalizedEditing.id),
      enabled: normalizedEditing.enabled,
    };
    const next = [...latestDefinitions.filter((definition) => definition.id !== nextDefinition.id), nextDefinition];
    try {
      await persist(next);
      if (currentEdit.current === snapshot) {
        setEditing(nextDefinition);
        setNotice(t("ui.sessionSaved"));
      }
    } catch (error) {
      setFailure(errorText(error));
    } finally { saving.current = false; }
  };

  const addDefinition = () => {
    if (!cfg) return;
    const definition = defaultSessionDefinition(cfg);
    setSelectedId(definition.id);
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
    if (!definition.enabled) return;
    if (sessionHasActivity(definition.id) || (stopExisting && anySessionActivity())) {
      setFailure("Stop the active response before loading a model.");
      return;
    }
    const runnableDefinition = definition;
    if (!runnableDefinition.models.primary_model.trim()) {
      setFailure(t("ui.sessionNoModel"));
      return;
    }
    if (!cfg) return;
    const launchConfig = store.getConfig?.() ?? cfg;
    const taskId = `session-load-${runnableDefinition.id}`;
    setBusyId(runnableDefinition.id);
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
        await api.sessionStop(runnableDefinition.id);
      },
    });
    try {
      const loaded = await api.sessionStart(runnableDefinition.id, sessionConfig(launchConfig, runnableDefinition), stopExisting);
      notifySessionStatusChanged();
      setStatuses((current) => ({ ...current, [loaded.id]: loaded }));
      setNotice(t("ui.sessionRunning"));
      finishTask(taskId, "completed");
    } catch (error) {
      const cancelled = errorText(error).toLowerCase().includes("cancel");
      if (cancelled) {
        setNotice(t("ui.taskCancelled"));
        finishTask(taskId, "cancelled");
      } else if (runnableDefinition.id === DEFAULT_SESSION_ID && isMissingSessionFacade(error)) {
        try {
          await store.start(sessionConfig(launchConfig, runnableDefinition));
          notifySessionStatusChanged();
          setNotice(t("ui.sessionRunning"));
          finishTask(taskId, "completed");
        } catch (fallbackError) {
          const message = errorText(fallbackError);
          setFailure(message);
          finishTask(taskId, "failed", message);
        }
      } else {
        const message = errorText(error);
        setFailure(message);
        finishTask(taskId, "failed", message);
      }
    } finally {
      setBusyId(null);
      await refresh();
    }
  };

  const stop = async (id: string, unload = false) => {
    if (sessionHasActivity(id)) {
      setFailure("Stop the active response before unloading its model.");
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
      setNotice(t("ui.sessionStopped"));
    } catch (error) {
      if (id === DEFAULT_SESSION_ID && isMissingSessionFacade(error)) {
        try {
          await store.stop();
          notifySessionStatusChanged();
          setNotice(t("ui.sessionStopped"));
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
    updateTask(`session-load-${id}`, { state: "cancelling", phase: t("ui.taskCancelling") });
    setStatuses((current) => current[id]
      ? { ...current, [id]: { ...current[id], state: "stopping" } }
      : current);
    try {
      await api.sessionStop(id);
      notifySessionStatusChanged();
    } catch (error) {
      setFailure(errorText(error));
    }
  };

  const remove = async (definition: api.SessionDefinition) => {
    if (definition.id === DEFAULT_SESSION_ID) return;
    if (sessionHasActivity(definition.id)) {
      setFailure("Stop the active response before removing its session.");
      return;
    }
    setBusyId(definition.id);
    setNotice(null);
    setFailure(null);
    try {
      await api.sessionUnload(definition.id);
      notifySessionStatusChanged();
      const next = ((store.getConfig?.() ?? cfg)?.sessions ?? definitions).filter((item) => item.id !== definition.id);
      await persist(next);
      setSelectedId(DEFAULT_SESSION_ID);
      setEditing(null);
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
        models: { primary_model: statuses[editing.id].model ?? "", mmproj: statuses[editing.id].mmproj ?? "", draft_model: statuses[editing.id].draft_model ?? "" },
        gpu: cloneGpuPlacement(statuses[editing.id].gpu),
        enabled: true,
      }
    : undefined;
  const savedDefinition = editing?.id === DEFAULT_SESSION_ID ? defaultDefinition : editing ? definitionsById.get(editing.id) ?? liveBaseline : undefined;
  const hasUnsavedChanges = Boolean(editing && JSON.stringify(editing) !== JSON.stringify(savedDefinition));
  const status = statuses[selectedId] ?? (selectedId === DEFAULT_SESSION_ID ? fallbackDefaultStatus() : undefined);
  const openSettings = () => {
    if (!modelSettings || !cfg || !currentDefinition) return;
    const definition = structuredClone(currentDefinition);
    const snapshot = currentEdit.current;
    modelSettings.open({
      target: definition.id === DEFAULT_SESSION_ID ? { kind: "default" } : { kind: "session", sessionId: definition.id },
      definition,
      config: sessionConfig(cfg, definition),
      onApply: (applied) => {
        if (currentEdit.current !== snapshot) return;
        const saved = applied.sessions?.find((item) => item.id === definition.id) ?? settingsForSession(definition, applied);
        if (definition.id !== DEFAULT_SESSION_ID) setDefinitions((current) => [...current.filter((item) => item.id !== saved.id), saved]);
        setEditing(definition.id === DEFAULT_SESSION_ID ? null : structuredClone(saved));
        setNotice(t("ui.sessionSaved"));
        void refresh();
      },
    });
  };

  return (
    <div className="app-page-scroll sessions-panel relative flex h-full min-h-0 min-w-0 flex-col gap-4 p-4 pb-8" data-testid="sessions-panel">
      <section className="rounded-xl border p-4 ui-border-color-border ui-background-panel" >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="app-section-title">{t("ui.sessionsTitle")}</h2>
            <p className="app-section-hint">{t("ui.sessionsIntro")}</p>
          </div>
          <button type="button" className="app-button app-button--primary app-button--sm" onClick={requestNewDefinition} disabled={!cfg}>{t("ui.newSession")}</button>
        </div>
        <label className="mt-4 flex items-start gap-2 text-xs ui-color-muted" >
          <input type="checkbox" checked={stopExisting} onChange={(event) => { const next = event.target.checked; setStopExisting(next); void store.updateConfig({ stop_existing_sessions_on_load: next }).catch((error) => { setStopExisting((store.getConfig?.() ?? cfg)?.stop_existing_sessions_on_load ?? true); setFailure(errorText(error)); }); }} />
          <span><span className="font-medium ui-color-ink" >{t("ui.sessionStopExisting")}</span><span className="block mt-0.5">{t("ui.sessionStopExistingHint")}</span></span>
        </label>
      </section>

      {(notice || failure) && <div className={["rounded-lg border px-3 py-2 text-xs", (failure ? "ui-border-color-error-border" : "ui-border-color-info-border"), (failure ? "ui-background-error-bg" : "ui-background-info-bg"), (failure ? "ui-color-error-ink" : "ui-color-info-ink")].filter(Boolean).join(" ")} role={failure ? "alert" : "status"} >{normalizeDisplayText(failure ?? notice ?? "")}</div>}

      <div className="grid min-h-0 gap-4 app-master-detail">
        <section className="min-w-0 rounded-xl border p-3 ui-border-color-border ui-background-panel"  aria-label={t("ui.sessionsTitle")}>
          <div className="mb-2 px-1 text-xs font-semibold uppercase tracking-[0.16em] ui-color-faint" >{t("ui.sessionsTitle")}</div>
          <div className="space-y-1.5">
            {allDefinitions.map((definition) => {
              const rowStatus = statuses[definition.id] ?? (definition.id === DEFAULT_SESSION_ID ? fallbackDefaultStatus() : undefined);
              const rowState = rowStatus?.state ?? "stopped";
              return (
                <button key={definition.id} type="button" onClick={() => selectDefinition(definition)} className={`session-list-row ${selectedId === definition.id ? "is-selected" : ""}`} aria-pressed={selectedId === definition.id}>
                  <span className="min-w-0 flex-1 text-left"><span className="block app-text-wrap text-sm font-medium">{normalizeDisplayText(definition.name || definition.id)}</span><span className="mt-0.5 block app-text-wrap text-xs ui-color-faint" >{modelLabel(definition.models.primary_model, t("ui.sessionNoModel"))}</span></span>
                  <span className={`session-state session-state--${rowState}`}><StableLabel value={statusCopy(rowState, t)} labels={(["stopped", "starting", "running", "stopping", "failed", "crashed"] as const).map(state => statusCopy(state, t))} /></span>
                </button>
              );
            })}
            {allDefinitions.length === 1 && <div className="px-1 py-3 text-xs ui-color-faint" >{t("ui.sessionEmpty")}</div>}
          </div>
        </section>

        {currentDefinition ? (
          <section className="min-w-0 rounded-xl border p-4 ui-border-color-border ui-background-panel" >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0"><div className="app-eyebrow">{currentDefinition.id === DEFAULT_SESSION_ID ? t("ui.defaultSession") : t("ui.sessionName")}</div><h3 className="mt-1 app-text-wrap text-lg font-semibold ui-color-ink" >{normalizeDisplayText(currentDefinition.name || currentDefinition.id)}</h3></div>
              <div className="flex flex-wrap items-center gap-2 text-xs ui-color-muted" ><span className={`session-state session-state--${status?.state ?? "stopped"}`}>{statusCopy(status?.state ?? "stopped", t)}</span>{status && <span>{t("ui.sessionPortLabel", { port: sessionPort(status, currentDefinition.id === DEFAULT_SESSION_ID ? cfg?.port ?? 0 : 0) || "—" })}</span>}</div>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-3">
              <button type="button" className="app-button app-button--secondary app-button--sm" disabled={!modelSettings || busyId !== null || store.busy} onClick={openSettings}>{modelSettingsCopy[locale].title}</button>
              <p className="min-w-0 app-text-wrap text-xs ui-color-muted">{modelLabel(currentDefinition.models.primary_model, t("ui.sessionNoModel"))} · {currentDefinition.execution?.active_backend ?? cfg?.active_backend ?? "PATH"}{currentDefinition.execution?.active_build || cfg?.active_build ? ` / ${currentDefinition.execution?.active_build ?? cfg?.active_build}` : ""}</p>
            </div>

            {currentDefinition.id !== DEFAULT_SESSION_ID && <div className="mt-3 grid gap-3 app-form-grid"><label className="text-xs ui-color-muted" >{t("ui.sessionName")}<input className="app-input mt-1" value={normalizeDisplayText(currentDefinition.name)} onChange={(event) => updateEditing({ name: event.target.value })} placeholder={t("ui.sessionNamePlaceholder")} /></label><label className="flex items-end gap-2 pb-2 text-xs ui-color-muted" ><input type="checkbox" checked={currentDefinition.enabled} onChange={(event) => updateEditing({ enabled: event.target.checked })} />{t("ui.sessionEnabled")}</label></div>}


            <div className="mt-4 flex flex-wrap items-center gap-2">
              {(currentDefinition.id !== DEFAULT_SESSION_ID || editing?.id === DEFAULT_SESSION_ID) && <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => void saveDefinition()} disabled={busyId !== null}>{t("ui.saveSession")}</button>}
              {busyId === currentDefinition.id ? <button type="button" className="app-button app-button--danger app-button--sm" onClick={() => void cancelLoad(currentDefinition.id)}>{t("common.cancel")}</button> : status?.state === "running" || status?.state === "starting" ? <><button type="button" className="app-button app-button--danger app-button--sm" onClick={() => void stop(currentDefinition.id)} disabled={busyId !== null}>{t("ui.sessionStop")}</button><button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => void stop(currentDefinition.id, true)} disabled={busyId !== null}>{t("ui.sessionUnload")}</button></> : <button type="button" className="app-button app-button--primary app-button--sm" onClick={() => void load(currentDefinition)} disabled={busyId !== null || !currentDefinition.enabled || !currentDefinition.models.primary_model.trim()}>{t("ui.sessionStart")}</button>}
              {currentDefinition.id !== DEFAULT_SESSION_ID && <button type="button" className="app-button app-button--ghost app-button--sm" onClick={() => void remove(currentDefinition)} disabled={busyId !== null}>{t("ui.sessionDelete")}</button>}
              {status?.pid && <span className="ml-auto text-xs ui-color-faint" >{t("ui.sessionPidLabel", { pid: status.pid })}{status.active_requests !== undefined ? ` · ${t("ui.sessionRequestsLabel", { count: status.active_requests })}` : ""}</span>}
            </div>
            {(status?.error || status?.log_tail) && <details className="mt-3 rounded border p-2 text-xs ui-border-color-error-border ui-background-error-bg ui-color-error-ink" ><summary className="cursor-pointer">{t("ui.sessionStatus")}</summary><pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words">{normalizeDisplayText(status.error ?? status.log_tail ?? "")}</pre></details>}
          </section>
        ) : <section className="rounded-xl border p-4 text-sm ui-border-color-border ui-background-panel ui-color-faint" >{t("ui.sessionEmpty")}</section>}
      </div>
      <ConfirmDialog open={pendingNavigation !== null} title={t("ui.gpuUnsaved")} description={t("ui.sessionUnsavedSwitchHint")} confirmLabel={t("ui.undoProfileChanges")} tone="danger" onConfirm={() => { const next = pendingNavigation; setPendingNavigation(null); if (next?.kind === "select") performSelection(next.definition); else if (next?.kind === "new") addDefinition(); }} onCancel={() => setPendingNavigation(null)} />
    </div>
  );
}
