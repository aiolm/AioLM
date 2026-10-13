import { useEffect, useState } from 'react';
import { isNativeRuntimeAvailable } from '../api/transport';
import { modelDisplayName } from '../lib/displayPaths';
import { needsModelNameInspection, resolveModelDisplayName } from '../lib/modelNames';

/** Labels never replace the path used for loading, routing or recorded identity. */
export function useModelName(path = ''): string {
  const fallback = modelDisplayName(path);
  const [resolved, setResolved] = useState<{ path: string; name?: string }>();
  useEffect(() => {
    if (!isNativeRuntimeAvailable() || !needsModelNameInspection(path)) return;
    let current = true;
    void resolveModelDisplayName(path).then(name => { if (current) setResolved({ path, name }); });
    return () => { current = false; };
  }, [path, fallback]);
  return resolved?.path === path && resolved.name ? resolved.name : fallback;
}

/** Dynamic option lists share the same labels without making identity or actions wait for metadata. */
export function useModelNames(paths: readonly string[]): string[] {
  const inspections = JSON.stringify([...new Set(paths.filter(needsModelNameInspection))].sort());
  const [resolved, setResolved] = useState<{ inspections: string; names: Record<string, string> }>();
  useEffect(() => {
    if (!isNativeRuntimeAvailable()) return;
    let current = true;
    const selectedPaths = JSON.parse(inspections) as string[];
    for (const path of selectedPaths) {
      void resolveModelDisplayName(path).then(name => {
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
