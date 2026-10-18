import { useCallback, useEffect, useRef, useState } from 'react';
import type { GgufModel } from '../../shared/api';
import { startModelScan } from '../../shared/runtime/modelScan';
import { isExternalProvider, providerOf, type ModelCatalogSelection } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';

export const MODEL_CATALOG_CHANGED = 'aiolm:model-catalog-changed';
export function invalidateModelCatalog() { window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED)); }

/** Each consumer cancels and discards scans superseded by a new folder or closed editor. */
export function useModelCatalog(directory: string, enabled = true, cfg?: AppConfig) {
  const provider = providerOf(cfg ?? {}); const runtime = cfg?.active_runtime ?? '';
  const external = isExternalProvider(provider) && !!runtime;
  const selectionKey = JSON.stringify([directory, provider, runtime]);
  const [libraryKey, setLibraryKey] = useState<string | null>(null);
  const includeLibrary = !external || libraryKey === selectionKey;
  const [selection, setSelection] = useState<ModelCatalogSelection>();
  const [models, setModels] = useState<GgufModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const exploreLibrary = useCallback(() => setLibraryKey(selectionKey), [selectionKey]);
  useEffect(() => {
    window.addEventListener(MODEL_CATALOG_CHANGED, refresh);
    return () => window.removeEventListener(MODEL_CATALOG_CHANGED, refresh);
  }, [refresh]);
  useEffect(() => {
    const current = ++generation.current;
    setError(''); setModels([]); setTruncated(false); setSelection(undefined);
    if (!enabled || (!directory.trim() && !external)) { setLoading(false); return; }
    setLoading(true);
    const scan = startModelScan(directory, provider !== 'llama.cpp' && runtime ? { provider, runtime, ...(external ? { includeLibrary } : {}) } : undefined);
    void scan.result.then(result => {
      if (current !== generation.current) return;
      if (result.selection && (result.selection.provider !== provider || result.selection.runtime !== runtime)) {
        throw new Error('The model catalog belongs to another runtime. Refresh the selected runtime.');
      }
      setModels(result.models); setTruncated(result.truncated); setSelection(result.selection);
    }).catch(cause => { if (current === generation.current) setError(String(cause)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current = current + 1; scan.cancel(); };
  }, [directory, enabled, revision, provider, runtime, external, includeLibrary]);
  return { models, loading, error, truncated, selection, refresh, exploreLibrary };
}
