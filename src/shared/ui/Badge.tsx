import type { ComponentPropsWithoutRef } from "react";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

/** Compact metadata and counts share one appearance across every workspace. */
export default function Badge({
  tone = "neutral",
  className,
  ...props
}: ComponentPropsWithoutRef<"span"> & { tone?: BadgeTone }) {
  return <span {...props} className={`app-badge app-badge--${tone}${className ? ` ${className}` : ""}`} />;
}
