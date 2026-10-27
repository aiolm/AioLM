import type { ServerStatus } from '../api/types';

/** The engine's public model ID can be an alias; execution retains the loaded artifact path. */
export function loadedModelPath(status: Pick<ServerStatus, 'model' | 'execution'> | null | undefined, fallback = ''): string {
  return status?.execution?.active_model?.trim() ? status.execution.active_model : status?.model || fallback;
}
