import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";
import { isDownloadCenterTask, useTasks } from "../state/taskRegistry";
import { activityCenterCopy } from "./activityCenterCopy";
import { usePanelFeedbackSummary } from "./PanelFeedback";
import { headerPopoverStyle, useExclusiveHeaderPopover, useHeaderPopoverPosition } from "./useHeaderPopoverPosition";

const EMPTY_KEYS: readonly string[] = [];

export default function ActivityCenter({
  hasActivity,
  title,
  attentionMessage,
  globalError,
  globalAttentionKeys = EMPTY_KEYS,
  children,
}: {
  hasActivity: boolean;
  title: string;
  attentionMessage: string;
  globalError: boolean;
  globalAttentionKeys?: readonly string[];
  children: ReactNode;
}) {
  const { locale } = useI18n();
  const copy = activityCenterCopy(locale);
  const tasks = useTasks().filter(
    (task) => task.kind !== "model-launch" && !isDownloadCenterTask(task),
  );
  const failures = useMemo(
    () => tasks.filter((task) => task.state === "failed" || task.state === "crashed"),
    [tasks],
  );
  const activeCount = useMemo(
    () => tasks.filter((task) => task.state === "running" || task.state === "cancelling").length,
    [tasks],
  );
  const { count: noticeCount, attention: noticeAttention, attentionSignatures } = usePanelFeedbackSummary();
  const hasProblems = globalError || failures.length > 0 || noticeAttention > 0;
  const badgeCount =
    activeCount + failures.length + noticeCount + (globalError && noticeCount === 0 ? 1 : 0);
  const hasItems = tasks.length > 0 || hasActivity || noticeCount > 0;

  const combinedAttentionKeys = useMemo(
    () => [
      ...failures.map((task) => JSON.stringify([task.id, task.startedAt])),
      ...globalAttentionKeys,
      ...attentionSignatures,
    ],
    [failures, globalAttentionKeys, attentionSignatures],
  );

  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const seen = useRef({ count: 0, attention: 0 });
  const seenAttentionKeys = useRef(new Set<string>());
  const previousHasItems = useRef(false);

  useEffect(() => {
    const newFailure = combinedAttentionKeys.some((key) => !seenAttentionKeys.current.has(key));
    if (
      newFailure ||
      noticeCount > seen.current.count ||
      noticeAttention > seen.current.attention
    ) {
      setOpen(true);
    } else if (previousHasItems.current && !hasItems) {
      setOpen(false);
    }
    seen.current = { count: noticeCount, attention: noticeAttention };
    seenAttentionKeys.current = new Set(combinedAttentionKeys);
    previousHasItems.current = hasItems;
  }, [combinedAttentionKeys, hasItems, noticeAttention, noticeCount]);

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
    preferredWidth: 440,
  });
  useExclusiveHeaderPopover(popoverId, open, () => setOpen(false));

  const isError = hasProblems && badgeCount > 0;
  const triggerLabel = isError
    ? `${title}: ${attentionMessage} (${badgeCount})`
    : badgeCount > 0
      ? `${title} (${badgeCount})`
      : title;

  return (
    <div className="aiolm-header-center">
      <button
        ref={triggerRef}
        type="button"
        className={`app-icon-button aiolm-header-icon-btn${activeCount > 0 ? " is-active" : ""}${isError ? " is-error" : ""}${badgeCount > 0 ? " has-items" : ""}`}
        aria-label={triggerLabel}
        title={triggerLabel}
        aria-expanded={open}
        aria-controls={popoverId}
        data-testid="activity-center-trigger"
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
          <path d="M10 3.25a4.25 4.25 0 0 0-4.25 4.25v2.45L4.3 12.25h11.4l-1.45-2.3V7.5A4.25 4.25 0 0 0 10 3.25ZM8.25 14.5a1.85 1.85 0 0 0 3.5 0" />
        </svg>
        {badgeCount > 0 && (
          <span
            className={`aiolm-header-icon-badge${isError ? " is-error" : activeCount > 0 ? " is-accent" : ""}`}
            data-testid="activity-center-badge"
            aria-hidden="true"
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </button>

      {/* Always mounted so PanelFeedbackOutlet portals never detach while closed. */}
      <section
        ref={popoverRef}
        id={popoverId}
        className="aiolm-header-popover aiolm-header-popover--activity"
        aria-label={title}
        data-testid="activity-center-popover"
        hidden={!open}
        style={open ? headerPopoverStyle(position) : undefined}
      >
        <div className="aiolm-header-popover__head">
          <h2 className="aiolm-header-popover__title">{title}</h2>
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
          {children}
          {!hasItems && <p className="aiolm-header-popover__empty">{copy.activityEmpty}</p>}
        </div>
      </section>
    </div>
  );
}
