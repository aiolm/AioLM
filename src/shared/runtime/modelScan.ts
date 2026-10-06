import { cancelModelScan, listModels } from '../api';
import { invalidateModelMetadata } from './modelMetadata';
import type { ProviderId } from '../api/providers';

/** Each consumer owns its cancellation token; replacing a scan cannot stop another view. */
export function startModelScan(directory: string, selection?: { provider: ProviderId; runtime: string }) {
  const id = crypto.randomUUID();
  let finished = false;
  let cancelled = false;
  const result = (selection ? listModels(directory, id, selection) : listModels(directory, id)).then(result => {
    invalidateModelMetadata();
    return result;
  }).finally(() => { finished = true; });
  return {
    result,
    cancel() {
      if (finished || cancelled) return;
      cancelled = true;
      void cancelModelScan(id).catch(() => undefined);
    },
  };
}
