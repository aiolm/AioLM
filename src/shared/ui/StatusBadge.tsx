import StableLabel from "./StableLabel";
import Badge, { type BadgeTone } from "./Badge";
import type { ComponentPropsWithoutRef } from "react";

export default function StatusBadge({
  label,
  labels,
  tone = "neutral",
  className,
  ...props
}: {
  label: string;
  labels?: string[];
  tone?: BadgeTone;
} & Omit<ComponentPropsWithoutRef<"span">, "children">) {
  return <Badge {...props} tone={tone} className={`app-status-badge${className ? ` ${className}` : ""}`}><span className="app-status-badge__dot" aria-hidden="true" />{labels ? <StableLabel value={label} labels={labels} /> : label}</Badge>;
}
