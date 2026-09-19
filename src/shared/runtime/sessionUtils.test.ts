import { describe, expect, it } from "vitest";
import type { AppConfig, GpuPlacement, SessionDefinition } from "../api/types";
import { gpuTensorSplitDrafts, parseGpuTensorSplits, resolvedGpuPlacement, runtimeGpuDevices, sessionConfig, toggleGpuSelection } from "./sessionUtils";

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

describe("session execution settings", () => {
  const config = { active_model: "default.gguf", mmproj: "default-projector.gguf", spec_draft_model: "", temperature: 0.8, ctx_size: 4096, models_dir: "models", port: 8080, gpu: placement, chat_options: { stop: ["end"] } } as unknown as AppConfig;
  const definition: SessionDefinition = { id: "work", name: "Work", enabled: true, models: { primary_model: "work.gguf", mmproj: "", draft_model: "draft.gguf" }, gpu: { ...placement, gpu_ids: ["gpu-c"] } };

  it("inherits the existing defaults when a stored session has no execution override", () => {
    expect(sessionConfig(config, definition)).toMatchObject({ active_model: "work.gguf", mmproj: "", temperature: 0.8, ctx_size: 4096, port: 8080, gpu: definition.gpu });
  });

  it("keeps a named session's execution and nested request settings independent", () => {
    const selected = { ...definition, execution: { ctx_size: 8192, temperature: 0.3, chat_options: { stop: ["done"] } } };
    const resolved = sessionConfig(config, selected);
    expect(resolved).toMatchObject({ active_model: "work.gguf", ctx_size: 8192, temperature: 0.3, chat_options: { stop: ["done"] } });
    (resolved.chat_options.stop as string[]).push("another");
    resolved.gpu?.gpu_ids.push("gpu-d");
    expect(selected.execution.chat_options.stop).toEqual(["done"]);
    expect(definition.gpu.gpu_ids).toEqual(["gpu-c"]);
    expect(config.temperature).toBe(0.8);
  });

  it("ignores app preferences and duplicate model bindings in an untrusted override", () => {
    const selected = { ...definition, execution: { temperature: 0.2, active_model: "other.gguf", models_dir: "private", port: 9090, gpu: placement } };
    expect(sessionConfig(config, selected)).toMatchObject({ active_model: "work.gguf", models_dir: "models", port: 8080, gpu: definition.gpu, temperature: 0.2 });
  });
});

describe("resolved GPU placement", () => {
  it("names the first selected device and the layer split that llama.cpp already defaults to", () => {
    // --main-gpu indexes the selected --device list, so index 0 is the first
    // selection; both substitutions therefore launch exactly as the legacy
    // empty values did, they just say so in the editor.
    expect(resolvedGpuPlacement({ ...placement, main_gpu: null, split_mode: "none" }))
      .toEqual({ ...placement, main_gpu: "gpu-a", split_mode: "layer" });
  });

  it("re-points a main GPU that is no longer selected", () => {
    expect(resolvedGpuPlacement({ ...placement, main_gpu: "gpu-gone" }).main_gpu).toBe("gpu-a");
  });

  it("leaves an empty selection without a main GPU to name", () => {
    const empty = resolvedGpuPlacement({ ...placement, gpu_ids: [], main_gpu: null, split_mode: "none" });
    expect(empty.main_gpu).toBeNull();
    expect(empty.split_mode).toBe("layer");
  });

  it("returns the same object when nothing needs resolving", () => {
    expect(resolvedGpuPlacement(placement)).toBe(placement);
  });
});
