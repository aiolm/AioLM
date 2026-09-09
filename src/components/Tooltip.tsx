import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { TuningTooltip } from "../panels/tuningFields";
import { useI18n } from "../i18n";

interface TooltipProps {
  content: TuningTooltip | string;
  /** Accessible name for the help affordance. */
  label?: string;
  id?: string;
}

/**
 * Small, CSS-only tooltip used by dense tuning controls.  The content remains
 * in the DOM for screen readers and appears on hover/focus, so the first
 * redesign stage does not need global popover state or a portal.
 */
export default function Tooltip({ content, label, id }: TooltipProps) {
  const { t } = useI18n();
  const title = typeof content === "string" ? undefined : content.title;
  const description = typeof content === "string" ? content : content.description;
  const tooltipId = id ? `${id}-tooltip` : undefined;
  const resolvedLabel = label ?? t("common.help");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<CSSProperties>({ left: 16, top: 16 });

  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const width = Math.min(260, window.innerWidth - 32);
    const measuredHeight = popoverRef.current?.getBoundingClientRect().height ?? 80;
    const left = Math.max(16, Math.min(rect.left, window.innerWidth - width - 16));
    const below = rect.bottom + 7;
    const top = below + measuredHeight <= window.innerHeight - 16
      ? below
      : Math.max(16, rect.top - measuredHeight - 7);
    setPosition({ left, top, width });
  }, []);

  useEffect(() => {
    if (!open) return;
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, { capture: true, passive: true });
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const popover = typeof document !== "undefined" ? createPortal(
    <span ref={popoverRef} id={tooltipId} role="tooltip" className={`app-tooltip-popover ${open ? "is-open" : ""}`} style={position}>
      {title && <strong className="app-tooltip-title">{title}</strong>}
      <span>{description}</span>
    </span>,
    document.body,
  ) : null;

  return (
    <span className="app-tooltip" data-tooltip onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button
        ref={triggerRef}
        type="button"
        className="app-tooltip-trigger"
        aria-label={resolvedLabel}
        aria-describedby={tooltipId}
        aria-expanded={open}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((value) => !value)}
      >
        <span aria-hidden="true">?</span>
      </button>
      {popover}
    </span>
  );
}

export type { TooltipProps };
