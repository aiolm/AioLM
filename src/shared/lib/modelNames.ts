import { snapshotModelName } from '../api/providers';
import { isNativeRuntimeAvailable } from '../api/transport';
import { modelDisplayName, normalizeDisplayPath } from './displayPaths';

const pending = new Map<string, Promise<string | undefined>>();

export function needsModelNameInspection(path: string): boolean {
  const parts = normalizeDisplayPath(path).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-2) === 'snapshots' && /^[a-f0-9]{40}$/i.test(parts.at(-1) ?? '');
}

/** Reuse simultaneous metadata reads without retaining names across later reads. */
function readName(path: string, opaqueFallback: boolean): Promise<string | undefined> {
  const found = pending.get(path);
  if (found) return found;
  const read = Promise.resolve().then(() => snapshotModelName(path)).then(label => {
    const name = label && (label.selected || opaqueFallback) ? label.name.trim() : undefined;
    return name && !/^[a-f0-9]{40}$/i.test(name) ? name : undefined;
  }).catch(() => undefined).finally(() => {
    if (pending.get(path) === read) pending.delete(path);
  });
  pending.set(path, read);
  return read;
}

/** A presentation label only; inference, storage and sharing keep their original model identity. */
export async function resolveModelDisplayName(path: string): Promise<string> {
  const fallback = modelDisplayName(path);
  if (!isNativeRuntimeAvailable() || !needsModelNameInspection(path)) return fallback;
  return await readName(path, /^[a-f0-9]{40}$/i.test(fallback)) || fallback;
}
