const active = new Set<string>();
export function setSessionActivity(id: string, busy: boolean): void {
  if (busy) active.add(id); else active.delete(id);
}
export function sessionHasActivity(id: string): boolean { return active.has(id); }
export function anySessionActivity(): boolean { return active.size > 0; }
