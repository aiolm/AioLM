import { useEffect, useId, useRef, type ReactNode } from "react";
import { useI18n } from "../i18n/i18n";
import { normalizeDisplayText } from "../lib/displayPaths";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  tone?: "primary" | "danger";
  onConfirm: () => void;
  onCancel: () => void;
};

export default function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  tone = "danger",
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const id = useId();
  const titleId = `${id}-title`;
  const descriptionId = `${id}-description`;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const invokerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      invokerRef.current = document.activeElement as HTMLElement | null;
      dialog.showModal();
      window.requestAnimationFrame(() => cancelRef.current?.focus());
    } else if (!open && dialog.open) {
      dialog.close();
      window.requestAnimationFrame(() => invokerRef.current?.focus?.());
    }
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="app-confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        )).filter((element) => !element.hasAttribute("hidden"));
        const first = focusable[0];
        const last = focusable.at(-1);
        if (!first || !last) return;
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <div className="app-confirm-dialog__panel">
        <div className="app-confirm-dialog__eyebrow">{t("common.confirm")}</div>
        <h2 id={titleId}>{normalizeDisplayText(title)}</h2>
        {/* A div, not a p: `description` is a ReactNode, and callers that
            pass structured content (a provenance table, a warning block)
            would otherwise nest block elements inside a paragraph. */}
        <div id={descriptionId} className="app-confirm-dialog__description">{typeof description === "string" ? normalizeDisplayText(description) : description}</div>
        <div className="app-confirm-dialog__actions">
          <button type="button" ref={cancelRef} className="app-button app-button--secondary" disabled={busy} onClick={onCancel}>{busy ? t("common.wait") : cancelLabel}</button>
          <button type="button" ref={confirmRef} className={`app-button app-button--${tone}`} disabled={busy} onClick={onConfirm}>{busy ? `${confirmLabel.replace(/^Remove\s+/i, "Removing ").replace(/^Delete\s+/i, "Deleting ").replace(/^Restart\s+/i, "Restarting ")}` : confirmLabel}</button>
        </div>
      </div>
    </dialog>
  );
}

export type { ConfirmDialogProps };
