import { describe, expect, it } from "vitest";
import { canBuildPrBackend, defaultPrBackend, defaultPrBackendForDevice, formatRuntimeVersion, formatRecordedRuntimeVersion, isInstallCancellation, PR_BUILD_BACKENDS, runtimeRowAction } from "./runtimeUtils";

describe("runtime version labels", () => {
  it("names an installed runtime as version(build)", () => {
    expect(formatRuntimeVersion("b10638", { semver: "0.3.0-dev", build: 10638, commit: "bf9421646" })).toBe("0.3.0-dev(10638)");
  });

  it("marks a version nobody recorded instead of inventing one", () => {
    expect(formatRuntimeVersion("b10638")).toBe("?(10638)");
    expect(formatRuntimeVersion("b10603", null)).toBe("?(10603)");
    expect(formatRuntimeVersion("b10638", { semver: "", build: 10638, commit: "" })).toBe("?(10638)");
  });

  it("prefers the build the binary reported over a PR or local storage id", () => {
    expect(formatRuntimeVersion("pr12345", { semver: "0.3.0-dev", build: 10640, commit: "abc" })).toBe("0.3.0-dev(10640)");
    expect(formatRuntimeVersion("pr12345")).toBe("?(pr12345)");
    expect(formatRuntimeVersion("local_b10840_nop2p")).toBe("?(local_b10840_nop2p)");
    // llama.cpp reports build 0 when compiled without git: no number to prefer.
    expect(formatRuntimeVersion("pr12345", { semver: "0.0.0-dev", build: 0, commit: "" })).toBe("0.0.0-dev(pr12345)");
  });

  it("leaves another engine's own version untouched", () => {
    expect(formatRecordedRuntimeVersion("b123-abcdef", null, "n/a", "vllm")).toBe("b123-abcdef");
    expect(formatRuntimeVersion("b7", { semver: "0.6.3", build: 0, commit: "" }, "MLX")).toBe("0.6.3(b7)");
  });

  it("keeps the runtime a benchmark measured after the installation changes", () => {
    expect(formatRecordedRuntimeVersion("0.3.0-dev (build 123, commit abc123)", "b999", "n/a")).toBe("0.3.0-dev(123)");
    expect(formatRecordedRuntimeVersion("compiler: test\nversion: 0.3.0-dev (build 123)", "b999", "n/a")).toBe("0.3.0-dev(123)");
    expect(formatRecordedRuntimeVersion("version: 4589 (1a2b3c4)", "b999", "n/a")).toBe("?(4589)");
    expect(formatRecordedRuntimeVersion("b123-abcdef", "b999", "n/a")).toBe("?(123)");
    expect(formatRecordedRuntimeVersion("unknown", "b123", "n/a")).toBe("?(123)");
    expect(formatRecordedRuntimeVersion("", "", "n/a")).toBe("n/a");
  });
});

describe("backend row actions", () => {
  it("always offers cancel while the row is busy", () => {
    expect(runtimeRowAction({ busy: true, newestInstalled: false })).toBe("cancel");
    // A PR build marks the row busy even when the newest release build is
    // already installed; hiding the button there stranded the build.
    expect(runtimeRowAction({ busy: true, newestInstalled: true })).toBe("cancel");
  });

  it("offers an install only when the newest build is missing", () => {
    expect(runtimeRowAction({ busy: false, newestInstalled: false })).toBe("install");
    expect(runtimeRowAction({ busy: false, newestInstalled: true })).toBe("none");
  });
});

describe("install cancellation", () => {
  it("recognises the backend's own cancellation message", () => {
    expect(isInstallCancellation("runtime install cancelled")).toBe(true);
    expect(isInstallCancellation("Error: runtime install cancelled")).toBe(true);
  });

  it("does not mistake a build log that mentions cancelling for a cancellation", () => {
    // A swallowed failure shows as a four-second flash instead of an error the
    // user can read, so this distinction has to be exact.
    expect(isInstallCancellation("CMake building failed with exit code: 1: ninja: build stopped: operation cancelled by user request")).toBe(false);
    expect(isInstallCancellation("the operation was canceled by the remote host")).toBe(false);
    expect(isInstallCancellation("CMake configuring failed with exit code: 1")).toBe(false);
    expect(isInstallCancellation("")).toBe(false);
  });
});

describe("pull request build backends", () => {
  it("accepts only the backends the local builder can honestly produce", () => {
    expect([...PR_BUILD_BACKENDS]).toEqual(["cpu", "vulkan", "cuda", "rocm", "metal"]);
    for (const backend of PR_BUILD_BACKENDS) expect(canBuildPrBackend(backend)).toBe(true);
    for (const backend of ["sycl", "openvino", "", "unknown"]) {
      expect(canBuildPrBackend(backend), backend).toBe(false);
    }
  });

  it("falls back to a buildable backend when the preferred one is refused", () => {
    expect(defaultPrBackend("cuda")).toBe("cuda");
    expect(defaultPrBackend("rocm")).toBe("rocm");
  });

  it("chooses a safe PR backend from detected NVIDIA, AMD, Intel, and unknown profiles", () => {
    expect(defaultPrBackendForDevice({ backends: [{ backend: "cuda", fit: "recommended" }] })).toBe("cuda");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "rocm", fit: "recommended" }] })).toBe("rocm");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "metal", fit: "recommended" }] })).toBe("metal");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "sycl", fit: "recommended" }, { backend: "openvino", fit: "recommended" }, { backend: "vulkan", fit: "recommended" }] })).toBe("vulkan");
    expect(defaultPrBackendForDevice({ backends: [{ backend: "unknown", fit: "recommended" }, { backend: "cpu", fit: "recommended" }] })).toBe("cpu");
  });
});
