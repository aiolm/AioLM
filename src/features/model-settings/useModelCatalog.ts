import { useCallback, useEffect, useRef, useState } from 'react';
import { listModels, type GgufModel } from '../../shared/api';

export const MODEL_CATALOG_CHANGED = 'aiolm:model-catalog-changed';
export function invalidateModelCatalog() { window.dispatchEvent(new Event(MODEL_CATALOG_CHANGED)); }

/** Each consumer discards responses from superseded scans and closed editors. */
export function useModelCatalog(directory: string, enabled = true) {
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
    void listModels(directory).then(result => {
      if (current !== generation.current) return;
      setModels(result.models); setTruncated(result.truncated);
    }).catch(cause => { if (current === generation.current) setError(String(cause)); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current = current + 1; };
  }, [directory, enabled, revision]);
  return { models, loading, error, truncated, refresh };
}
