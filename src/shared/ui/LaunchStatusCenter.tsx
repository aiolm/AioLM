import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../api/errors";
import { useI18n } from "../i18n/i18n";
import { normalizeDisplayText } from "../lib/displayPaths";
import {
  dismissTask,
  getTaskSnapshot,
  updateTask,
  useTasks,
  type AppTask,
} from "../state/taskRegistry";
import { activityCenterCopy } from "./activityCenterCopy";
import DiagnosticDetails, { isLongDiagnostic, summarizeDiagnostic } from "./DiagnosticDetails";
import DismissButton from "./DismissButton";
import FeedbackBanner from "./FeedbackBanner";
import ProgressBar from "./ProgressBar";
import StableLabel from "./StableLabel";
import { useLocalTaskCancellationIds } from "./TaskCancellation";
import { headerPopoverStyle, useExclusiveHeaderPopover, useHeaderPopoverPosition } from "./useHeaderPopoverPosition";

function launchStatusLabel(task: AppTask, t: ReturnType<typeof useI18n>["t"]): string {
  if (task.state === "running") return task.phase || t("ui.taskWorking");
  if (task.state === "cancelling") return t("ui.taskCancelling");
  if (task.state === "completed") return t("ui.taskCompleted");
  if (task.state === "cancelled") return t("ui.taskCancelled");
  if (task.state === "crashed") return t("ui.taskCrashed");
  return t("ui.taskFailed");
}

export interface LaunchStatusCenterProps {
  statusLabel?: string;
  statusLabels?: readonly string[];
  statusTone?: "neutral" | "success" | "warning" | "danger";
  serverStarting?: boolean;
}

export default function LaunchStatusCenter({
  statusLabel,
  statusLabels,
  statusTone,
  serverStarting,
}: LaunchStatusCenterProps = {}) {
  const { locale, t } = useI18n();
  const copy = activityCenterCopy(locale);
  const tasks = useTasks().filter((task) => task.kind === "model-launch");
  const localTaskIds = useLocalTaskCancellationIds();
  const [open, setOpen] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const seenFailures = useRef<Set<string>>(new Set());
  const previousTaskCount = useRef(0);

  const active = useMemo(
    () => tasks.filter((task) => task.state === "running" || task.state === "cancelling"),
    [tasks],
  );
  const failures = useMemo(
    () => tasks.filter((task) => task.state === "failed" || task.state === "crashed"),
    [tasks],
  );
  const ordered = useMemo(
    () => [...active, ...tasks.filter((task) => task.state !== "running" && task.state !== "cancelling")],
    [active, tasks],
  );

  useEffect(() => {
    if (tasks.length === 0) {
      if (previousTaskCount.current > 0) {
        setOpen(false);
        setCancelError(null);
      }
      seenFailures.current.clear();
      previousTaskCount.current = 0;
      return;
    }
    previousTaskCount.current = tasks.length;
    const currentKeys = new Set(failures.map((task) => JSON.stringify([task.id, task.startedAt])));
    for (const oldKey of seenFailures.current) {
      if (!currentKeys.has(oldKey)) seenFailures.current.delete(oldKey);
    }
    let hasNewFailure = false;
    for (const key of currentKeys) {
      if (!seenFailures.current.has(key)) {
        seenFailures.current.add(key);
        hasNewFailure = true;
      }
    }
    if (hasNewFailure) setOpen(true);
  }, [failures, tasks.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const position = useHeaderPopoverPosition({
    open,
    triggerRef,
    panelRef: popoverRef,
    preferredWidth: 400,
    align: "start",
  });
  useExclusiveHeaderPopover(popoverId, open, () => setOpen(false));

  const cancelTask = async (task: AppTask) => {
    if (!task.cancel || task.state !== "running") return;
    setCancelError(null);
    updateTask(task.id, { state: "cancelling" });
    try {
      await task.cancel();
    } catch (error) {
      const message = errorMessage(error);
      if (getTaskSnapshot().find((item) => item.id === task.id)?.state === "cancelling") {
        updateTask(task.id, { state: "running" });
      }
      setCancelError(message);
    }
  };

  const triggerText =
    active.length > 0
      ? active.length === 1
        ? copy.launchLoadingSingle
        : copy.launchLoadingMulti(active.length)
      : failures.length > 0
        ? failures.length === 1
          ? copy.launchError
          : `${copy.launchError} (${failures.length})`
        : copy.launchReady;

  const isLoading = active.length > 0 || Boolean(serverStarting);
  const effectiveTone =
    failures.length > 0
      ? "danger"
      : isLoading
        ? "warning"
        : (statusTone ?? "neutral");
  const displayLabel = statusLabel ?? triggerText;
  const displayLabels =
    statusLabels && statusLabels.length > 0
      ? [...statusLabels]
      : statusLabel
        ? [statusLabel]
        : [copy.launchLoadingSingle, copy.launchError, copy.launchReady];
  const triggerTitle =
    ordered[0] && ordered.length === 1
      ? `${copy.launchTitle}: ${normalizeDisplayText(ordered[0].label)} — ${triggerText}`
      : statusLabel
        ? `${copy.launchTitle}: ${statusLabel}`
        : `${copy.launchTitle}: ${triggerText}`;
  const sizingLabels = [...new Set([...displayLabels, displayLabel])];

  return (
    <div className="aiolm-header-center">
      <button
        ref={triggerRef}
        type="button"
        className={`app-button app-button--ghost app-button--sm aiolm-status-trigger aiolm-status app-status-badge app-badge--${effectiveTone}${open ? " is-open" : ""}`}
        title={triggerTitle}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        data-testid="launch-status-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="aiolm-status-stack">
          {sizingLabels.map((label) => (
            <span key={label} className="aiolm-status-sizer" aria-hidden="true">
              <span className="aiolm-status-indicator" />
              <span className="aiolm-status-sizer__text" data-label={label} />
            </span>
          ))}
          <span className="aiolm-status-current">
            <span className="aiolm-status-indicator" aria-hidden="true">
              <span className="app-status-badge__dot" aria-hidden="true" />
            </span>
            <span className="aiolm-status-label">{displayLabel}</span>
          </span>
        </span>
      </button>

      {open && (
        <section
          ref={popoverRef}
          id={popoverId}
          className="aiolm-header-popover"
          aria-label={copy.launchTitle}
          data-testid="launch-status-popover"
          style={headerPopoverStyle(position)}
        >
          <div className="aiolm-header-popover__head">
            <h2 className="aiolm-header-popover__title">{copy.launchTitle}</h2>
            <button
              type="button"
              className="app-icon-button app-icon-button--sm"
              aria-label={copy.closePopover}
              onClick={() => setOpen(false)}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M3 3 9 9M9 3 3 9" />
              </svg>
            </button>
          </div>

          <div className="aiolm-header-popover__body">
            {cancelError && (
              <FeedbackBanner tone="error" onDismiss={() => setCancelError(null)}>
                {cancelError}
              </FeedbackBanner>
            )}

            {ordered.length === 0 ? (
              <p className="aiolm-header-popover__empty">{copy.launchEmpty}</p>
            ) : (
              ordered.map((task) => {
                const activeTask = task.state === "running" || task.state === "cancelling";
                const isFailure = task.state === "failed" || task.state === "crashed";
                const label = normalizeDisplayText(task.label);
                const status = normalizeDisplayText(launchStatusLabel(task, t));
                const detail = task.detail ? normalizeDisplayText(task.detail) : "";
                return (
                  <div
                    key={task.id}
                    className={`aiolm-center-item${isFailure ? " aiolm-center-item--error" : ""}`}
                    data-task-id={task.id}
                    role={!activeTask ? (isFailure ? "alert" : "status") : undefined}
                  >
                    <div className="aiolm-center-item__top">
                      <div className="aiolm-center-item__identity">
                        <span className="aiolm-center-item__name" title={label}>
                          {label}
                        </span>
                        <span className="aiolm-center-item__meta">{status}</span>
                      </div>
                      <div className="aiolm-center-item__actions">
                        {!activeTask && task.state !== "completed" && task.action && (
                          <button
                            type="button"
                            className="app-button app-button--secondary app-button--sm"
                            onClick={() => {
                              setOpen(false);
                              task.action?.onClick();
                            }}
                          >
                            {task.action.label}
                          </button>
                        )}
                        {activeTask && task.cancel && !localTaskIds.has(task.id) && (
                          <button
                            type="button"
                            className="app-button app-button--secondary app-button--sm"
                            disabled={task.state === "cancelling"}
                            onClick={() => void cancelTask(task)}
                          >
                            <StableLabel
                              value={task.state === "cancelling" ? t("ui.taskCancelling") : t("common.cancel")}
                              labels={[t("ui.taskCancelling"), t("common.cancel")]}
                            />
                          </button>
                        )}
                        {!activeTask && (
                          <DismissButton label={`${t("ui.taskDismiss")}: ${label}`} onClick={() => dismissTask(task.id)} />
                        )}
                      </div>
                    </div>
                    {activeTask && <ProgressBar label={`${label}: ${status}`} />}
                    {task.detail &&
                      (isLongDiagnostic(task.detail) ? (
                        <DiagnosticDetails
                          summary={summarizeDiagnostic(task.detail)}
                          detail={task.detail}
                          id={`launch-${task.id}`}
                        />
                      ) : (
                        <p className={isFailure ? "aiolm-center-item__error" : "aiolm-center-item__meta"}>
                          {detail}
                        </p>
                      ))}
                  </div>
                );
              })
            )}
          </div>
        </section>
      )}
    </div>
  );
}
