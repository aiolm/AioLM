import StableLabel from "./StableLabel";

export default function StatusBadge({
  label,
  labels,
  tone = "neutral",
}: {
  label: string;
  labels?: string[];
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  return <span className={`app-status-badge app-status-badge--${tone}`}><span aria-hidden="true" />{labels ? <StableLabel value={label} labels={labels} /> : label}</span>;
}
