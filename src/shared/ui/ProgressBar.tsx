/** Omitting the value exposes an indeterminate operation to assistive technology. */
export default function ProgressBar({ label, value, className }: {
  label: string;
  value?: number;
  className?: string;
}) {
  return <progress aria-label={label} max={100}
    value={value !== undefined && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) : undefined}
    className={`app-progress${className ? ` ${className}` : ""}`} />;
}
