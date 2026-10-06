import { useCallback, useEffect, useRef, useState } from 'react';
import type { GgufModel } from '../../shared/api';
import { startModelScan } from '../../shared/runtime/modelScan';
import { providerOf } from '../../shared/api/providers';
import type { AppConfig } from '../../shared/api/types';

export const MODEL_CATALOG_CHANGED = 'aiolm:model-catalog-changed';
export function invalidateModelCatalog() { window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED)); }

/** Each consumer cancels and discards scans superseded by a new folder or closed editor. */
export function useModelCatalog(directory: string, enabled = true, cfg?: AppConfig) {
  const provider = providerOf(cfg ?? {}); const runtime = cfg?.active_runtime ?? '';
  const [models, setModels] = useState<GgufModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    window.addEventListener(MODEL_CATALOG_CHANGED, refresh);
    return () => window.removeEventListener(MODEL_CATALOG_CHANGED, refresh);
  }, [refresh]);
  useEffect(() => {
    const current = ++generation.current;
    setError(''); setModels([]); setTruncated(false);
    if (!enabled || !directory.trim()) { setLoading(false); return; }
    setLoading(true);
    const scan = startModelScan(directory, provider !== 'llama.cpp' && runtime ? { provider, runtime } : undefined);
    void scan.result.then(result => {
      if (current !== generation.current) return;
      setModels(result.models); setTruncated(result.truncated);
    }).catch(cause => { if (current === generation.current) setError(String(cause)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current = current + 1; scan.cancel(); };
  }, [directory, enabled, revision, provider, runtime]);
  return { models, loading, error, truncated, refresh };
}
