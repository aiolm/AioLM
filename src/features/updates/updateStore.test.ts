// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_UPDATE_TASK_ID, createUpdateStore } from "./updateStore";
import { getDownloadCenterSnapshot, getModelDownloadSnapshot, getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import type { AppUpdateInfo, AppUpdateProgress } from "../../shared/api/appUpdates";

afterEach(() => {
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

const release: AppUpdateInfo = {
  current_version: "1.0.0", latest_version: "1.1.0", available: true, can_install: true,
  release_url: "https://github.com/aiolm/AioLM/releases/tag/v1.1.0", published_at: null, notes: "Update notes",
};

function fixture(native = true) {
  let progress: ((value: AppUpdateProgress) => void) | undefined;
  const unlisten = vi.fn();
  const client = {
    isNative: () => native,
    check: vi.fn(async (): Promise<AppUpdateInfo> => release),
    install: vi.fn(async (_version: string) => undefined),
    listen: vi.fn(async (callback: (value: AppUpdateProgress) => void) => { progress = callback; return unlisten; }),
  };
  return { store: createUpdateStore(client), client, unlisten, emit: (value: AppUpdateProgress) => progress?.(value) };
}

describe("application update lifecycle", () => {
  it("checks once at startup and shares an in-flight request with manual checks", async () => {
    const { store, client } = fixture();
    const first = store.checkOnStartup();
    const manual = store.check();
    await Promise.all([first, manual, store.checkOnStartup()]);
    expect(client.check).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({ phase: "checked", info: release });
    await store.check();
    expect(client.check).toHaveBeenCalledTimes(2);
    expect(client.install).not.toHaveBeenCalled();
  });

  it("does not contact the native updater in a browser preview", async () => {
    const { store, client } = fixture(false);
    await store.checkOnStartup(); await store.check(); await store.install();
    expect(client.check).not.toHaveBeenCalled(); expect(client.listen).not.toHaveBeenCalled(); expect(client.install).not.toHaveBeenCalled();
    expect(store.getSnapshot().phase).toBe("idle");
  });

  it("keeps failures actionable and allows a manual retry after a failed startup check", async () => {
    const { store, client } = fixture();
    client.check.mockRejectedValueOnce(new Error("Network unavailable"));
    await store.checkOnStartup();
    expect(store.getSnapshot()).toMatchObject({ phase: "error", errorKind: "check", error: "Network unavailable" });
    await store.checkOnStartup();
    expect(client.check).toHaveBeenCalledTimes(1);
    await store.check();
    expect(store.getSnapshot()).toMatchObject({ phase: "checked", error: null, info: release });
  });

  it("dismisses only the announced version and replaces stale availability after a check", async () => {
    const { store, client } = fixture();
    await store.check(); store.dismiss();
    expect(store.getSnapshot().dismissedVersion).toBe("1.1.0");
    client.check.mockResolvedValueOnce({ ...release, latest_version: "1.2.0" });
    await store.check();
    expect(store.getSnapshot().info?.latest_version).not.toBe(store.getSnapshot().dismissedVersion);
    client.check.mockResolvedValueOnce({ ...release, latest_version: "1.0.0", available: false });
    await store.check();
    expect(store.getSnapshot().info?.available).toBe(false);
  });

  it("subscribes before installation, reports progress, and blocks duplicate installs and checks", async () => {
    const { store, client, emit, unlisten } = fixture();
    await store.check();
    let complete!: () => void;
    client.install.mockImplementation(() => new Promise(resolve => { complete = () => resolve(undefined); }));
    const first = store.install();
    expect(store.install()).toBe(first);
    await Promise.resolve();
    expect(client.install).toHaveBeenCalledExactlyOnceWith("1.1.0");
    expect(client.listen).toHaveBeenCalledTimes(1);
    await store.check();
    expect(client.check).toHaveBeenCalledTimes(1);
    emit({ phase: "downloading", downloaded: 50, total: 100 });
    expect(store.getSnapshot().progress).toEqual({ phase: "downloading", downloaded: 50, total: 100 });
    emit({ phase: "verifying", downloaded: 100, total: 100 });
    expect(store.getSnapshot().phase).toBe("verifying");
    complete(); await first;
    expect(unlisten).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().phase).toBe("installer-started");
    await store.install();
    expect(client.install).toHaveBeenCalledTimes(1);
  });

  it("retains the update and releases the listener after installation fails so the user can retry", async () => {
    const { store, client, unlisten, emit } = fixture();
    await store.check();
    client.install.mockRejectedValueOnce("Checksum mismatch");
    await store.install();
    expect(store.getSnapshot()).toMatchObject({ phase: "error", errorKind: "install", error: "Checksum mismatch", info: release });
    expect(unlisten).toHaveBeenCalledTimes(1);
    emit({ phase: "downloading", downloaded: 10, total: 100 });
    expect(store.getSnapshot().phase).toBe("error");
    await store.install();
    expect(client.install).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot().phase).toBe("installer-started");
  });

  it("never installs when a new release is absent or installation is unsupported", async () => {
    const { store, client } = fixture();
    await store.install();
    client.check.mockResolvedValueOnce({ ...release, can_install: false });
    await store.check(); await store.install();
    client.check.mockResolvedValueOnce({ ...release, available: false });
    await store.check(); await store.install();
    expect(client.install).not.toHaveBeenCalled();
    expect(client.listen).not.toHaveBeenCalled();
  });

  it("publishes installer download progress into DownloadsCenter with speed and settles on completion or failure", async () => {
    const { store, client, emit } = fixture();
    await store.check();
    let rejectInstall!: (reason?: unknown) => void;
    let resolveInstall!: () => void;
    let now = 1000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    client.install
      .mockImplementationOnce(() => new Promise<undefined>((_, reject) => { rejectInstall = reject; }))
      .mockImplementationOnce(() => new Promise<undefined>((resolve) => { resolveInstall = () => resolve(undefined); }));

    try {
      const failedInstall = store.install();
      await Promise.resolve();
      await Promise.resolve();
      expect(getModelDownloadSnapshot()).toHaveLength(0);
      expect(getDownloadCenterSnapshot().map(task => task.id)).toContain(APP_UPDATE_TASK_ID);

      now = 1000;
      emit({ phase: "downloading", downloaded: 0, total: 10_000_000 });
      now = 2000;
      emit({ phase: "downloading", downloaded: 2_500_000, total: 10_000_000 });
      expect(getDownloadCenterSnapshot().find(task => task.id === APP_UPDATE_TASK_ID)).toMatchObject({
        label: "AioLM 1.1.0",
        downloadKind: "app-update",
        phase: "downloading",
        received: 2_500_000,
        total: 10_000_000,
        speedBps: 2_500_000,
      });

      rejectInstall(new Error("Download interrupted"));
      await failedInstall;
      expect(getTaskSnapshot().find(task => task.id === APP_UPDATE_TASK_ID)).toMatchObject({
        state: "failed",
        detail: "Download interrupted",
      });

      // Retry after error verifies speed state resets cleanly and settles as completed.
      const retryInstall = store.install();
      await Promise.resolve();
      await Promise.resolve();
      emit({ phase: "verifying", downloaded: 10_000_000, total: 10_000_000 });
      expect(getDownloadCenterSnapshot().find(task => task.id === APP_UPDATE_TASK_ID)?.speedBps).toBeUndefined();

      resolveInstall();
      await retryInstall;
      expect(getTaskSnapshot().find(task => task.id === APP_UPDATE_TASK_ID)?.state).toBe("completed");
    } finally {
      nowSpy.mockRestore();
    }
  });
});
