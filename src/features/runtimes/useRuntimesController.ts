import { useCallback, useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { defaultPrBackendForDevice } from "../../shared/runtime/runtimeUtils";
import { publishInstalledRuntimes } from "../../shared/runtime/installedRuntimes";
import { useI18n } from "../../shared/i18n/i18n";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { isServerRunning } from "../../shared/lib/serverLifecycle";
import { useFlashMessage } from "../../shared/hooks/useFlashMessage";
import { updateTask } from "../../shared/state/taskRegistry";
import { BACKENDS, initialRows, mergeBackendRows, readLatestCache, readShowAll, writeLatestCache, writeShowAll, type BackendRow } from "./runtimesHelpers";
import { runExportRuntime, runImportRuntime, runInstall, runInstallPullRequest, runReviewPullRequest } from "./runtimesActions";

/** Owns all Runtimes panel state: backend catalog rows, device detection, the
 * two-step pull-request build flow, portable bundle import/export, and the native install-progress subscription.
 *
 * The panel manages installed builds and nothing else: it probes exactly the
 * build the user asks about and never reads the execution configuration, which
 * belongs to the profile a model is launched with. */
export function useRuntimesController(store: AppStore, active: boolean) {
  const { locale, t } = useI18n();
  const [rows, setRows] = useState<BackendRow[]>(initialRows);
  const [flash, flashT] = useFlashMessage();
  // Failures stay on screen until dismissed; a 4s flash is not long enough to
  // read a preflight diagnostic, let alone act on it.
  const [failure, setFailure] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<api.RuntimeCapabilities | null>(null);
  // The build the shown capabilities describe, so the card never reports one
  // build's flags under another build's name.
  const [probeTarget, setProbeTarget] = useState<{ backend: string; build: string } | null>(null);
  const [probeBusy, setProbeBusy] = useState(false);
  const [prBackend, setPrBackend] = useState(() => defaultPrBackendForDevice(null));
  const [prSource, setPrSource] = useState("");
  const [prBusy, setPrBusy] = useState(false);
  const [bundleBusy, setBundleBusy] = useState(false);
  const [bundleProgress, setBundleProgress] = useState<api.DownloadProgress | null>(null);
  const [activePrBackend, setActivePrBackend] = useState<string | null>(null);
  const [prReviewBusy, setPrReviewBusy] = useState(false);
  // The resolved pull request awaiting confirmation. Holding the backend and
  // the raw source alongside it keeps the build bound to what was reviewed.
  const [prPreview, setPrPreview] = useState<{ backend: string; source: string; preview: api.PullRequestPreview } | null>(null);
  const [pendingUninstall, setPendingUninstall] = useState<{ backend: string; build: string } | null>(null);
  const [uninstallBusy, setUninstallBusy] = useState(false);
  // A cancel is a one-shot request to the backend; a second click while the
  // first is in flight would only produce a duplicate failure banner.
  const [cancelBusy, setCancelBusy] = useState(false);
  const [device, setDevice] = useState<api.DeviceReport | null>(null);
  const [showAll, setShowAll] = useState(readShowAll);
  const unsubRef = useRef<(() => void) | null>(null);
  const refreshGeneration = useRef(0);
  const probeGeneration = useRef(0);
  const prBackendTouched = useRef(false);
  const prInstallInFlight = useRef(false);
  const serverRunning = isServerRunning(store.status.state);
  const runtimeBusy = bundleBusy || prBusy || rows.some((row) => row.busy);

  // A probe names the build it describes, so a later one always wins and a
  // result can never be read as belonging to a different build.
  const probe = useCallback(async (backend: string, build: string) => {
    const generation = ++probeGeneration.current;
    setProbeTarget({ backend, build });
    setProbeBusy(true);
    try {
      const result = await api.rtProbe(backend, build);
      if (generation !== probeGeneration.current) return;
      setCapabilities(result);
      setLoadError(null);
    } catch (error) {
      if (generation !== probeGeneration.current) return;
      setCapabilities(null);
      setLoadError(`${t("ui.preflightFailed")}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (generation === probeGeneration.current) setProbeBusy(false);
    }
  }, [t]);

  // Leaving the panel abandons an in-flight probe rather than applying its
  // result to a card the user is no longer looking at.
  useEffect(() => {
    if (!active) setProbeBusy(false);
    return () => { probeGeneration.current += 1; };
  }, [active]);

  const fail = (label: string, error: unknown) => {
    setFailure(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  };

  const refresh = useCallback(async (force = false) => {
    const generation = ++refreshGeneration.current;
    setLoadError(null);
    try {
      const installed = await api.rtList();
      if (generation !== refreshGeneration.current) return;
      publishInstalledRuntimes(installed);
      const cached = force ? null : readLatestCache();
      if (cached) {
        setRows((previous) => mergeBackendRows(previous, installed).map((row) => ({
          ...row,
          installed: installed.filter((item) => item.backend === row.backend),
          latest: cached.infos[row.backend] ?? null,
          latestErr: cached.infos[row.backend] ? null : cached.errors?.[row.backend] ?? null,
        })));
        return;
      }
      const probes = await Promise.all(BACKENDS.map(async (backend) => {
        try {
          return { backend: backend.id, info: await api.rtLatest(backend.id, force), error: null as string | null };
        } catch (error) {
          return { backend: backend.id, info: null, error: error instanceof Error ? error.message : String(error) };
        }
      }));
      if (generation !== refreshGeneration.current) return;
      const infos: Record<string, api.LatestInfo> = {};
      const errors: Record<string, string> = {};
      for (const probeResult of probes) {
        if (probeResult.info) infos[probeResult.backend] = probeResult.info;
        else if (probeResult.error) errors[probeResult.backend] = probeResult.error;
      }
      if (Object.keys(infos).length > 0 || Object.keys(errors).length > 0) writeLatestCache(infos, errors);
      setRows((previous) => mergeBackendRows(previous, installed).map((row) => ({
        ...row,
        installed: installed.filter((item) => item.backend === row.backend),
        latest: infos[row.backend] ?? null,
        latestErr: probes.find((probeResult) => probeResult.backend === row.backend)?.error ?? null,
      })));
    } catch (error) {
      if (generation !== refreshGeneration.current) return;
      const message = error instanceof Error ? error.message : String(error);
      setLoadError(message);
      setRows((previous) => previous.map((row) => ({ ...row, latestErr: row.latestErr ?? message })));
    }
  }, []);

  useEffect(() => {
    // Cheap (a few registry reads) and re-read on every visit so swapping a GPU
    // or driver is reflected without restarting the app.
    if (active) {
      void api.deviceProfile().then((report) => {
        setDevice(report);
        if (!prBackendTouched.current) setPrBackend(defaultPrBackendForDevice(report));
      }).catch(() => setDevice(null));
      void refresh();
    }
  }, [active, refresh]);

  // Keep the native progress subscription for the lifetime of the mounted
  // panel. App keeps the panel mounted after first visit, so navigating away
  // must not drop progress events from a still-running PR build.
  useEffect(() => {
    let mounted = true;
    void api.onRuntimeProgress((progress) => {
      if (!mounted) return;
      if (progress.backend === "import" || progress.backend === "export") {
        setBundleProgress(progress);
      } else {
        setRows((previous) => previous.map((row) => row.backend === progress.backend ? { ...row, progress } : row));
      }
      updateTask("runtime-operation", { phase: progress.phase, received: progress.received, total: progress.total });
    }).then((unlisten) => {
      if (mounted) unsubRef.current = unlisten;
      else unlisten();
    }).catch(() => {
      // Browser preview does not expose native runtime progress events.
    });
    return () => {
      mounted = false;
      unsubRef.current?.();
    };
  }, []);

  const cancelInstall = async () => {
    if (cancelBusy) return;
    setCancelBusy(true);
    try {
      await api.rtCancel();
      flashT(t("ui.cancelRequested"));
    } catch (error) {
      fail(t("ui.cancelFailed"), error);
    } finally {
      setCancelBusy(false);
    }
  };

  const commonDeps = { locale, flashT, setFailure, serverRunning };
  const exportRuntime = (backend: string, build: string) => runExportRuntime(backend, build, runtimeBusy, setBundleBusy, setBundleProgress, commonDeps);
  const importRuntime = () => runImportRuntime(runtimeBusy, setBundleBusy, setBundleProgress, refresh, commonDeps);
  const install = (backend: string) => runInstall(backend, rows, setRows, refresh, prBusy, bundleBusy, commonDeps);
  const reviewPullRequest = () => runReviewPullRequest(prSource, prBackend, rows, prBusy, bundleBusy, prReviewBusy, setPrReviewBusy, setPrPreview, commonDeps);

  const installPullRequest = () => {
    if (!prPreview) return Promise.resolve();
    return runInstallPullRequest({
      pending: prPreview,
      prInstallInFlight,
      prBusy,
      bundleBusy,
      rows,
      setPrPreview,
      setPrBusy,
      setActivePrBackend,
      setCancelBusy,
      setPrSource,
      setRows,
      refresh,
    }, commonDeps);
  };

  const performUninstall = async (backend: string, build: string) => {
    if (uninstallBusy) return;
    setFailure(null);
    setUninstallBusy(true);
    try {
      await api.rtUninstall(backend, build);
      flashT(t("ui.uninstalledOk", { backend, build }));
      // Removing a build clears it from every profile that named it, so the
      // panel reloads the configuration rather than keeping a selection that
      // no longer exists on disk.
      await Promise.all([refresh(), store.loadConfig()]);
    } catch (error) {
      fail(t("ui.uninstallFailed"), error);
    } finally {
      setUninstallBusy(false);
      setPendingUninstall(null);
    }
  };

  const uninstall = async (backend: string, build: string) => {
    if (runtimeBusy) return;
    if (serverRunning) {
      flashT(t("ui.stopBeforeRemoveRuntime"));
      return;
    }
    if (shouldConfirmDestructive()) setPendingUninstall({ backend, build });
    else void performUninstall(backend, build);
  };

  const confirmUninstall = async () => {
    if (!pendingUninstall) return;
    await performUninstall(pendingUninstall.backend, pendingUninstall.build);
  };

  const toggleShowAll = () => {
    const next = !showAll;
    setShowAll(next);
    writeShowAll(next);
  };

  return {
    locale, rows, flash, flashT, failure, setFailure, loadError, capabilities, probeBusy,
    prBackend, setPrBackend, prBackendTouched,
    prSource, setPrSource, prBusy, bundleBusy, bundleProgress, activePrBackend, prReviewBusy,
    prPreview, setPrPreview, pendingUninstall, setPendingUninstall, uninstallBusy, cancelBusy,
    device, showAll, toggleShowAll, probeTarget, serverRunning, runtimeBusy,
    probe, refresh,
    cancelInstall, exportRuntime, importRuntime, install,
    reviewPullRequest, installPullRequest, uninstall, confirmUninstall,
  };
}
