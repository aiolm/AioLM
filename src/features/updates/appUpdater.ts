import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { invoke, isNativeRuntimeAvailable } from "../../shared/api/transport";
import { createUpdateStore, type AppUpdateInfo, type AppUpdateProgress } from "./updateStore";

export const appUpdater = createUpdateStore({
  isNative: isNativeRuntimeAvailable,
  check: () => invoke<AppUpdateInfo>("check_app_update"),
  install: version => invoke<void>("install_app_update", { version }),
  listen: onProgress => listen<AppUpdateProgress>("app-update-progress", event => onProgress(event.payload)),
});

export function useAppUpdate(updater = appUpdater) {
  return useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
}

export const openAppUpdateRelease = () => invoke<void>("open_app_update_release");
