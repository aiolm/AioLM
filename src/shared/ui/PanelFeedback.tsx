import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";

export const ActivePanelContext = createContext(true);
type NoticeCount = { count: number; attention: number };
const FeedbackContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  register: (id: string, count: number, attention: number) => void;
  count: number;
  attention: number;
} | null>(null);

/** Notices share the activity drawer instead of reserving empty space in every page. */
export function PanelFeedbackProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<Record<string, NoticeCount>>({});
  const register = useCallback((id: string, count: number, attention: number) => {
    setCounts(current => {
      if ((current[id]?.count ?? 0) === count && (current[id]?.attention ?? 0) === attention) return current;
      const next = { ...current };
      if (count) next[id] = { count, attention };
      else delete next[id];
      return next;
    });
  }, []);
  const count = Object.values(counts).reduce((sum, value) => sum + value.count, 0);
  const attention = Object.values(counts).reduce((sum, value) => sum + value.attention, 0);
  const value = useMemo(() => ({ target, setTarget, register, count, attention }), [target, register, count, attention]);
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function PanelFeedbackOutlet() {
  const context = useContext(FeedbackContext);
  return <div ref={context?.setTarget} className="app-feedback-layer app-panel-notices" aria-live="polite" />;
}

export function PanelFeedbackActivity({ hasActivity, children }: { hasActivity: boolean; children: ReactNode }) {
  const context = useContext(FeedbackContext);
  const drawerRef = useRef<HTMLDetailsElement>(null);
  const seen = useRef({ count: context?.count ?? 0, attention: context?.attention ?? 0 });
  const count = context?.count ?? 0;
  const attention = context?.attention ?? 0;
  useEffect(() => {
    // New (or escalated) notices open the drawer on arrival; manual toggle
    // stays native so keyboard and Escape handling keep working.
    if ((count > seen.current.count || attention > seen.current.attention) && drawerRef.current && !drawerRef.current.open) {
      drawerRef.current.open = true;
    }
    seen.current = { count, attention };
  }, [count, attention]);
  return <details ref={drawerRef} className="app-activity" hidden={!hasActivity && !count}>{children}</details>;
}

export function PanelFeedbackIndicator({ message, globalError }: { message: string; globalError: boolean }) {
  const context = useContext(FeedbackContext);
  const { t } = useI18n();
  const needsAttention = globalError || !!context?.attention;
  return <span className={needsAttention ? "app-activity-error" : "app-activity-notice"} aria-live="polite">{needsAttention ? message : context?.count ? t("ui.noticeCount", { count: context.count }) : ""}</span>;
}

export default function PanelFeedback({ children }: { children: ReactNode }) {
  const context = useContext(FeedbackContext);
  const active = useContext(ActivePanelContext);
  const id = useId();
  const notices = active ? Children.toArray(children) : [];
  const count = notices.length;
  const attention = notices.filter(child => isValidElement<{ tone?: string; role?: string }>(child)
    && (child.props.tone === "error" || child.props.tone === "warning" || child.props.role === "alert")).length;
  const register = context?.register;
  useEffect(() => {
    register?.(id, count, attention);
    return () => register?.(id, 0, 0);
  }, [register, id, count, attention]);
  if (!active || !count) return null;
  // Isolated panels (including tests) still expose their actionable notices inline.
  if (!context) return <div className="app-feedback-layer" aria-live="polite">{children}</div>;
  return context.target ? createPortal(children, context.target) : null;
}
