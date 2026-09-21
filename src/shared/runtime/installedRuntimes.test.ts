import { describe, expect, it } from "vitest";
import type { InstalledRuntime } from "../api/types";
import { runtimeVersionLabel } from "./installedRuntimes";

const installed: InstalledRuntime[] = [
  { backend: "cuda", build: "b10638", dir: "runtimes/cuda-b10638", size_mb: 512, version: { semver: "0.3.0-dev", build: 10638, commit: "bf9421646" } },
  { backend: "cpu", build: "b10638", dir: "runtimes/cpu-b10638", size_mb: 256 },
];

describe("naming an installed runtime", () => {
  it("prefers the version the binary reports over its build number", () => {
    expect(runtimeVersionLabel(installed, "cuda", "b10638")).toBe("0.3.0-dev");
  });

  it("falls back to the build number when no version was recorded", () => {
    expect(runtimeVersionLabel(installed, "cpu", "b10638")).toBe("build 10638");
  });

  it("never lends one backend's version to another that shares a build number", () => {
    expect(runtimeVersionLabel(installed, "vulkan", "b10638")).toBe("build 10638");
  });

  it("still names a build that is no longer installed, without inventing a version", () => {
    expect(runtimeVersionLabel([], "cuda", "b10638")).toBe("build 10638");
    expect(runtimeVersionLabel([], "cuda", "local_b10840_nop2p")).toBe("build local_b10840_nop2p");
  });
});
