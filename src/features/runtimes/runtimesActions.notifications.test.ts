import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { notifyCompletion } from "../../shared/lib/notifications";
import { runExportRuntime, runImportRuntime, runInstall } from "./runtimesActions";
import type { BackendRow } from "./runtimesHelpers";

vi.mock("../../shared/api/index", () => ({
  rtCancel: vi.fn(async () => undefined),
  rtInstall: vi.fn(async () => undefined),
  rtExport: vi.fn(async () => ({ backend: "cpu", build: "b1", path: "runtime.zip", archive_sha256: "00" })),
  rtImport: vi.fn(async () => ({ backend: "cpu", build: "b1" })),
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const deps = { locale: "en" as const, flashT: vi.fn(), setFailure: vi.fn(), serverRunning: false };
const refresh = vi.fn(async () => undefined);

beforeEach(() => vi.clearAllMocks());

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
