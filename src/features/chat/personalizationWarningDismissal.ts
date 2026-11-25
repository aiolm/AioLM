import { useSyncExternalStore } from "react";

/**
 * Local instruction and skill warnings come back on every catalog refresh and
 * every send while their cause is still on disk, so a banner without a dismiss
 * had no way to go away. Dismissing remembers the exact warning list for this
 * app session: the skill picker and the composer hide the same list together,
 * and a different list (a new problem, or a fixed one) shows again.
 */
let dismissedKey: string | null = null;
const listeners = new Set<() => void>();

function warningsKey(warnings: readonly string[]): string {
  return JSON.stringify(warnings);
}

export function dismissPersonalizationWarnings(warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  const key = warningsKey(warnings);
  if (key === dismissedKey) return;
  dismissedKey = key;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getDismissedKey(): string | null {
  return dismissedKey;
}

/** The warnings still to show: empty when there are none or they were dismissed. */
export function useVisiblePersonalizationWarnings(warnings: readonly string[]): readonly string[] {
  const dismissed = useSyncExternalStore(subscribe, getDismissedKey, getDismissedKey);
  return warnings.length > 0 && warningsKey(warnings) !== dismissed ? warnings : [];
}

export function resetPersonalizationWarningDismissalForTests(): void {
  dismissedKey = null;
  for (const listener of listeners) listener();
}
