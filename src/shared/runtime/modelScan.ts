import { cancelModelScan, listModels } from '../api';

/** Each consumer owns its cancellation token; replacing a scan cannot stop another view. */
export function startModelScan(directory: string) {
  const id = crypto.randomUUID();
  let finished = false;
  let cancelled = false;
  const result = listModels(directory, id).finally(() => { finished = true; });
  return {
    result,
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      void cancelModelScan(id).catch(() => undefined);
    },
  };
}
