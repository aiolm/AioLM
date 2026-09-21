import { useEffect, useState } from "react";
import * as api from "../api/index";
import { formatRuntimeVersion } from "./runtimeUtils";

/**
 * The installed runtime list, shared by every surface that names a runtime.
 *
 * A build id such as `b10638` is what the app stores and what the filesystem
 * is keyed by, but it is not the version llama.cpp calls itself. Only the
 * install record knows that, so panels that hold nothing but a build id read
 * it from here rather than dressing the number up as a version.
 *
 * One read serves them all: the list changes only when a runtime is installed
 * or removed, and the runtimes panel publishes each list it reads.
 */
let cache: api.InstalledRuntime[] | null = null;
let pending: Promise<void> | null = null;
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of [...listeners]) listener();
}

/** Hand the shared cache a list that was just read, from anywhere. */
export function publishInstalledRuntimes(runtimes: api.InstalledRuntime[]): void {
  cache = runtimes;
  announce();
}

function ensureLoaded(): Promise<void> {
  if (cache) return Promise.resolve();
  pending ??= (async () => {
    try {
      cache = api.isNativeRuntimeAvailable() ? await api.rtList() : [];
    } catch {
      // Naming a runtime is a label, never a gate: an unreadable list leaves
      // the honest build number in place instead of failing the surface.
      cache = [];
    }
    pending = null;
    announce();
  })();
  return pending;
}

export function useInstalledRuntimes(): api.InstalledRuntime[] {
  const [runtimes, setRuntimes] = useState<api.InstalledRuntime[]>(() => cache ?? []);
  useEffect(() => {
    let live = true;
    const sync = () => { if (live) setRuntimes(cache ?? []); };
    listeners.add(sync);
    void ensureLoaded().then(sync);
    return () => { live = false; listeners.delete(sync); };
  }, []);
  return runtimes;
}

/**
 * `0.3.0-dev` when the install recorded what the binary calls
 * itself, `build 10638` when it did not. Never a version invented from the
 * build number.
 */
export function runtimeVersionLabel(
  runtimes: readonly api.InstalledRuntime[],
  backend: string,
  build: string,
): string {
  const installed = runtimes.find((item) => item.backend === backend && item.build === build);
  return formatRuntimeVersion(build, installed?.version);
}

export function useRuntimeVersionLabel(backend: string, build: string): string {
  return runtimeVersionLabel(useInstalledRuntimes(), backend, build);
}

/** Test seam: forget the shared list so the next read goes to the backend. */
export function resetInstalledRuntimes(): void {
  cache = null;
  pending = null;
  announce();
}
