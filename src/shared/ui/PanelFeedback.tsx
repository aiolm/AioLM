import { Children, createContext, isValidElement, useCallback, useContext, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";

export const ActivePanelContext = createContext(true);
type NoticeCount = { count: number; attention: number; signature: string };
const FeedbackContext = createContext<{
  target: HTMLDivElement | null;
  setTarget: (target: HTMLDivElement | null) => void;
  register: (id: string, count: number, attention: number, signature?: string) => void;
  count: number;
  attention: number;
  attentionSignatures: readonly string[];
} | null>(null);

function extractNoticeText(node: ReactNode, depth = 0): string {
  if (depth > 4 || node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") return String(node);
  if (isValidElement<{ tone?: unknown; title?: unknown; error?: unknown; children?: ReactNode }>(node)) {
    return [
      node.key ?? "",
      typeof node.props.tone === "string" ? node.props.tone : "",
      typeof node.props.title === "string" ? node.props.title : "",
      typeof node.props.error === "string" ? node.props.error : "",
      extractNoticeText(node.props.children, depth + 1),
    ].join(":");
  }
  if (typeof node === "object" && Symbol.iterator in node) {
    return Array.from(node, item => extractNoticeText(item, depth + 1)).join("|");
  }
  return "";
}

/** Notices share the activity drawer instead of reserving empty space in every page. */
export function PanelFeedbackProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const [counts, setCounts] = useState<Record<string, NoticeCount>>({});
  const register = useCallback((id: string, count: number, attention: number, signature = "") => {
    setCounts(current => {
      if ((current[id]?.count ?? 0) === count && (current[id]?.attention ?? 0) === attention && (current[id]?.signature ?? "") === signature) return current;
      const next = { ...current };
      if (count) next[id] = { count, attention, signature };
      else delete next[id];
      return next;
    });
  }, []);
  const count = Object.values(counts).reduce((sum, value) => sum + value.count, 0);
  const attention = Object.values(counts).reduce((sum, value) => sum + value.attention, 0);
  const attentionSignatures = useMemo(
    () => Object.entries(counts)
      .filter(([, value]) => value.attention > 0 && value.signature)
      .map(([id, value]) => `${id}:${value.signature}`),
    [counts],
  );
  const value = useMemo(
    () => ({ target, setTarget, register, count, attention, attentionSignatures }),
    [target, register, count, attention, attentionSignatures],
  );
  return <FeedbackContext.Provider value={value}>{children}</FeedbackContext.Provider>;
}

export function usePanelFeedbackSummary() {
  const context = useContext(FeedbackContext);
  return { count: context?.count ?? 0, attention: context?.attention ?? 0 };
}

export function PanelFeedbackOutlet() {
  const context = useContext(FeedbackContext);
  return <div ref={context?.setTarget} className="app-feedback-layer app-panel-notices" aria-live="polite" />;
}

export function PanelFeedbackActivity({ hasActivity, attentionKeys = [], children }: { hasActivity: boolean; attentionKeys?: readonly string[]; children: ReactNode }) {
  const context = useContext(FeedbackContext);
  const drawerRef = useRef<HTMLDetailsElement>(null);
  const seen = useRef({ count: context?.count ?? 0, attention: context?.attention ?? 0 });
  const seenAttentionKeys = useRef(new Set<string>());
  const count = context?.count ?? 0;
  const attention = context?.attention ?? 0;
  const combinedAttentionKeys = useMemo(
    () => [...attentionKeys, ...(context?.attentionSignatures ?? [])],
    [attentionKeys, context?.attentionSignatures],
  );
  useEffect(() => {
    // Only new failures or new/escalated notices reopen a manually collapsed
    // drawer. Compare failure identities, not counts: one failure can replace
    // another while the number of tasks needing attention stays unchanged.
    const newFailure = combinedAttentionKeys.some(key => !seenAttentionKeys.current.has(key));
    if ((newFailure || count > seen.current.count || attention > seen.current.attention) && drawerRef.current && !drawerRef.current.open) {
      drawerRef.current.open = true;
    }
    seen.current = { count, attention };
    seenAttentionKeys.current = new Set(combinedAttentionKeys);
  }, [count, attention, combinedAttentionKeys]);
  // The bar stays mounted with a fixed height even when there is nothing to
  // report, so work or a notice arriving after the page appears never resizes
  // the page. An empty bar cannot be expanded.
  const empty = !hasActivity && !count;
  useEffect(() => {
    if (empty && drawerRef.current?.open) drawerRef.current.open = false;
  }, [empty]);
  return <details ref={drawerRef} className="app-activity" data-empty={empty ? "" : undefined}
    onToggle={event => { if (empty && event.currentTarget.open) event.currentTarget.open = false; }}>{children}</details>;
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
  const attentionNotices = notices.filter(child => isValidElement<{ tone?: string; role?: string }>(child)
    && (child.props.tone === "error" || child.props.tone === "warning" || child.props.role === "alert"));
  const attention = attentionNotices.length;
  const signature = attentionNotices.map(child => extractNoticeText(child)).join("||");
  const register = context?.register;
  useEffect(() => {
    register?.(id, count, attention, signature);
    return () => register?.(id, 0, 0, "");
  }, [register, id, count, attention, signature]);
  if (!active || !count) return null;
  // Isolated panels (including tests) still expose their actionable notices inline.
  if (!context) return <div className="app-feedback-layer" aria-live="polite">{children}</div>;
  return context.target ? createPortal(children, context.target) : null;
}
