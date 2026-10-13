import { useEffect, useState } from 'react';
import { modelArtifact } from '../api/providers';
import { isNativeRuntimeAvailable } from '../api/transport';
import { modelDisplayName, normalizeDisplayPath } from '../lib/displayPaths';

const pending = new Map<string, Promise<string | undefined>>();

function needsNameInspection(path: string): boolean {
  const parts = normalizeDisplayPath(path).replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.at(-2) === 'snapshots' && /^[a-f0-9]{40}$/i.test(modelDisplayName(path));
}

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
    if (!isNativeRuntimeAvailable() || !needsNameInspection(path)) return;
    let current = true;
    void readName(path).then(name => { if (current) setResolved({ path, name }); });
    return () => { current = false; };
  }, [path, fallback]);
  return resolved?.path === path && resolved.name ? resolved.name : fallback;
}

/** Dynamic option lists share the same labels without making identity or actions wait for metadata. */
export function useModelNames(paths: readonly string[]): string[] {
  const inspections = JSON.stringify([...new Set(paths.filter(needsNameInspection))].sort());
  const [resolved, setResolved] = useState<{ inspections: string; names: Record<string, string> }>();
  useEffect(() => {
    if (!isNativeRuntimeAvailable()) return;
    let current = true;
    const selectedPaths = JSON.parse(inspections) as string[];
    for (const path of selectedPaths) {
      void readName(path).then(name => {
        if (!current || !name) return;
        setResolved(previous => ({ inspections, names: { ...(previous?.inspections === inspections ? previous.names : {}), [path]: name } }));
      });
    }
    return () => { current = false; };
  }, [inspections]);
  return paths.map(path => (resolved?.inspections === inspections ? resolved.names[path] : undefined) || modelDisplayName(path));
}

export default function ModelName({ model, empty = '' }: { model?: string; empty?: string }) {
  return useModelName(model) || empty;
}
