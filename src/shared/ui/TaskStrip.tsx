import { normalizeDisplayText } from "../lib/displayPaths";
import StableLabel from "./StableLabel";
import { useState } from "react";
import { useI18n } from "../i18n/i18n";
import { dismissTask, updateTask, useTasks, type AppTask } from "../state/taskRegistry";
import { useLocalTaskCancellationIds } from "./TaskCancellation";
import { formatBytes, formatDuration, formatSpeedBps } from "../lib/units";
import { estimateRemainingSeconds } from "../lib/transfer";
import Badge from "./Badge";
import ProgressBar from "./ProgressBar";
import DiagnosticDetails, { isLongDiagnostic, summarizeDiagnostic } from "./DiagnosticDetails";
import FeedbackBanner from "./FeedbackBanner";

/**
 * Transfer detail for a task that reports bytes:
 * "1.20 GiB / 4.00 GiB · 88.0 MiB/s · 35s left". `remaining` words the
 * countdown for the current language.
 */
export function transferLabel(task: AppTask, remaining: (time: string) => string): string | null {
  if (task.received === undefined || !task.total || task.total <= 0) return null;
  const moved = `${formatBytes(task.received)} / ${formatBytes(task.total)}`;
  if (!task.speedBps) return moved;
  const seconds = estimateRemainingSeconds(task.received, task.total, task.speedBps);
  const speed = `${moved} · ${formatSpeedBps(task.speedBps)}`;
  return seconds === null ? speed : `${speed} · ${remaining(formatDuration(seconds))}`;
}

function statusLabel(task: AppTask, t: ReturnType<typeof useI18n>["t"]): string {
  if (task.state === "running") return task.phase || t("ui.taskWorking");
  if (task.state === "cancelling") return t("ui.taskCancelling");
  if (task.state === "completed") return t("ui.taskCompleted");
  if (task.state === "cancelled") return t(task.pausable ? "ui.taskPaused" : "ui.taskCancelled");
  if (task.state === "crashed") return t("ui.taskCrashed");
  return t("ui.taskFailed");
}

export default function TaskStrip({ launchesOnly = false }: { launchesOnly?: boolean }) {
  const { t } = useI18n();
  const tasks = useTasks().filter(task => (task.kind === "model-launch") === launchesOnly);
  const localTaskIds = useLocalTaskCancellationIds();
  const [cancelError, setCancelError] = useState<string | null>(null);
  if (tasks.length === 0) return null;
  const active = tasks.filter((task) => task.state === "running" || task.state === "cancelling");
  const ordered = [...active, ...tasks.filter((task) => !active.includes(task))];
  const visible = launchesOnly ? ordered : ordered.slice(0, 4);
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
    <aside className={`app-task-strip${launchesOnly ? " app-task-strip--launches" : ""}`} aria-label={t("ui.taskStripLabel")} data-testid={launchesOnly ? "launch-task-strip" : "task-strip"}>
      <div className="app-task-strip__heading">
        <span className="app-task-strip__title">{t("ui.taskStripTitle")}</span>
        {active.length > 0 && <Badge role="status">{active.length}</Badge>}
      </div>
      {/* One task per row: name, state, progress, transfer or detail, action.
          Columns line up across rows so several tasks read as a table. */}
      <div className="app-task-strip__list">
        {visible.map((task) => {
          const progress = task.total && task.total > 0 && task.received !== undefined
            ? Math.min(100, Math.max(0, task.received / task.total * 100))
            : undefined;
          const activeTask = task.state === "running" || task.state === "cancelling";
          const transfer = transferLabel(task, time => t("ui.timeRemaining", { time }));
          const stopLabel = task.pausable ? t("ui.downloadPause") : t("common.cancel");
          const label = normalizeDisplayText(task.label);
          const status = normalizeDisplayText(statusLabel(task, t));
          const detail = task.detail ? normalizeDisplayText(task.detail) : "";
          return (
            <div key={task.id} className={`app-task-strip__item app-task-strip__item--${task.state}`} data-task-id={task.id} role={launchesOnly && !activeTask ? (task.state === "failed" || task.state === "crashed" ? "alert" : "status") : undefined}>
              <span className="app-task-strip__label" title={label}>{label}</span>
              <span className="app-task-strip__status" title={status}>{status}</span>
              {progress !== undefined || (activeTask && task.kind === "model-launch") ? <ProgressBar className="app-task-strip__progress" label={task.kind === "model-launch" ? `${label}: ${status}` : label} value={progress} /> : <span className="app-task-strip__progress" aria-hidden="true" />}
              <span className="app-task-strip__info">
                {task.detail ? (isLongDiagnostic(task.detail)
                  ? <DiagnosticDetails summary={summarizeDiagnostic(task.detail)} detail={task.detail} id={`task-${task.id}`} />
                  : <span className="app-task-strip__detail" title={detail}>{detail}</span>) : null}
                {activeTask && transfer && <span className="app-task-strip__transfer" data-testid={`task-transfer-${task.id}`} title={transfer}>{transfer}</span>}
              </span>
              <span className="app-task-strip__action">
                {!activeTask && task.state !== "completed" && task.action && <button type="button" className="app-button app-button--secondary app-button--sm" onClick={task.action.onClick}>{task.action.label}</button>}
                {activeTask && task.cancel && !localTaskIds.has(task.id) && <button type="button" className="app-button app-button--secondary app-button--sm" disabled={task.state === "cancelling"} onClick={() => void cancel(task)}><StableLabel value={task.state === "cancelling" ? t("ui.taskCancelling") : stopLabel} labels={[t("ui.taskCancelling"), stopLabel]} /></button>}
                {!activeTask && <button type="button" className="app-button app-button--ghost app-button--sm" aria-label={`${t("ui.taskDismiss")}: ${label}`} onClick={() => dismissTask(task.id)}>{t("ui.taskDismiss")}</button>}
              </span>
            </div>
          );
        })}
      </div>
      {cancelError && <FeedbackBanner tone="error">{cancelError}</FeedbackBanner>}
    </aside>
  );
}
