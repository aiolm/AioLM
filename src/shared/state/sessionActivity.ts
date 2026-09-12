import { useSyncExternalStore } from 'react';

const active = new Set<string>();
const listeners = new Set<() => void>();
export function setSessionActivity(id: string, busy: boolean): void {
  const previous = active.has(id);
  if (busy) active.add(id); else active.delete(id);
  if (previous !== busy) for (const listener of listeners) listener();
}
export function sessionHasActivity(id: string): boolean { return active.has(id); }
export function anySessionActivity(): boolean { return active.size > 0; }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export function useSessionActivity(id: string): boolean { return useSyncExternalStore(subscribe, () => sessionHasActivity(id), () => false); }
