/**
 * An engine runtime was installed, registered, imported or removed. Anything
 * that names a runtime or holds a result about one reads it again: the same
 * runtime ID can come back describing a different installation.
 */
import { useSyncExternalStore } from 'react';

export const RUNTIME_INVENTORY_CHANGED_EVENT = "aiolm:runtime-inventory-changed";
let revision = 0;
const listeners = new Set<() => void>();

export function subscribeRuntimeInventory(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function runtimeInventoryRevision(): number { return revision; }

export function useRuntimeInventoryRevision(): number {
  return useSyncExternalStore(subscribeRuntimeInventory, runtimeInventoryRevision, runtimeInventoryRevision);
}

export function notifyRuntimeInventoryChanged(): void {
  revision += 1;
  for (const listener of [...listeners]) listener();
  if (typeof window !== "undefined") window.dispatchEvent(new Event(RUNTIME_INVENTORY_CHANGED_EVENT));
}
