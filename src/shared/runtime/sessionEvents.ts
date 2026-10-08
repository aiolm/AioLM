export const SESSION_STATUS_CHANGED_EVENT = "aiolm:session-status-changed";

export function notifySessionStatusChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
}
