import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";

export type ApiServerPending = "starting" | "stopping" | "restarting" | null;

/** How often the visible API page re-reads the listener, so a failure or another control surface shows up. */
const POLL_INTERVAL_MS = 3000;

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

const stopped = (current: api.ApiServerStatus): api.ApiServerStatus => ({ running: false, url: null, api_key: null, port: current.port });

const isVisible = () => typeof document === "undefined" || document.visibilityState !== "hidden";

/**
 * Lifecycle of the public API listener. It is deliberately unaware of model
 * state: starting, stopping and restarting the API never touch a loaded model,
 * and a model loading, unloading or being replaced never changes this status.
 * While `active` and visible it re-reads the status periodically.
 */
export function useApiServer(fallbackPort: number, active = true) {
  const [status, setStatus] = useState<api.ApiServerStatus>({ running: false, port: fallbackPort });
  const [checked, setChecked] = useState(false);
  const [pending, setPending] = useState<ApiServerPending>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  // Bumped at both ends of every action, so a read that began before an action
  // finished can never overwrite the newer state it produced.
  const generation = useRef(0);
  const hasRead = useRef(false);

  const refresh = useCallback(async (quiet = false) => {
    if (busy.current) return;
    const requested = generation.current;
    try {
      const next = await api.apiServerStatus();
      if (requested === generation.current) setStatus(next);
    } catch (cause) {
      // A background read that fails keeps the last known status; only an explicit one reports.
      if (!quiet && requested === generation.current) setError(errorText(cause));
    } finally {
      setChecked(true);
    }
  }, []);

  useEffect(() => {
    if (!active) return undefined;
    void refresh(hasRead.current);
    hasRead.current = true;
    let disposed = false;
    let timer: number | undefined;
    const schedule = () => {
      if (disposed) return;
      timer = window.setTimeout(async () => {
        if (isVisible()) await refresh(true);
        schedule();
      }, POLL_INTERVAL_MS);
    };
    const onVisibility = () => { if (isVisible()) void refresh(true); };
    document.addEventListener("visibilitychange", onVisibility);
    schedule();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, refresh]);

  const run = useCallback(async (kind: Exclude<ApiServerPending, null>, action: () => Promise<void>) => {
    if (busy.current) return;
    busy.current = true;
    generation.current += 1;
    setPending(kind);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
      // Whatever the failed call left behind is the truth, not our last guess.
      await api.apiServerStatus().then(setStatus, () => undefined);
    } finally {
      generation.current += 1;
      busy.current = false;
      setPending(null);
    }
  }, []);

  const start = useCallback(() => run("starting", async () => { setStatus(await api.startApiServer()); }), [run]);
  const stop = useCallback(() => run("stopping", async () => {
    await api.stopApiServer();
    setStatus(stopped);
  }), [run]);
  const restart = useCallback(() => run("restarting", async () => {
    await api.stopApiServer();
    setStatus(stopped);
    setStatus(await api.startApiServer());
  }), [run]);

  const clearError = useCallback(() => setError(null), []);

  return { status, checked, pending, error, refresh, start, stop, restart, clearError };
}
