import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { ActivePanelContext } from "./PanelFeedback";
import { useI18n } from "../i18n/i18n";
import { getTaskSnapshot, useTasks } from "../state/taskRegistry";

const TaskCancellationContext = createContext<{
  localTaskIds: ReadonlySet<string>;
  register: (controlId: string, taskId: string | null) => void;
} | null>(null);
const NO_LOCAL_TASKS: ReadonlySet<string> = new Set();

export function TaskCancellationProvider({ children }: { children: ReactNode }) {
  const [controls, setControls] = useState<Record<string, string>>({});
  const register = useCallback((controlId: string, taskId: string | null) => {
    setControls(current => {
      if ((current[controlId] ?? null) === taskId) return current;
      const next = { ...current };
      if (taskId) next[controlId] = taskId;
      else delete next[controlId];
      return next;
    });
  }, []);
  const value = useMemo(() => ({ localTaskIds: new Set(Object.values(controls)), register }), [controls, register]);
  return <TaskCancellationContext.Provider value={value}>{children}</TaskCancellationContext.Provider>;
}

export function useLocalTaskCancellationIds(): ReadonlySet<string> {
  return useContext(TaskCancellationContext)?.localTaskIds ?? NO_LOCAL_TASKS;
}

/** Keeps global cancellation available until the active panel mounts its control. */
export function LocalTaskCancelButton({ taskId, pending = false, disabled, onClick, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { taskId: string; pending?: boolean }) {
  const { t } = useI18n();
  const tasks = useTasks();
  const cancelling = tasks.some(task => task.id === taskId && task.state === "cancelling");
  const register = useContext(TaskCancellationContext)?.register;
  const active = useContext(ActivePanelContext);
  const controlId = useId();
  useEffect(() => {
    if (!active || !register || (disabled && !pending && !cancelling)) return;
    register(controlId, taskId);
    return () => register(controlId, null);
  }, [active, cancelling, controlId, disabled, pending, register, taskId]);
  return <button type="button" disabled={disabled || cancelling} {...props} onClick={event => {
    if (getTaskSnapshot().some(task => task.id === taskId && task.state === "cancelling")) return;
    onClick?.(event);
  }}>{cancelling && !pending ? t("ui.taskCancelling") : children}</button>;
}
