import { describe, expect, it } from "vitest";
import type { BackendSuitability } from "../../shared/api/types";
import { reasonText } from "./runtimeRowPresentation";

const suitability = (reason: string): BackendSuitability => ({ backend: "metal", fit: "unsupported", reason });

describe("runtime compatibility explanations", () => {
  it("explains missing platform releases instead of exposing a translation key", () => {
    expect(reasonText("en", suitability("platformNotSupported"))).toBe("The release catalog has no build for this operating system and architecture.");
    expect(reasonText("ko", suitability("platformNotSupported"))).toContain("아키텍처");
    expect(reasonText("en", suitability("osNotSupported"))).toContain("operating system");
  });

  it.each(["en", "ko", "ja", "zh"] as const)("keeps known and future policy reasons readable in %s", (locale) => {
    for (const reason of ["vendorMatch", "needsNvidia", "needsAmd", "needsIntel", "integratedOnly", "portableGpu", "cpuFallback", "alwaysWorks", "noGpuDetected", "archNotSupported", "needsGpu", "osNotSupported", "platformNotSupported", "futurePolicy"]) {
      const text = reasonText(locale, { ...suitability(reason), device: "Synthetic GPU" });
      expect(text.trim()).not.toBe("");
      expect(text).not.toMatch(/^reason[A-Z]/);
    }
    expect(reasonText(locale, suitability("futurePolicy"))).not.toContain("futurePolicy");
  });

  it("does not invent a reason without a device verdict", () => {
    expect(reasonText("en")).toBe("");
  });
});
