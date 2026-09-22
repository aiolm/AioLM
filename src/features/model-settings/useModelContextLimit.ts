import { useEffect, useState } from 'react';
import * as api from '../../shared/api';

/**
 * The context the selected model was trained for, from its own GGUF header.
 *
 * Read immediately for the selected model; list badges load visible rows lazily.
 * Folder scans do not open each model file. A model whose header does not state one, or that
 * cannot be read, returns `undefined` and leaves the control on its app default.
 */
export function useSelectedModelMetadata(modelPath: string, open: boolean): api.ModelMetadata | undefined {
  const [result, setResult] = useState<{ path: string; metadata: api.ModelMetadata }>();

  useEffect(() => {
    setResult(undefined);
    if (!open || !modelPath.trim()) return;
    let active = true;
    void api.modelMetadata(modelPath)
      .then(metadata => { if (active) setResult({ path: modelPath, metadata }); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [modelPath, open]);

  return open && result?.path === modelPath ? result.metadata : undefined;
}

export function useModelContextLimit(modelPath: string, open: boolean): number | undefined {
  return useSelectedModelMetadata(modelPath, open)?.context_length;
}
