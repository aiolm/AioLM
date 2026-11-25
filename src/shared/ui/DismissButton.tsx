/**
 * The X that clears a finished notice from view: banners, and finished rows
 * in the task strip and the launch and download centers. It only takes the
 * notice off screen. Actions that change the work itself (cancel, pause,
 * resume, discard a partial file) keep worded buttons so they are never
 * mistaken for this one.
 */
export default function DismissButton({
  label,
  onClick,
  className,
}: {
  /** Accessible name and hover text, e.g. "Dismiss: model.gguf". */
  label: string;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`app-icon-button app-icon-button--sm app-dismiss-button${className ? ` ${className}` : ""}`}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true" focusable="false">
        <path d="M3 3 9 9M9 3 3 9" />
      </svg>
    </button>
  );
}
