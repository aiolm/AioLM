import { beforeEach, describe, expect, it, vi } from "vitest";
import { acknowledgeUploadedBenchmark, takeBenchmarkMaintenanceWarnings } from "./desktopBenchmarkStorage.ts";
import { invoke, isNativeRuntimeAvailable } from "../api/transport.ts";
import type { QueuedBenchmark } from "./outbox.ts";

vi.mock("../api/transport.ts", () => ({ invoke: vi.fn(), isNativeRuntimeAvailable: vi.fn() }));
const receipt = { submission_id: "00000000-0000-4000-8000-000000000001", id: "synthetic-public" };
const accepted = () => ({
  id: receipt.submission_id, state: "sent", source: { runId: "synthetic-local-run" }, receipt,
  destination: "https://synthetic.example/v1/benchmark-runs",
}) as QueuedBenchmark;

beforeEach(() => {
  vi.clearAllMocks();
  takeBenchmarkMaintenanceWarnings();
  vi.mocked(isNativeRuntimeAvailable).mockReturnValue(true);
  vi.mocked(invoke).mockResolvedValue({ acknowledged: true, pruned: 0, warnings: [] });
});

describe("desktop copies of accepted benchmark results", () => {
  it("passes only the saved receipt and local linkage to native storage", async () => {
    await acknowledgeUploadedBenchmark(accepted());
    expect(invoke).toHaveBeenCalledWith("benchmark_acknowledge_upload", {
      runId: "synthetic-local-run", receipt: { ...receipt, destination: "https://synthetic.example/v1/benchmark-runs" },
    });
    expect(vi.mocked(invoke).mock.calls[0][1]).not.toHaveProperty("payload");
  });

  it("retries local persistence without treating unrelated cache warnings as an acknowledgement failure", async () => {
    vi.mocked(invoke).mockResolvedValueOnce({ acknowledged: false, pruned: 0, warnings: [] });
    await expect(acknowledgeUploadedBenchmark(accepted())).rejects.toThrow("uploaded");
    vi.mocked(invoke).mockResolvedValueOnce({ acknowledged: true, pruned: 0, warnings: ["An older cache file is temporarily locked"] });
    await expect(acknowledgeUploadedBenchmark(accepted())).resolves.toBeUndefined();
    expect(takeBenchmarkMaintenanceWarnings()).toEqual(["An older cache file is temporarily locked"]);
    expect(takeBenchmarkMaintenanceWarnings()).toEqual([]);
  });

  it("never marks unaccepted data or silently acknowledges a missing native store", async () => {
    await expect(acknowledgeUploadedBenchmark({ ...accepted(), state: "pending" })).rejects.toThrow("server receipt");
    expect(invoke).not.toHaveBeenCalled();
    vi.mocked(isNativeRuntimeAvailable).mockReturnValue(false);
    await expect(acknowledgeUploadedBenchmark(accepted())).rejects.toThrow("unavailable");
    await acknowledgeUploadedBenchmark({ ...accepted(), source: undefined });
    expect(invoke).not.toHaveBeenCalled();
  });
});
