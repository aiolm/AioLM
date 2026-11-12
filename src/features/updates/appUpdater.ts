import { useSyncExternalStore } from "react";
import { isNativeRuntimeAvailable } from "../../shared/api/transport";
import { checkAppUpdate, installAppUpdate, onAppUpdateProgress } from "../../shared/api/appUpdates";
import { errorMessage } from "../../shared/api/errors";
import { createUpdateStore } from "./updateStore";

function updateFailure(cause: unknown): never {
  throw new Error(errorMessage(cause));
}

export const appUpdater = createUpdateStore({
  isNative: isNativeRuntimeAvailable,
  check: () => checkAppUpdate().catch(updateFailure),
  install: version => installAppUpdate(version).catch(updateFailure),
  listen: onProgress => onAppUpdateProgress(onProgress).catch(updateFailure),
});

export function useAppUpdate(updater = appUpdater) {
  return useSyncExternalStore(updater.subscribe, updater.getSnapshot, updater.getSnapshot);
}

export { openAppUpdateRelease } from "../../shared/api/appUpdates";
