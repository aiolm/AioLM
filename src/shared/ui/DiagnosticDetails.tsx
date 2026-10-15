import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { diagnosticDetailsCopy } from "../i18n/diagnosticDetailsCopy";
import { normalizeDisplayText } from "../lib/displayPaths";
import StableLabel from "./StableLabel";
import "./DiagnosticDetails.css";

/** Single-line diagnostics longer than this collapse behind the toggle. */
export const LONG_DIAGNOSTIC_LENGTH = 300;
/** Multiline diagnostics longer than this collapse; short two-liners stay inline. */
export const LONG_DIAGNOSTIC_MULTILINE_LENGTH = 120;
/** Visible summary truncation; the stored full text is never shortened. */
export const DIAGNOSTIC_SUMMARY_MAX_LENGTH = 240;

/**
 * Whether a diagnostic should collapse: very long single lines (paths,
 * unbroken tokens) or multiline output (engine usage/template lists) above
 * a small budget. Short messages render inline as before.
 */
export function isLongDiagnostic(value: string): boolean {
  if (!value) return false;
  if (value.length > LONG_DIAGNOSTIC_LENGTH) return true;
  const lines = value.split(/\r?\n/);
  if (lines.length > 1 && value.trim().length > LONG_DIAGNOSTIC_MULTILINE_LENGTH) {
    return lines.some((line) => line.trim() !== "");
  }
  return false;
}

/**
 * First non-empty line, truncated for display only; `detail` keeps everything.
 * Truncation counts Unicode code points (not UTF-16 units) so an emoji or
 * other astral character straddling the boundary stays intact instead of
 * splitting into a broken replacement glyph.
 */
export function summarizeDiagnostic(value: string, maxLength = DIAGNOSTIC_SUMMARY_MAX_LENGTH): string {
  const first = value.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const trimmed = first.trim();
  const points = Array.from(trimmed);
  if (points.length <= maxLength) return trimmed;
  return `${points.slice(0, maxLength).join("").trimEnd()}…`;
}

/**
 * Concise actionable summary plus the full diagnostic in a native
 * `<details>` disclosure with bounded scrolling and a copy button.
 *
 * The stored diagnostic is never shortened: `detail` displays with
 * presentation-only verbatim-prefix/ANSI normalization inside `<pre>`, while
 * the clipboard copy writes the original `detail` bytes exactly. Closed
 * content stays out of the surrounding `aria-live` announcement; only the
 * short summary and the copy result ("Copied"/"Copy failed") are announced.
 * Copy feedback always describes the current diagnostic and action: a new
 * attempt clears the old reset timer, late completions for a replaced
 * diagnostic or an older attempt are ignored, and nothing is claimed before
 * the clipboard promise succeeds. No copy content is logged.
 */
export default function DiagnosticDetails({ summary, detail, id }: { summary: string; detail: string; id?: string }) {
  const { locale } = useI18n();
  const copy = diagnosticDetailsCopy[locale];
  const generatedId = useId().replace(/:/g, "");
  const baseId = (id ?? generatedId).replace(/[^a-zA-Z0-9_-]/g, "-") || generatedId;
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  const timer = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const detailRef = useRef(detail);
  const unmountedRef = useRef(false);
  // Setup resets the mounted flag so StrictMode's setup->cleanup->setup
  // leaves the component live; cleanup invalidates in-flight attempts and
  // their timers so a late completion never touches a dead instance.
  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      attemptRef.current += 1;
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);
  // A replacement diagnostic invalidates in-flight copy attempts, cancels a
  // leftover success timer, and clears feedback so success can never be
  // claimed for the wrong text.
  useEffect(() => {
    detailRef.current = detail;
    attemptRef.current += 1;
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setStatus("idle");
  }, [detail]);
  const displaySummary = normalizeDisplayText(summary);
  const displayDetail = normalizeDisplayText(detail);
  const copyFull = async () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    const attempt = ++attemptRef.current;
    const text = detail;
    try {
      await navigator.clipboard.writeText(text);
      if (unmountedRef.current || attemptRef.current !== attempt || detailRef.current !== text) return;
      setStatus("copied");
      timer.current = window.setTimeout(() => {
        if (!unmountedRef.current && attemptRef.current === attempt) setStatus("idle");
      }, 1800);
    } catch {
      if (unmountedRef.current || attemptRef.current !== attempt || detailRef.current !== text) return;
      setStatus("error");
    }
  };
  const feedbackText = status === "copied" ? copy.copied : status === "error" ? copy.copyFailed : "";
  return (
    <div className="app-diagnostic-details">
      <p className="app-diagnostic-summary">{displaySummary}</p>
      <details id={`${baseId}-diagnostic`} className="app-diagnostic-disclosure">
        <summary className="app-diagnostic-toggle">{copy.showDetails}</summary>
        <div className="app-diagnostic-content">
          <pre id={`${baseId}-diagnostic-full`} tabIndex={0} aria-label={copy.fullDiagnostic} className="app-diagnostic-full"><code>{displayDetail}</code></pre>
          <div className="app-diagnostic-actions">
            <button type="button" className="app-button app-button--secondary app-button--sm" onClick={() => void copyFull()} aria-describedby={`${baseId}-diagnostic-feedback`}>
              <StableLabel value={status === "copied" ? copy.copied : copy.copy} labels={[copy.copy, copy.copied, copy.copyFailed]} />
            </button>
            <span id={`${baseId}-diagnostic-feedback`} role="status" className="app-diagnostic-feedback">{feedbackText}</span>
          </div>
        </div>
      </details>
    </div>
  );
}
