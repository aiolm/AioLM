import { describe, expect, it } from "vitest";
import { runSetupGapMessage, runSetupGaps } from "./runReadiness";

const ready = { activeModel: "model.gguf", activeBackend: "cpu", activeBuild: "b123" };

describe("run setup gaps", () => {
  it("reports nothing when a model and an installed runtime are selected", () => {
    expect(runSetupGaps({ ...ready, runtimeInstalled: true })).toEqual([]);
  });

  it("names a missing model and a missing runtime together", () => {
    expect(runSetupGaps({ activeModel: "  ", activeBackend: "", activeBuild: "" })).toEqual(["model", "runtime"]);
  });

  it("treats a half-selected runtime as no runtime", () => {
    expect(runSetupGaps({ ...ready, activeBuild: "" })).toEqual(["runtime"]);
    expect(runSetupGaps({ ...ready, activeBackend: " " })).toEqual(["runtime"]);
  });

  it("reports an incomplete model only once a model is actually selected", () => {
    expect(runSetupGaps({ ...ready, modelIncomplete: true })).toEqual(["modelShards"]);
    expect(runSetupGaps({ ...ready, activeModel: "", modelIncomplete: true })).toEqual(["model"]);
  });

  it("only calls a runtime missing when the installed list was consulted", () => {
    expect(runSetupGaps(ready)).toEqual([]);
    expect(runSetupGaps({ ...ready, runtimeInstalled: false })).toEqual(["runtimeMissing"]);
  });

  it("has translated wording for every gap in every locale", () => {
    for (const locale of ["en", "ko", "ja", "zh"] as const) {
      for (const gap of ["model", "modelShards", "runtime", "runtimeMissing"] as const) {
        expect(runSetupGapMessage(gap, locale).trim()).not.toBe("");
      }
    }
    expect(runSetupGapMessage("model", "en")).toBe("No model is selected.");
    expect(runSetupGapMessage("runtimeMissing", "en")).toBe("This runtime is not installed. Install it or select another runtime.");
  });
});
