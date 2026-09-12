import { useCallback, useRef, useState } from 'react';
import type { AppStore } from '../../shared/state/store';
import type { AppConfig } from '../../shared/api/types';
import type { ConfigPatch } from '../../shared/state/configSaveQueue';
import { MODEL_EXECUTION_KEY, rememberExecution, restoreExecution } from './modelExecutionState';
import { executionChanges } from '../../shared/config/executionSettings';

/** All screens persist model settings through the same serialized native config queue. */
export function useExecutionStore(base: AppStore) {
  const latest = useRef(base);
  latest.current = base;
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<Promise<unknown>>(Promise.resolve());
  const updateConfig = useCallback((patch: ConfigPatch<AppConfig>): Promise<AppConfig> => {
    const operation = pending.current.catch(() => undefined).then(async () => {
      const current = latest.current.getConfig();
      if (!current) throw new Error('Configuration is still loading.');
      const next = typeof patch === 'function' ? patch(current) : patch;
      if (!Object.keys(executionChanges(current, { ...current, ...next })).length) {
        const saved = await latest.current.updateConfig(next); setError(null); return saved;
      }
      // Save the departing model before allowing a selection/project to overwrite it.
      if (next.active_model && next.active_model !== current.active_model) rememberExecution(current);
      const previousMemory = window.localStorage.getItem(MODEL_EXECUTION_KEY);
      // Detect storage/quota failures before publishing a new native selection.
      rememberExecution({ ...current, ...next });
      let persisted = false;
      try {
        const saved = await latest.current.updateConfig(next);
        persisted = true;
        rememberExecution(saved);
        setError(null);
        return saved;
      } catch (cause) {
        if (persisted) await latest.current.updateConfig(current);
        if (previousMemory === null) window.localStorage.removeItem(MODEL_EXECUTION_KEY);
        else window.localStorage.setItem(MODEL_EXECUTION_KEY, previousMemory);
        throw cause;
      }
    }).catch(cause => { setError(String(cause)); throw cause; });
    pending.current = operation;
    return operation;
  }, []);
  const selectModel = useCallback(async (path: string) => {
    await updateConfig(current => current.active_model === path ? {} : restoreExecution(current, path));
  }, [updateConfig]);
  const start = useCallback(async (override?: AppConfig, replaceRunning = false) => {
    // A failed save rolls back config; an explicit retry may run that saved configuration.
    await pending.current.catch(() => undefined);
    setError(null);
    return latest.current.start(override, replaceRunning);
  }, []);
  const clearErrors = useCallback(() => { setError(null); latest.current.clearErrors(); }, []);
  // Persistence is serialized above; only server lifecycle operations lock the app.
  // A field save must not flash every page's buttons into their busy state.
  return { store: { ...base, updateConfig, start,
    actionError: error ?? base.actionError,
    clearErrors,
  } satisfies AppStore, selectModel };
}
