// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { notifyCompletion } from "../../shared/lib/notifications";
import { runExportRuntime, runImportRuntime, runInstall, runInstallPullRequest } from "./runtimesActions";
import type { BackendRow } from "./runtimesHelpers";
import { IpcError } from "../../shared/api/ipcError";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";

vi.mock("../../shared/api/index", () => ({
  rtCancel: vi.fn(async () => undefined),
  rtInstall: vi.fn(async () => undefined),
  rtInstallPr: vi.fn(async () => undefined),
  rtExport: vi.fn(async () => ({ backend: "cpu", build: "b1", path: "runtime.zip", archive_sha256: "00" })),
  rtImport: vi.fn(async () => ({ backend: "cpu", build: "b1" })),
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const deps = { locale: "en" as const, flashT: vi.fn(), setFailure: vi.fn(), serverRunning: false };
const refresh = vi.fn(async () => undefined);

beforeEach(() => {
  vi.clearAllMocks();
  for (const task of getTaskSnapshot()) removeTask(task.id);
});

describe("runtime completion notifications", () => {
  it("announces a finished installation as a download", async () => {
    const rows = [{ backend: "cpu", latest: { build: "b1" } }] as unknown as BackendRow[];
    await runInstall("cpu", rows, vi.fn(), refresh, false, false, deps);
    expect(vi.mocked(notifyCompletion).mock.calls).toEqual([["download"]]);
  });

  it("stays silent for a failed installation, an export and an import", async () => {
    vi.mocked(api.rtInstall).mockRejectedValueOnce(new Error("network down"));
    const rows = [{ backend: "cpu", latest: { build: "b1" } }] as unknown as BackendRow[];
    await runInstall("cpu", rows, vi.fn(), refresh, false, false, deps);
    await runExportRuntime("cpu", "b1", false, vi.fn(), vi.fn(), deps);
    await runImportRuntime(false, vi.fn(), vi.fn(), refresh, deps);
    expect(notifyCompletion).not.toHaveBeenCalled();
  });
});

describe("native runtime cancellation kinds", () => {
  const rows = [{ backend: "cpu", latest: { build: "b1" } }] as unknown as BackendRow[];
  const operations = [
    { name: "install", reject: (cause: Error) => vi.mocked(api.rtInstall).mockRejectedValueOnce(cause),
      run: () => runInstall("cpu", rows, vi.fn(), refresh, false, false, deps) },
    { name: "export", reject: (cause: Error) => vi.mocked(api.rtExport).mockRejectedValueOnce(cause),
      run: () => runExportRuntime("cpu", "b1", false, vi.fn(), vi.fn(), deps) },
    { name: "import", reject: (cause: Error) => vi.mocked(api.rtImport).mockRejectedValueOnce(cause),
      run: () => runImportRuntime(false, vi.fn(), vi.fn(), refresh, deps) },
    { name: "PR build", reject: (cause: Error) => vi.mocked(api.rtInstallPr).mockRejectedValueOnce(cause),
      run: () => runInstallPullRequest({
        pending: { backend: "cpu", source: "123", preview: { commit: "a".repeat(40) } as api.PullRequestPreview },
        rows, prBusy: false, bundleBusy: false, refresh, setRows: vi.fn(), setPrPreview: vi.fn(),
        setPrBusy: vi.fn(), setActivePrBackend: vi.fn(), setCancelBusy: vi.fn(), setPrSource: vi.fn(),
      }, deps) },
  ];

  it.each(operations)("handles typed $name cancellation independently of wording", async operation => {
    operation.reject(new IpcError("cancelled", "Operation stopped at your request"));
    await operation.run();
    expect(getTaskSnapshot()).toEqual([expect.objectContaining({ state: "cancelled" })]);
    expect(deps.setFailure).toHaveBeenCalledExactlyOnceWith(null);
    expect(notifyCompletion).not.toHaveBeenCalled();
  });

  it.each(operations)("keeps $name diagnostics mentioning cancellation as failures", async operation => {
    const message = "runtime install cancelled";
    operation.reject(new IpcError("internal", message));
    await operation.run();
    expect(getTaskSnapshot()).toEqual([expect.objectContaining({ state: "failed", detail: message })]);
    expect(deps.setFailure).toHaveBeenLastCalledWith(expect.stringContaining(message));
    expect(notifyCompletion).not.toHaveBeenCalled();
  });
});
