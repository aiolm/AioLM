import { useEffect, useState } from 'react';
import { modelArtifact } from '../api/providers';
import { isNativeRuntimeAvailable } from '../api/transport';
import { modelDisplayName, normalizeDisplayPath } from '../lib/displayPaths';

const pending = new Map<string, Promise<string | undefined>>();

/** Reuse simultaneous reads, without retaining results across later reads. */
function readName(path: string): Promise<string | undefined> {
  const found = pending.get(path);
  if (found) return found;
  const read = Promise.resolve().then(() => modelArtifact(path)).then(artifact => {
    const name = artifact.name.trim();
    return artifact.format !== 'gguf' && name && !/^[a-f0-9]{40}$/i.test(name) ? name : undefined;
  }).catch(() => undefined).finally(() => {
    if (pending.get(path) === read) pending.delete(path);
  });
  pending.set(path, read);
  return read;
}

/** Labels never replace the path used for loading, routing or recorded identity. */
export function useModelName(path = ''): string {
  const fallback = modelDisplayName(path);
  const [resolved, setResolved] = useState<{ path: string; name?: string }>();
  useEffect(() => {
    const parts = normalizeDisplayPath(path).replace(/\\/g, '/').split('/').filter(Boolean);
    if (!isNativeRuntimeAvailable() || parts.at(-2) !== 'snapshots' || !/^[a-f0-9]{40}$/i.test(fallback)) return;
    let current = true;
    void readName(path).then(name => { if (current) setResolved({ path, name }); });
    return () => { current = false; };
  }, [path, fallback]);
  return resolved?.path === path && resolved.name ? resolved.name : fallback;
}

export default function ModelName({ model, empty = '' }: { model?: string; empty?: string }) {
  return useModelName(model) || empty;
}
