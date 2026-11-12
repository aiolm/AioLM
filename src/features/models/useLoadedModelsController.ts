import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as api from "../../shared/api/index";
import { IpcError } from "../../shared/api/ipcError";
import { settingsForSession } from "../../shared/config/executionSettings";
import { profileTargetKey } from "../../shared/config/settingsProfiles";
import { useI18n } from "../../shared/i18n/i18n";
import { modelDisplayName } from "../../shared/lib/displayPaths";
import { loadedModelPath } from '../../shared/runtime/loadedModel';
import {
  DEFAULT_SESSION_ID,
  cloneGpuPlacement,
  defaultSessionDefinition,
  notifySessionStatusChanged,
  sessionConfig,
  sessionDefinitionFromStatus,
  sessionPort
} from "../../shared/runtime/sessionUtils";
import { sessionHasActivity } from "../../shared/state/sessionActivity";
import type { AppStore } from "../../shared/state/store";
import { getTaskSnapshot, subscribeTasks, updateTask } from "../../shared/state/taskRegistry";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { loadedModelsCopy } from './loadedModelsCopy';
import { loadSession } from "./sessionLoad";
import { sameData } from './useExecutionStore';
/** One delivery from the library's shared detailed session subscription. */
import type { SessionPoll } from "./LoadedModels";

type PendingNavigation =
  | { kind: "select"; definition: api.SessionDefinition }
  | { kind: "new" }
  | { kind: "close" };
const EMPTY_DEFINITIONS: api.SessionDefinition[] = [];
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSessionFacade(error: unknown): boolean {
  if (error instanceof IpcError) return false;
  const message = errorText(error).toLowerCase();
  return message.includes("unknown command") || message.includes("command not found") || message.includes("session_start") && message.includes("not found");
}
function modelLabel(path: string, empty: string): string {
  if (!path.trim()) return empty;
  return modelDisplayName(path) || empty;
}
export type LoadedModelsProps = { store: AppStore; poll: SessionPoll; refresh: () => Promise<void> };
export function useLoadedModelsController({ store, poll, refresh }: LoadedModelsProps) {
  const { t, locale } = useI18n();
  const copy = loadedModelsCopy[locale];
  const modelSettings = useModelSettings();
  const cfg = store.cfg;
  const definitions = cfg?.sessions ?? EMPTY_DEFINITIONS;
  const [localStatuses, setLocalStatuses] = useState<{ poll: SessionPoll; statuses: Record<string, api.SessionStatus> } | null>(null);
  const latestPoll = useRef(poll);
  latestPoll.current = poll;
  // Only action placeholders are local. A new successful delivery supersedes
  // them; a failed delivery retains named sessions and uses the default fallback.
  if (localStatuses && localStatuses.poll !== poll) {
    setLocalStatuses(poll.error === undefined ? null : {
      poll,
      statuses: Object.fromEntries(Object.entries(localStatuses.statuses).filter(([id]) => id !== DEFAULT_SESSION_ID)),
    });
  }
  const statuses = useMemo(() => {
    const next = Object.fromEntries(poll.sessions.map(status => [status.id, status]));
    if (poll.error !== undefined) delete next[DEFAULT_SESSION_ID];
    if (localStatuses?.poll === poll) Object.assign(next, localStatuses.statuses);
    return next;
  }, [poll, localStatuses]);
  const updateStatus = (id: string, update: (current: api.SessionStatus | undefined) => api.SessionStatus | undefined) => {
    setLocalStatuses(current => {
      const delivery = latestPoll.current;
      const overrides = current?.poll === delivery ? current.statuses : {};
      const next = update(overrides[id] ?? delivery.sessions.find(status => status.id === id));
      return next ? { poll: delivery, statuses: { ...overrides, [id]: next } } : current;
    });
  };
  const [selectedId, setSelectedId] = useState(DEFAULT_SESSION_ID);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [editing, setEditing] = useState<api.SessionDefinition | null>(null);
  const [stopExistingDraft, setStopExistingDraft] = useState<{ value: boolean } | null>(null);
  const stopExisting = stopExistingDraft?.value ?? cfg?.stop_existing_sessions_on_load ?? true;
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);
  const loadCancelling = useSyncExternalStore(subscribeTasks,
    () => loadingId !== null && getTaskSnapshot().some(task => task.id === `session-load-${loadingId}` && task.state === 'cancelling'),
    () => false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const currentEdit = useRef({ selectedId, editing });
  currentEdit.current = { selectedId, editing };
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

  useEffect(() => {
    if (poll.error !== undefined && !isMissingSessionFacade(poll.error)) setFailure(errorText(poll.error));
  }, [poll]);

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
      if (sameData(currentEdit.current, snapshot)) {
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

  const load = (definition: api.SessionDefinition) => loadSession(definition, { store, cfg, t, stopExisting, editing, hasUnsavedChanges, currentEdit, currentSelection, currentLoad, setBusyId, setLoadingId, setNotice, setFailure, updateStatus, setEditing, refresh });
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
    updateStatus(id, current => current ? { ...current, state: "stopping" } : current);
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
      await store.updateConfig(current => {
        const sessions = (current.sessions ?? []).filter(item => item.id !== definition.id);
        const library = current.settings_profiles;
        const key = profileTargetKey(definition.models.primary_model, definition.id);
        if (!library || !Object.prototype.hasOwnProperty.call(library.applied, key)) return { sessions };
        const applied = { ...library.applied };
        delete applied[key];
        return { sessions, settings_profiles: { ...library, applied, revision: library.revision + 1 } };
      });
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
  const editingStatus = editing ? statuses[editing.id] : undefined;
  const liveBaseline = editingStatus
    ? cfg ? sessionDefinitionFromStatus(editingStatus, cfg) : {
        id: editingStatus.id,
        name: editingStatus.name || editingStatus.id,
        models: { primary_model: loadedModelPath(editingStatus), mmproj: editingStatus.mmproj ?? "", draft_model: editingStatus.draft_model ?? "" },
        gpu: cloneGpuPlacement(editingStatus.gpu),
        enabled: true,
      }
    : undefined;
  const savedDefinition = editing?.id === DEFAULT_SESSION_ID ? defaultDefinition : editing ? definitionsById.get(editing.id) ?? liveBaseline : undefined;
  const hasUnsavedChanges = Boolean(editing && !sameData(editing, savedDefinition));
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
        if (sameData(currentEdit.current, snapshot) && definition.id === selectedId) setEditing(definition.id === DEFAULT_SESSION_ID ? null : structuredClone(saved));
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
  return { allDefinitions, t, locale, copy, cfg, definitions, selectedId, setSelectedId, detailsOpen, setDetailsOpen, editing, setEditing, stopExisting, setStopExistingDraft, busyId, loadingId, notice, failure, setFailure, pendingNavigation, setPendingNavigation, definitionsById, performSelection, selectDefinition, saveDefinition, addDefinition, requestNewDefinition, load, stop, cancelLoad, remove, updateEditing, currentDefinition, closeDetails, openSettings, rowFor, controlsDisabled, modelSettings };
}
