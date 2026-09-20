import { useEffect, useState } from 'react';
import * as api from '../../shared/api';

/**
 * The context the selected model was trained for, from its own GGUF header.
 *
 * Read here rather than during the folder scan: it is only wanted once the
 * editor is open on one model, and opening every file in a library to collect it
 * would make the listing crawl. A model whose header does not state one, or that
 * cannot be read, returns `undefined` and leaves the control on its app default.
 */
export function useModelContextLimit(modelPath: string, open: boolean): number | undefined {
  const [limit, setLimit] = useState<number>();

  useEffect(() => {
    setLimit(undefined);
    if (!open || !modelPath.trim()) return;
    let active = true;
    void api.modelMetadata(modelPath)
      .then(metadata => { if (active && metadata.context_length) setLimit(metadata.context_length); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [modelPath, open]);

  return limit;
}
