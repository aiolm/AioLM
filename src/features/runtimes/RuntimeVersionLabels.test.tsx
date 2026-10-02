import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { translate, type UnifiedKey, type TranslationVars } from "../../shared/i18n/i18nUnified";
import type { InstalledRuntime, RuntimeCapabilities } from "../../shared/api/types";
import RuntimeBackendRow from "./RuntimeBackendRow";
import RuntimeCapabilitiesCard from "./RuntimeCapabilitiesCard";
import { initialRows } from "./runtimesHelpers";

const t = (key: UnifiedKey, vars?: TranslationVars) => translate("en", key, vars);
const latest = { build: "b10638", file_name: "llama-b10638-bin-win-cuda-x64.zip", url: "https://example.test/llama.zip" };

function renderRow(installed: InstalledRuntime[]) {
  const row = { ...initialRows().find((item) => item.backend === "cuda")!, latest, installed };
  return render(<RuntimeBackendRow t={t} locale="en" row={row} device={null} serverRunning={false} prBusy={false} bundleBusy={false}
    cancelBusy={false} probeBusy={false} probeTarget={null} onCancelInstall={vi.fn()} onInstall={vi.fn()} onProbe={vi.fn()} onUninstall={vi.fn()} />);
}

describe("runtime version labels", () => {
  it("names the latest release with the version its installed copy recorded", () => {
    const { container } = renderRow([{ backend: "cuda", build: "b10638", dir: "runtimes/cuda-b10638", size_mb: 512, version: { semver: "0.3.0-dev", build: 10638, commit: "bf9421646" } }]);
    expect(container.querySelector(".runtime-group__latest")).toHaveTextContent("Latest 0.3.0-dev(10638)");
  });

  it("never lends another build's version to the latest release", () => {
    const { container } = renderRow([{ backend: "cuda", build: "b10600", dir: "runtimes/cuda-b10600", size_mb: 512, version: { semver: "0.2.9", build: 10600, commit: "abc" } }]);
    expect(container.querySelector(".runtime-group__latest")).toHaveTextContent("Latest ?(10638)");
    expect(screen.getByRole("button", { name: "Install ?(10638): CUDA (NVIDIA)" })).toBeInTheDocument();
  });

  it("shows the probed version as one label, not the raw banner beside it", () => {
    const capabilities: RuntimeCapabilities = {
      backend: "cuda", build: "b10638", executable: "llama-server", state: "available",
      version: "version: 0.3.0-dev (build 10638, commit bf9421646)\nbuilt with Clang 20.1.8 for x86_64",
      flags: [], devices: [], diagnostics: [],
    };
    const { container } = render(<RuntimeCapabilitiesCard t={t} capabilities={capabilities} probeBusy={false} serverRunning={false} probeTarget={null} onProbe={vi.fn()} />);
    expect(screen.getAllByText("0.3.0-dev(10638)", { exact: false }).length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("built with");
    expect(container.textContent).not.toContain("commit bf9421646");
  });
});
