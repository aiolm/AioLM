import type { Dispatch, RefObject, SetStateAction } from 'react';
import * as api from "../../shared/api/index";
import { IpcError, isIpcErrorKind } from "../../shared/api/ipcError";
import { useI18n } from "../../shared/i18n/i18n";
import {
DEFAULT_SESSION_ID,
notifySessionStatusChanged
} from "../../shared/runtime/sessionUtils";
import { anySessionActivity, sessionHasActivity } from "../../shared/state/sessionActivity";
import type { AppStore } from "../../shared/state/store";
import { finishTask, getTaskSnapshot, registerTask } from "../../shared/state/taskRegistry";
import { prepareSessionProfile } from "../model-settings/prepareSessionProfile";
import { sameData } from './useExecutionStore';
type EditSnapshot = { selectedId: string; editing: api.SessionDefinition | null };
interface SessionLoadOptions {
  store: AppStore; cfg: api.AppConfig | null; t: ReturnType<typeof useI18n>['t'];
  stopExisting: boolean; editing: api.SessionDefinition | null; hasUnsavedChanges: boolean;
  currentEdit: RefObject<EditSnapshot>; currentSelection: RefObject<string>; currentLoad: RefObject<object | null>;
  setBusyId: Dispatch<SetStateAction<string | null>>; setLoadingId: Dispatch<SetStateAction<string | null>>;
  setNotice: Dispatch<SetStateAction<string | null>>; setFailure: Dispatch<SetStateAction<string | null>>;
  setEditing: Dispatch<SetStateAction<api.SessionDefinition | null>>;
  updateStatus: (id: string, update: (current: api.SessionStatus | undefined) => api.SessionStatus | undefined) => void;
  refresh: () => Promise<void>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isMissingSessionFacade(error: unknown): boolean {
  if (error instanceof IpcError) return false;
  const message = errorText(error).toLowerCase();
  return message.includes("unknown command") || message.includes("command not found") || message.includes("session_start") && message.includes("not found");
}
export async function loadSession(definition: api.SessionDefinition, { store, cfg, t, stopExisting, editing, hasUnsavedChanges, currentEdit, currentSelection, currentLoad, setBusyId, setLoadingId, setNotice, setFailure, updateStatus, setEditing, refresh }: SessionLoadOptions) {
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
    updateStatus(runnableDefinition.id, () => ({
      id: runnableDefinition.id,
      name: runnableDefinition.name || runnableDefinition.id,
      state: "starting",
      model: runnableDefinition.models.primary_model,
      mmproj: runnableDefinition.models.mmproj,
      draft_model: runnableDefinition.models.draft_model,
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
          && sameData({ selectedId: runnableDefinition.id, editing: current }, editSnapshot) ? structuredClone(prepared) : current);
      }
      if (getTaskSnapshot().find(task => task.id === taskId)?.state !== 'running') throw new IpcError('cancelled', 'Session load cancelled.');
      const loaded = await api.sessionStart(runnableDefinition.id, launchConfig, stopExisting);
      notifySessionStatusChanged();
      updateStatus(loaded.id, () => loaded);
      finishTask(taskId, "completed");
    } catch (error) {
      const message = errorText(error);
      // Native failures and the local pre-handoff cancellation share a typed kind.
      const cancelled = isIpcErrorKind(error, 'cancelled');
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
}
