import { describe, expect, it } from "vitest";
import type { GpuPlacement } from "./api";
import { gpuTensorSplitDrafts, parseGpuTensorSplits, runtimeGpuDevices, toggleGpuSelection } from "./sessionUtils";

const placement: GpuPlacement = {
  gpu_ids: ["gpu-a", "gpu-b"],
  main_gpu: "gpu-a",
  split_mode: "layer",
  tensor_split: [0.25, 0.75],
  draft_gpu_id: null,
};

describe("GPU tensor split drafts", () => {
  it("keeps identical devices explicit and scoped to their runtime", () => {
    const devices = runtimeGpuDevices("rocm", ["Available devices:", "ROCm1: R9700 (32768 MiB)", "ROCm0: R9700 (32768 MiB)", "Vulkan0: R9700", "ROCm0: duplicate"]);
    expect(devices.map((gpu) => gpu.stable_id)).toEqual(["runtime:rocm:ROCm1", "runtime:rocm:ROCm0"]);
    expect(toggleGpuSelection(placement, "runtime:rocm:ROCm1", devices)).toEqual({ ...placement, gpu_ids: ["runtime:rocm:ROCm1"], main_gpu: null, tensor_split: [] });
  });
  it("keeps ratios associated with stable GPU IDs when selection order changes", () => {
    const drafts = gpuTensorSplitDrafts(placement);
    expect(parseGpuTensorSplits(drafts, ["gpu-b", "gpu-a"])).toEqual([0.75, 0.25]);
  });

  it("rejects incomplete ratios and clears splits for a single GPU", () => {
    expect(parseGpuTensorSplits({ "gpu-a": "1", "gpu-b": "" }, ["gpu-a", "gpu-b"])).toBeNull();
    expect(parseGpuTensorSplits({ "gpu-a": "0.5" }, ["gpu-a"])).toEqual([]);
  });
});
