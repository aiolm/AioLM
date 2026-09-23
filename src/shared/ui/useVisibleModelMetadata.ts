import { useEffect, useRef, useState } from 'react';
import type { ModelMetadata } from '../api/types';
import { isNativeRuntimeAvailable } from '../api/transport';
import { MODEL_METADATA_CHANGED, readModelMetadata } from '../runtime/modelMetadata';

export function useVisibleModelMetadata(path?: string) {
  const ref = useRef<HTMLSpanElement>(null);
  const [result, setResult] = useState<{ path: string; metadata: ModelMetadata }>();
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const refresh = () => { setResult(undefined); setRevision(value => value + 1); };
    window.addEventListener(MODEL_METADATA_CHANGED, refresh);
    return () => window.removeEventListener(MODEL_METADATA_CHANGED, refresh);
  }, []);
  useEffect(() => {
    if (!path?.trim() || !ref.current || !isNativeRuntimeAvailable()) return;
    let current = true;
    const read = () => {
      void readModelMetadata(path).then(metadata => {
        if (current) setResult({ path, metadata });
      }).catch(() => undefined);
    };
    const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { observer?.disconnect(); read(); }
    });
    if (observer) observer.observe(ref.current); else read();
    return () => { current = false; observer?.disconnect(); };
  }, [path, revision]);
  return { ref, metadata: result?.path === path ? result?.metadata : undefined };
}
