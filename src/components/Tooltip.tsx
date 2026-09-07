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
  return (
    <span className="app-tooltip" data-tooltip>
      <button
        type="button"
        className="app-tooltip-trigger"
        aria-label={resolvedLabel}
        aria-describedby={tooltipId}
      >
        <span aria-hidden="true">?</span>
      </button>
      <span id={tooltipId} role="tooltip" className="app-tooltip-popover">
        {title && <strong className="app-tooltip-title">{title}</strong>}
        <span>{description}</span>
      </span>
    </span>
  );
}

export type { TooltipProps };
