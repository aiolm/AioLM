import { modelMetadata } from '../api/commands';
import type { ModelMetadata } from '../api/types';

export const MODEL_METADATA_CHANGED = 'aiolm:model-metadata-changed';
const cache = new Map<string, { promise: Promise<ModelMetadata>; expires: number }>();
const waiting: Array<() => void> = [];
let active = 0;

/** Bound header reads across all visible model rows; reuse concurrent requests. */
export function readModelMetadata(path: string): Promise<ModelMetadata> {
  const found = cache.get(path);
  if (found && found.expires > Date.now()) return found.promise;
  const promise = new Promise<ModelMetadata>((resolve, reject) => {
    const run = () => {
      active += 1;
      void Promise.resolve().then(() => modelMetadata(path)).then(resolve, reject).finally(() => {
        active -= 1;
        waiting.shift()?.();
      });
    };
    if (active < 4) run(); else waiting.push(run);
  });
  const entry = { promise, expires: Number.POSITIVE_INFINITY };
  cache.set(path, entry);
  void promise.then(() => {
    entry.expires = Date.now() + 60_000;
    for (const [key, value] of cache) {
      if (cache.size <= 128) break;
      if (Number.isFinite(value.expires)) cache.delete(key);
    }
  }, () => { if (cache.get(path) === entry) cache.delete(path); });
  return promise;
}

export function invalidateModelMetadata() {
  cache.clear();
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MODEL_METADATA_CHANGED));
}
