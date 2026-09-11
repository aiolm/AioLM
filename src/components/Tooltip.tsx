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

/** A viewport-positioned help popover, also associated with its control for AT. */
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
    const dismiss = () => setOpen(false);
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") dismiss(); };
    window.addEventListener("aiolm:navigate", dismiss);
    window.addEventListener("keydown", onKeyDown);
    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, { capture: true, passive: true });
    return () => {
      window.removeEventListener("aiolm:navigate", dismiss);
      window.removeEventListener("keydown", onKeyDown);
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
        <svg aria-hidden="true" focusable="false" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 1.7-2.5 2-2.5 4" />
          <circle cx="12" cy="16.5" r=".9" fill="currentColor" stroke="none" />
        </svg>
      </button>
      {popover}
    </span>
  );
}

export type { TooltipProps };
