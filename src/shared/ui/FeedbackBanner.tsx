import { Children, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";
import { normalizeDisplayText } from "../lib/displayPaths";

export type FeedbackTone = "info" | "success" | "warning" | "error";

const toneClass: Record<FeedbackTone, string> = {
  info: "app-feedback--info",
  success: "app-feedback--success",
  warning: "app-feedback--warning",
  error: "app-feedback--error",
};

function FeedbackToneIcon({ tone }: { tone: FeedbackTone }) {
  if (tone === "success") {
    return (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="7.5" />
        <path d="m6.8 10.2 2.2 2.2 4.4-4.8" />
      </svg>
    );
  }
  if (tone === "warning") {
    return (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M10 3.2 17.2 16a1.2 1.2 0 0 1-1.04 1.8H3.84A1.2 1.2 0 0 1 2.8 16L10 3.2Z" />
        <path d="M10 7.8v4.2" />
        <circle cx="10" cy="14.6" r="0.9" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (tone === "error") {
    return (
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <circle cx="10" cy="10" r="7.5" />
        <path d="m7.2 7.2 5.6 5.6M12.8 7.2l-5.6 5.6" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="10" cy="10" r="7.5" />
      <path d="M10 9.2v4.8" />
      <circle cx="10" cy="6.2" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function FeedbackBanner({
  tone,
  title,
  children,
  onDismiss,
  action,
  className,
}: {
  tone: FeedbackTone;
  title?: string;
  children: ReactNode;
  onDismiss?: () => void;
  action?: { label: string; onClick: () => void };
  className?: string;
}) {
  const { t } = useI18n();
  const displayChildren = Children.map(children, (child) => typeof child === "string" ? normalizeDisplayText(child) : child);
  return (
    <div className={`app-feedback ${toneClass[tone]}${className ? ` ${className}` : ""}`} role={tone === "error" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} aria-atomic="true">
      <span className="app-feedback-icon" aria-hidden="true">
        <FeedbackToneIcon tone={tone} />
      </span>
      <div className="app-feedback-body">
        {title && <div className="app-feedback-title">{normalizeDisplayText(title)}</div>}
        <div className="app-feedback-message">{displayChildren}</div>
      </div>
      {action && <button type="button" className="app-feedback-action" onClick={action.onClick}>{action.label}</button>}
      {onDismiss && <button type="button" className="app-feedback-dismiss" aria-label={t("common.dismiss")} onClick={onDismiss}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M3 3 9 9M9 3 3 9" /></svg></button>}
    </div>
  );
}
