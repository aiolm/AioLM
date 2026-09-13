import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../api/index";
import { createConfigSaveQueue, type ConfigPatch } from "./configSaveQueue";
import { isLifecycleCancellation, lifecycleErrorMessage, nextPollDelay, shouldAutoStart, shouldPoll, withTimeout } from "../lib/serverLifecycle";
import { normalizeAppConfig, normalizeConfigPatch } from "./storeConfig";
import { withManualOverrides } from "../config/tuningDefaults";
import { migrateProfileLibrary } from "../config/profileMigration";

export interface AppStore {
  cfg: api.AppConfig | null;
  status: api.ServerStatus;
  busy: boolean;
  bootError: string | null;
  bootState: "loading" | "ready" | "native-unavailable" | "error";
  actionError: string | null;
  statusPollError: string | null;
  getConfig: () => api.AppConfig | null;
  getConfigRevision: () => number;
  loadConfig: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  updateConfig: (patch: ConfigPatch<api.AppConfig>) => Promise<api.AppConfig>;
  start: (cfgOverride?: api.AppConfig, replaceRunning?: boolean) => Promise<string>;
  stop: () => Promise<void>;
  clearActionError: () => void;
  clearErrors: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


const START_TIMEOUT_MS = 120_000;
const STOP_TIMEOUT_MS = 20_000;
let configurationLoads: Promise<unknown> = Promise.resolve();

function loadMigratedConfig(): Promise<api.AppConfig> {
  const load = async () => {
    const loaded = normalizeAppConfig(await api.getConfig());
    const library = migrateProfileLibrary(loaded);
    if (JSON.stringify(library) === JSON.stringify(loaded.settings_profiles)) return loaded;
    library.revision += 1;
    return normalizeAppConfig(await api.saveConfig({ ...loaded, settings_profiles: library }));
  };
  // Serialize initialization in this window; Web Locks cover other windows.
  const pending = configurationLoads.catch(() => undefined).then(() => (
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('aiolm.settings-profiles.migration.v1', load)
      : load()
  ));
  configurationLoads = pending.catch(() => undefined);
  return pending;
}

function shallowEqual<T extends object>(left: T | undefined, right: T | undefined): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  const keys = Object.keys(left) as (keyof T)[];
  return keys.length === Object.keys(right).length && keys.every((key) => Object.is(left[key], right[key]));
}

/** IPC deserializes a fresh object on every poll, even when nothing changed. */
function sameServerStatus(left: api.ServerStatus, right: api.ServerStatus): boolean {
  const keys = Object.keys(left) as (keyof api.ServerStatus)[];
  return keys.length === Object.keys(right).length && keys.every((key) => {
    if (key === "memory") return shallowEqual(left.memory, right.memory);
    if (key === "lifecycle") return shallowEqual(left.lifecycle, right.lifecycle);
    if (key === 'execution') return JSON.stringify(left.execution) === JSON.stringify(right.execution);
    return Object.is(left[key], right[key]);
  });
}

export function useAppStore(options: { pollIntervalMs?: number; autoStart?: boolean } = {}): AppStore {
  const [cfg, setCfg] = useState<api.AppConfig | null>(null);
  const cfgRef = useRef<api.AppConfig | null>(null);
  const configRevisionRef = useRef(0);
  const [status, setStatus] = useState<api.ServerStatus>({ state: "stopped" });
  const [busy, setBusy] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootState, setBootState] = useState<AppStore["bootState"]>("loading");
  const [actionError, setActionError] = useState<string | null>(null);
  const [statusPollError, setStatusPollError] = useState<string | null>(null);
  const saveConfigQueue = useRef<((patch: ConfigPatch<api.AppConfig>) => Promise<api.AppConfig>) | null>(null);
  const pollInFlight = useRef(false);
  const operationInFlight = useRef(false);
  const autoStartConsumedRef = useRef(false);
  const statusGeneration = useRef(0);
  const pollFailures = useRef(0);
  const pollTimer = useRef<number | null>(null);
  const pollStopped = useRef(false);
  const configLoadInFlight = useRef<Promise<void> | null>(null);

  const loadConfig = useCallback((): Promise<void> => {
    if (configLoadInFlight.current) return configLoadInFlight.current;
    if (!api.isNativeRuntimeAvailable()) {
      setBootState("native-unavailable");
      setBootError("The native desktop runtime is unavailable. Run the packaged aiolm desktop app instead of the browser preview.");
      return Promise.resolve();
    }
    const pending = loadMigratedConfig().then(normalized => {
        cfgRef.current = normalized;
        configRevisionRef.current += 1;
        setCfg(normalized);
        setBootError(null);
        setBootState("ready");
      }).catch(error => {
        const message = errorMessage(error);
        setBootError(`Configuration could not be loaded: ${message}`);
        setBootState("error");
        throw error;
      }).finally(() => { configLoadInFlight.current = null; });
    configLoadInFlight.current = pending;
    return pending;
  }, []);

  const refreshStatus = useCallback(async () => {
    if (!api.isNativeRuntimeAvailable() || pollInFlight.current || operationInFlight.current || !shouldPoll(typeof document === "undefined" ? "unknown" : document.visibilityState)) return;
    pollInFlight.current = true;
    const generation = statusGeneration.current;
    try {
      const next = await api.serverStatus();
      if (generation === statusGeneration.current && !operationInFlight.current) setStatus((current) => sameServerStatus(current, next) ? current : next);
      if (generation === statusGeneration.current && !operationInFlight.current) setStatusPollError(null);
      pollFailures.current = 0;
    } catch (error) {
      pollFailures.current += 1;
      if (generation === statusGeneration.current && !operationInFlight.current) setStatusPollError(`Server status unavailable: ${errorMessage(error)}`);
    } finally {
      pollInFlight.current = false;
    }
  }, []);

  const updateConfig = useCallback(async (patch: ConfigPatch<api.AppConfig>) => {
    if (!saveConfigQueue.current) {
      saveConfigQueue.current = createConfigSaveQueue(
        () => cfgRef.current,
        (next) => { cfgRef.current = next; configRevisionRef.current += 1; setCfg(next); },
        (next) => api.saveConfig(next),
        (error) => setActionError(`Configuration was not saved: ${errorMessage(error)}`),
      );
    }
    const save = saveConfigQueue.current;
    if (!save) throw new Error("Configuration save queue is unavailable.");
    const saved = await save(normalizeConfigPatch((current) => withManualOverrides(current, typeof patch === "function" ? patch(current) : patch)));
    setActionError(null);
    return saved;
  }, []);

  const start = useCallback(async (cfgOverride?: api.AppConfig, replaceRunning = false) => {
    if (!api.isNativeRuntimeAvailable()) {
      const error = new Error("Native desktop runtime is unavailable. Run the packaged aiolm desktop app instead of the browser preview.");
      setActionError(error.message);
      throw error;
    }
    if (operationInFlight.current || (status.state === "running" && !replaceRunning) || status.state === "starting") return status.url ?? "";
    const current = cfgOverride ?? cfgRef.current;
    if (!current) throw new Error("Configuration is still loading.");
    setBusy(true); setActionError(null); setStatus({ state: "starting" }); operationInFlight.current = true; statusGeneration.current += 1;
    const generation = statusGeneration.current;
    try {
      const url = await withTimeout(api.startServer(current), START_TIMEOUT_MS, "Server start timed out after 120 seconds.");
      await refreshStatus();
      return url;
    } catch (error) {
      if (generation !== statusGeneration.current) throw error;
      if (isLifecycleCancellation(error)) {
        setStatus({ state: "stopped" });
        setActionError(null);
      } else {
        setStatus({ state: "failed", error: lifecycleErrorMessage("start", error) });
        setActionError(lifecycleErrorMessage("start", error));
      }
      throw error;
    } finally {
      if (generation === statusGeneration.current) {
        operationInFlight.current = false;
        await refreshStatus();
        if (generation === statusGeneration.current) setBusy(false);
      }
    }
  }, [refreshStatus, status.state, status.url]);

  const stop = useCallback(async () => {
    if (!api.isNativeRuntimeAvailable()) {
      const error = new Error("Native desktop runtime is unavailable. Run the packaged desktop app instead of the browser preview.");
      setActionError(error.message); throw error;
    }
    const cancellingStart = operationInFlight.current && status.state === "starting";
    if ((operationInFlight.current && !cancellingStart) || status.state === "stopping" || status.state === "stopped") return;
    setBusy(true); setActionError(null); setStatus((current) => ({ ...current, state: "stopping" })); operationInFlight.current = true; statusGeneration.current += 1;
    const generation = statusGeneration.current;
    try {
      await withTimeout(api.stopServer(), STOP_TIMEOUT_MS, "Server stop timed out after 20 seconds.");
      if (generation === statusGeneration.current) setStatus({ state: "stopped" });
    } catch (error) {
      if (generation !== statusGeneration.current) throw error;
      setStatus((current) => ({ ...current, state: "failed", error: lifecycleErrorMessage("stop", error) }));
      setActionError(lifecycleErrorMessage("stop", error));
      throw error;
    } finally {
      if (generation === statusGeneration.current) {
        operationInFlight.current = false;
        await refreshStatus();
        if (generation === statusGeneration.current) setBusy(false);
      }
    }
  }, [refreshStatus, status.state]);

  const clearActionError = useCallback(() => setActionError(null), []);
  const getConfig = useCallback(() => cfgRef.current, []);
  const getConfigRevision = useCallback(() => configRevisionRef.current, []);
  const clearErrors = useCallback(() => { setBootError(null); setActionError(null); setStatusPollError(null); setStatus((current) => ({ ...current, error: undefined })); }, []);

  useEffect(() => {
    void loadConfig().catch(() => undefined);
  }, [loadConfig]);

  useEffect(() => {
    if (!api.isNativeRuntimeAvailable()) return undefined;
    pollStopped.current = false;
    const schedule = () => {
      if (pollStopped.current || document.visibilityState === "hidden" || pollTimer.current !== null) return;
      const delay = nextPollDelay(options.pollIntervalMs ?? 1000, pollFailures.current);
      pollTimer.current = window.setTimeout(async () => {
        pollTimer.current = null;
        if (pollStopped.current || document.visibilityState === "hidden") return;
        await refreshStatus();
        schedule();
      }, delay);
    };
    void refreshStatus(); schedule();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
        pollTimer.current = null;
        return;
      }
      void refreshStatus();
      schedule();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => { pollStopped.current = true; if (pollTimer.current !== null) window.clearTimeout(pollTimer.current); pollTimer.current = null; document.removeEventListener("visibilitychange", onVisibility); };
  }, [options.pollIntervalMs, refreshStatus]);

  useEffect(() => {
    if (!shouldAutoStart(Boolean(options.autoStart), status.state, busy, autoStartConsumedRef.current, configRevisionRef.current)) return;
    autoStartConsumedRef.current = true;
    void start(cfg ?? undefined).catch(() => undefined);
  }, [options.autoStart, cfg, status.state, busy, start]);

  return { cfg, status, busy, bootError, bootState, actionError, statusPollError, getConfig, getConfigRevision, loadConfig, refreshStatus, updateConfig, start, stop, clearActionError, clearErrors };
}
