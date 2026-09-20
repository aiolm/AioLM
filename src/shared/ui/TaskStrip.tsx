import { normalizeDisplayText } from "../lib/displayPaths";
import StableLabel from "./StableLabel";
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { dismissTask, updateTask, useTasks, type AppTask } from "../state/taskRegistry";
import { useLocalTaskCancellationIds } from "./TaskCancellation";
import { formatBytes, formatSpeedBps } from "../lib/transfer";

function hasPanelCancellation(task: AppTask): boolean {
  return (task.kind === "runtime" && task.id === "runtime-operation")
    || (task.kind === "benchmark" && task.id === "performance-benchmark-active")
    || (task.kind === "other" && /^session-load-.+/.test(task.id));
}

/** Transfer detail for a task that reports bytes: "1.2 GB / 4.0 GB · 88 MB/s". */
export function transferLabel(task: AppTask): string | null {
  if (task.received === undefined || !task.total || task.total <= 0) return null;
  const moved = `${formatBytes(task.received)} / ${formatBytes(task.total)}`;
  return task.speedBps ? `${moved} · ${formatSpeedBps(task.speedBps)}` : moved;
}

function statusLabel(task: AppTask, t: ReturnType<typeof useI18n>["t"]): string {
  if (task.state === "running") return task.phase || t("ui.taskWorking");
  if (task.state === "cancelling") return t("ui.taskCancelling");
  if (task.state === "completed") return t("ui.taskCompleted");
  if (task.state === "cancelled") return t("ui.taskCancelled");
  if (task.state === "crashed") return t("ui.taskCrashed");
  return t("ui.taskFailed");
}

export default function TaskStrip() {
  const { t } = useI18n();
  const tasks = useTasks();
  const localTaskIds = useLocalTaskCancellationIds();
  const [cancelError, setCancelError] = useState<string | null>(null);
  if (tasks.length === 0) return null;
  const active = tasks.filter((task) => task.state === "running" || task.state === "cancelling");
  const visible = [...active, ...tasks.filter((task) => !active.includes(task))].slice(0, 4);
  const cancel = async (task: AppTask) => {
    if (!task.cancel || task.state !== "running") return;
    setCancelError(null);
    updateTask(task.id, { state: "cancelling" });
    try {
      await task.cancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateTask(task.id, { state: "failed", detail: message });
      setCancelError(message);
    }
  };
  return (
    <aside className="app-task-strip" aria-label={t("ui.taskStripLabel")} data-testid="task-strip">
      <div className="app-task-strip__heading">
        <span className="app-task-strip__title">{t("ui.taskStripTitle")}</span>
        {active.length > 0 && <span className="app-task-strip__count" role="status">{active.length}</span>}
      </div>
      <div className="app-task-strip__list">
        {visible.map((task) => {
          const progress = task.total && task.total > 0 && task.received !== undefined
            ? Math.min(100, Math.max(0, task.received / task.total * 100))
            : undefined;
          const activeTask = task.state === "running" || task.state === "cancelling";
          const transfer = transferLabel(task);
          return (
            <div key={task.id} className={`app-task-strip__item app-task-strip__item--${task.state}`} data-task-id={task.id}>
              <div className="app-task-strip__copy">
                <span className="app-task-strip__label">{normalizeDisplayText(task.label)}</span>
                <span className="app-task-strip__status">{normalizeDisplayText(statusLabel(task, t))}{task.detail ? ` · ${normalizeDisplayText(task.detail)}` : ""}</span>
                {activeTask && transfer && <span className="app-task-strip__transfer" data-testid={`task-transfer-${task.id}`}>{transfer}</span>}
              </div>
              {progress !== undefined && <div className="app-task-strip__progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-label={normalizeDisplayText(task.label)}><span style={{ width: `${progress}%` }} /></div>}
              {activeTask && task.cancel && !(hasPanelCancellation(task) && localTaskIds.has(task.id)) && <button type="button" className="app-task-strip__cancel" disabled={task.state === "cancelling"} onClick={() => void cancel(task)}><StableLabel value={task.state === "cancelling" ? t("ui.taskCancelling") : t("common.cancel")} labels={[t("ui.taskCancelling"), t("common.cancel")]} /></button>}
              {!activeTask && <button type="button" className="app-task-strip__cancel" aria-label={`${t("ui.taskDismiss")}: ${normalizeDisplayText(task.label)}`} onClick={() => dismissTask(task.id)}>{t("ui.taskDismiss")}</button>}
            </div>
          );
        })}
      </div>
      {cancelError && <span className="app-task-strip__error" role="alert">{normalizeDisplayText(cancelError)}</span>}
    </aside>
  );
}
