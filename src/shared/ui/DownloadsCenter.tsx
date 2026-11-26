import { useEffect, useId, useMemo, useRef, useState } from "react";
import { shouldConfirmDestructive } from "../config/preferences";
import { useI18n } from "../i18n/i18n";
import { formatModelLabel, normalizeDisplayText } from "../lib/displayPaths";

/** Model downloads name the model once, without split-part suffixes or local paths; other tasks keep their titles. */
const taskName = (task: { kind: string; label: string }) =>
  task.kind === "model-download" ? formatModelLabel(task.label) : normalizeDisplayText(task.label);
import { formatBytes } from "../lib/units";
import { isDownloadTaskActive } from "../state/modelDownloadTask";
import {
  clearPendingDownloadsError,
  discardPendingDownload,
  dismissCompletedDownload,
  findActiveDownloadForPending,
  pauseDownloadTask,
  refreshPendingDownloads,
  resumePendingDownload,
  usePendingDownloadsStore,
} from "../state/pendingDownloadsStore";
import { dismissTask, useDownloadCenterTasks, type AppTask } from "../state/taskRegistry";
import type { PendingDownload } from "../api/types";
import { activityCenterCopy } from "./activityCenterCopy";
import ConfirmDialog from "./ConfirmDialog";
import DiagnosticDetails, { isLongDiagnostic, summarizeDiagnostic } from "./DiagnosticDetails";
import DismissButton from "./DismissButton";
import FeedbackBanner from "./FeedbackBanner";
import ProgressBar from "./ProgressBar";
import StableLabel from "./StableLabel";
import { formatTaskPhase, transferLabel } from "./TaskStrip";
import { headerPopoverStyle, useExclusiveHeaderPopover, useHeaderPopoverPosition } from "./useHeaderPopoverPosition";

function downloadTaskPercent(task: AppTask): number | undefined {
  if (!task.total || task.total <= 0 || task.received === undefined) return undefined;
  return Math.min(100, Math.max(0, (task.received / task.total) * 100));
}

function pendingPercent(entry: PendingDownload): number | undefined {
  if (entry.total <= 0) return undefined;
  return Math.min(100, Math.max(0, (entry.received / entry.total) * 100));
}

export default function DownloadsCenter({
  onConfigureModel,
}: {
  onConfigureModel?: (record: { path: string; projector?: boolean }) => void;
}) {
  const { locale, t } = useI18n();
  const copy = activityCenterCopy(locale);
  const downloads = useDownloadCenterTasks();
  const pendingStore = usePendingDownloadsStore();
  const [open, setOpen] = useState(false);
  const [pendingDiscard, setPendingDiscard] = useState<PendingDownload | null>(null);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const previousActiveIds = useRef<Set<string>>(new Set());
  const seenFailures = useRef<Set<string>>(new Set());

  useEffect(() => {
    void refreshPendingDownloads();
  }, []);

  const active = useMemo(
    () => downloads.filter(isDownloadTaskActive),
    [downloads],
  );
  const failed = useMemo(
    () => downloads.filter((task) => task.state === "failed" || task.state === "crashed"),
    [downloads],
  );
  const completedTasks = useMemo(
    () => downloads.filter((task) => task.state === "completed"),
    [downloads],
  );

  // When any active model download finishes or pauses from elsewhere in the app,
  // resync interrupted transfers so paused rows appear immediately.
  useEffect(() => {
    const nextIds = new Set(
      active.filter((task) => task.kind === "model-download").map((task) => task.id),
    );
    let ended = false;
    for (const prevId of previousActiveIds.current) {
      if (!nextIds.has(prevId)) {
        ended = true;
        break;
      }
    }
    previousActiveIds.current = nextIds;
    if (ended) void refreshPendingDownloads({ force: true });
  }, [active]);

  const paused = useMemo(
    () =>
      pendingStore.entries.filter(
        (entry) =>
          !pendingStore.resumingIds.has(entry.id) &&
          !findActiveDownloadForPending(entry, active),
      ),
    [pendingStore.entries, pendingStore.resumingIds, active],
  );

  const visibleCompleted = useMemo(() => {
    const activeLabels = new Set(active.map((item) => item.label));
    return pendingStore.completed.filter((record) => !activeLabels.has(record.label));
  }, [active, pendingStore.completed]);

  const unmatchedCompletedTasks = useMemo(() => {
    const recordLabels = new Set(visibleCompleted.map((item) => item.label));
    return completedTasks.filter((task) => !recordLabels.has(task.label));
  }, [completedTasks, visibleCompleted]);

  const totalItems =
    active.length +
    paused.length +
    failed.length +
    visibleCompleted.length +
    unmatchedCompletedTasks.length;

  useEffect(() => {
    const currentFailureKeys = new Set(
      failed.map((task) => JSON.stringify([task.id, task.startedAt])),
    );
    for (const oldKey of seenFailures.current) {
      if (!currentFailureKeys.has(oldKey)) seenFailures.current.delete(oldKey);
    }
    let hasNewFailure = false;
    for (const key of currentFailureKeys) {
      if (!seenFailures.current.has(key)) {
        seenFailures.current.add(key);
        hasNewFailure = true;
      }
    }
    if (hasNewFailure) setOpen(true);
  }, [failed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (pendingDiscard) return;
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (triggerRef.current?.contains(target) || popoverRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || pendingDiscard) return;
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
  }, [open, pendingDiscard]);

  const position = useHeaderPopoverPosition({
    open,
    triggerRef,
    panelRef: popoverRef,
    preferredWidth: 420,
  });
  useExclusiveHeaderPopover(popoverId, open, () => setOpen(false));

  const knownTotals = active.filter((task) => (task.total ?? 0) > 0 && task.received !== undefined);
  const aggregateTotal = knownTotals.reduce((sum, task) => sum + (task.total ?? 0), 0);
  const aggregateReceived = knownTotals.reduce(
    (sum, task) => sum + Math.min(task.received ?? 0, task.total ?? 0),
    0,
  );
  const aggregatePercent =
    aggregateTotal > 0
      ? Math.min(100, Math.max(0, (aggregateReceived / aggregateTotal) * 100))
      : undefined;

  const summaryParts: string[] = [];
  if (active.length > 0) {
    summaryParts.push(
      aggregatePercent !== undefined
        ? `${copy.activeCount(active.length)} (${Math.round(aggregatePercent)}%)`
        : copy.activeCount(active.length),
    );
  }
  if (paused.length > 0) summaryParts.push(copy.pausedCount(paused.length));
  if (failed.length > 0 || pendingStore.error) {
    summaryParts.push(`${failed.length || 1} ${copy.failedSection}`);
  }
  const triggerAriaLabel =
    summaryParts.length > 0 ? `${copy.downloadsTitle}: ${summaryParts.join(", ")}` : copy.downloadsTitle;

  const completedCount = visibleCompleted.length + unmatchedCompletedTasks.length;
  const badgeCount =
    failed.length > 0
      ? failed.length
      : active.length > 0
        ? active.length
        : paused.length > 0
          ? paused.length
          : 0;
  const hasErrorBadge = failed.length > 0 || Boolean(pendingStore.error);
  const hasReadyDot = badgeCount === 0 && !hasErrorBadge && completedCount > 0;

  const requestDiscard = (entry: PendingDownload) => {
    if (shouldConfirmDestructive()) {
      setPendingDiscard(entry);
      return;
    }
    void discardPendingDownload(entry.id);
  };

  return (
    <div className="aiolm-header-center">
      <button
        ref={triggerRef}
        type="button"
        className={`app-icon-button aiolm-header-icon-btn${active.length > 0 ? " is-active" : ""}${hasErrorBadge ? " is-error" : ""}${totalItems > 0 ? " has-items" : ""}`}
        aria-label={triggerAriaLabel}
        title={triggerAriaLabel}
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        data-testid="downloads-center-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <svg
          aria-hidden="true"
          width="16"
          height="16"
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 3.5v9M6.5 9 10 12.5 13.5 9M4 16h12" />
        </svg>
        {(badgeCount > 0 || hasErrorBadge) ? (
          <span
            className={`aiolm-header-icon-badge${hasErrorBadge ? " is-error" : active.length > 0 ? " is-accent" : ""}`}
            data-testid="downloads-center-badge"
            aria-hidden="true"
          >
            {hasErrorBadge && badgeCount === 0 ? "!" : badgeCount > 9 ? "9+" : badgeCount}
          </span>
        ) : (
          hasReadyDot && <span className="aiolm-header-icon-dot" aria-hidden="true" />
        )}
      </button>

      {open && (
        <section
          ref={popoverRef}
          id={popoverId}
          className="aiolm-header-popover"
          aria-label={copy.downloadsTitle}
          data-testid="downloads-center-popover"
          style={headerPopoverStyle(position)}
        >
          <div className="aiolm-header-popover__head">
            <h2 className="aiolm-header-popover__title">{copy.downloadsTitle}</h2>
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
            {pendingStore.error && (
              <FeedbackBanner tone="error" onDismiss={clearPendingDownloadsError}>
                {pendingStore.error}
              </FeedbackBanner>
            )}

            {totalItems === 0 && !pendingStore.refreshing && (
              <p className="aiolm-header-popover__empty">{copy.emptyDownloads}</p>
            )}

            {active.length > 0 && (
              <div className="aiolm-center-group">
                <h3 className="aiolm-center-group__title">{copy.activeSection}</h3>
                {active.map((task) => {
                  const pct = downloadTaskPercent(task);
                  const transfer = transferLabel(task, (time) => t("ui.timeRemaining", { time }));
                  const displayLabel = taskName(task);
                  const meta = task.repoId || (task.detail ? normalizeDisplayText(task.detail) : "");
                  const stopLabel = task.pausable ? t("ui.downloadPause") : t("common.cancel");
                  return (
                    <div
                      key={task.id}
                      className="aiolm-center-item"
                      data-testid="download-center-active-row"
                      data-task-id={task.id}
                    >
                      <div className="aiolm-center-item__top">
                        <div className="aiolm-center-item__identity">
                          <span className="aiolm-center-item__name" title={displayLabel}>
                            {displayLabel}
                          </span>
                          {meta && (
                            <span className="aiolm-center-item__meta">{meta}</span>
                          )}
                        </div>
                        {task.cancel && (
                          <button
                            type="button"
                            className="app-button app-button--secondary app-button--sm"
                            disabled={task.state === "cancelling"}
                            onClick={() => void pauseDownloadTask(task)}
                          >
                            <StableLabel
                              value={task.state === "cancelling" ? t("ui.taskCancelling") : stopLabel}
                              labels={[t("ui.taskCancelling"), stopLabel]}
                            />
                          </button>
                        )}
                      </div>
                      <ProgressBar label={displayLabel} value={pct} />
                      <div className="aiolm-center-item__foot">
                        <span>{task.state === "cancelling" ? t("ui.taskCancelling") : formatTaskPhase(task.phase, t)}</span>
                        {transfer && <span className="app-mono">{transfer}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            {paused.length > 0 && (
              <div className="aiolm-center-group">
                <h3 className="aiolm-center-group__title">{copy.pausedSection}</h3>
                {paused.map((entry) => {
                  const pct = pendingPercent(entry);
                  const busy = pendingStore.discardingIds.has(entry.id) || pendingStore.resumingIds.has(entry.id);
                  const name = formatModelLabel(entry.label || entry.repo_id);
                  return (
                    <div
                      key={entry.id}
                      className="aiolm-center-item"
                      data-testid="download-center-paused-row"
                      data-pending-id={entry.id}
                    >
                      <div className="aiolm-center-item__top">
                        <div className="aiolm-center-item__identity">
                          <span className="aiolm-center-item__name" title={name}>
                            {name}
                          </span>
                          <span className="aiolm-center-item__meta">
                            {entry.repo_id} · {formatBytes(entry.received)} / {formatBytes(entry.total)}
                          </span>
                        </div>
                        <div className="aiolm-center-item__actions">
                          <button
                            type="button"
                            className="app-button app-button--secondary app-button--sm"
                            data-icon="download"
                            disabled={busy}
                            aria-label={`${t("ui.pendingResume")}: ${name}`}
                            onClick={() => void resumePendingDownload(entry)}
                          >
                            {t("ui.pendingResume")}
                          </button>
                          <button
                            type="button"
                            className="app-button app-button--ghost app-button--sm"
                            aria-label={`${t("ui.pendingDiscard")}: ${name}`}
                            disabled={busy}
                            onClick={() => requestDiscard(entry)}
                          >
                            {t("ui.pendingDiscard")}
                          </button>
                        </div>
                      </div>
                      {pct !== undefined && <ProgressBar label={name} value={pct} />}
                    </div>
                  );
                })}
              </div>
            )}

            {failed.length > 0 && (
              <div className="aiolm-center-group">
                <h3 className="aiolm-center-group__title">{copy.failedSection}</h3>
                {failed.map((task) => {
                  const name = taskName(task);
                  const detail = task.detail ? normalizeDisplayText(task.detail) : "";
                  return (
                    <div
                      key={task.id}
                      className="aiolm-center-item aiolm-center-item--error"
                      data-testid="download-center-failed-row"
                      role="alert"
                    >
                      <div className="aiolm-center-item__top">
                        <span className="aiolm-center-item__name" title={name}>
                          {name}
                        </span>
                        <DismissButton label={`${t("ui.taskDismiss")}: ${name}`} onClick={() => dismissTask(task.id)} />
                      </div>
                      {task.detail &&
                        (isLongDiagnostic(task.detail) ? (
                          <DiagnosticDetails
                            summary={summarizeDiagnostic(task.detail)}
                            detail={task.detail}
                            id={`dl-fail-${task.id}`}
                          />
                        ) : (
                          <p className="aiolm-center-item__error">{detail}</p>
                        ))}
                    </div>
                  );
                })}
              </div>
            )}

            {(visibleCompleted.length > 0 || unmatchedCompletedTasks.length > 0) && (
              <div className="aiolm-center-group">
                <h3 className="aiolm-center-group__title">{copy.completedSection}</h3>
                {visibleCompleted.map((record) => (
                  <div
                    key={record.id}
                    className="aiolm-center-item"
                    data-testid="download-center-completed-row"
                  >
                    <div className="aiolm-center-item__top">
                      <div className="aiolm-center-item__identity">
                        <span className="aiolm-center-item__name">
                          {formatModelLabel(record.label)}
                        </span>
                        <span className="aiolm-center-item__meta">{record.repoId}</span>
                      </div>
                      <div className="aiolm-center-item__actions">
                        {onConfigureModel && record.path && (
                          <button
                            type="button"
                            className="app-button app-button--secondary app-button--sm"
                            onClick={() => {
                              setOpen(false);
                              onConfigureModel({ path: record.path, projector: record.projector });
                            }}
                          >
                            {copy.configureAction}
                          </button>
                        )}
                        <DismissButton
                          label={`${t("ui.taskDismiss")}: ${formatModelLabel(record.label)}`}
                          onClick={() => dismissCompletedDownload(record.id)}
                        />
                      </div>
                    </div>
                  </div>
                ))}
                {unmatchedCompletedTasks.map((task) => {
                  const name = taskName(task);
                  return (
                    <div
                      key={task.id}
                      className="aiolm-center-item"
                      data-testid="download-center-completed-row"
                    >
                      <div className="aiolm-center-item__top">
                        <span className="aiolm-center-item__name">{name}</span>
                        <DismissButton label={`${t("ui.taskDismiss")}: ${name}`} onClick={() => dismissTask(task.id)} />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>
      )}

      <ConfirmDialog
        open={pendingDiscard !== null}
        title={t("ui.pendingDiscardTitle")}
        description={t("ui.pendingDiscardBody", {
          file: formatModelLabel(pendingDiscard?.label ?? ""),
        })}
        confirmLabel={t("ui.pendingDiscard")}
        cancelLabel={t("common.cancel")}
        confirmIcon="delete"
        tone="danger"
        onCancel={() => setPendingDiscard(null)}
        onConfirm={() => {
          const entry = pendingDiscard;
          setPendingDiscard(null);
          if (entry) void discardPendingDownload(entry.id);
        }}
      />
    </div>
  );
}
