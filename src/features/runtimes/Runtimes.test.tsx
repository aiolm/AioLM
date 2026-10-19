import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, act, within } from "@testing-library/react";
import { createElement } from "react";
import RuntimesPanel from "./Runtimes";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { notifySessionStatusChanged } from "../../shared/runtime/sessionUtils";
import { withSessionTransition } from "../../shared/state/sessionTransitions";
import { modelSettingsCopy } from "../model-settings/modelSettingsCopy";
import * as runtimeHelp from "../../shared/api/runtimeHelp";
import { notifyRuntimeInventoryChanged } from "../../shared/runtime/runtimeInventoryEvents";
import { effectiveSchema } from "../../testing/effectiveSchema";

vi.mock("../../shared/api/index", () => ({
  isNativeRuntimeAvailable: () => false,
  providerCatalog: vi.fn(async () => []),
  providerRuntimes: vi.fn(async () => []),
  sessionSummaryList: vi.fn(async () => []),
  normalizeSessionList: (value: unknown) => value,
  rtList: vi.fn(),
  rtLatest: vi.fn(),
  rtInstall: vi.fn(),
  rtInstallPr: vi.fn(),
  rtPrPreview: vi.fn(),
  rtExport: vi.fn(),
  rtImport: vi.fn(),
  rtCancel: vi.fn(),
  rtUninstall: vi.fn(),
  rtProbe: vi.fn(),
  deviceProfile: vi.fn(),
  onRuntimeProgress: vi.fn(),
  providerInstall: vi.fn(),
  providerPortableImport: vi.fn(),
  pickRuntimeAdapter: vi.fn(),
  runtimeAdapterRegister: vi.fn(),
  runtimeLabel: (runtime: { id: string; version?: string; accelerator: string; installation: string }) => `${runtime.version ?? runtime.id} · ${runtime.accelerator} · ${runtime.installation}`,
}));
vi.mock("../../shared/api/runtimeHelp", async origin => ({
  ...await origin<typeof import("../../shared/api/runtimeHelp")>(),
  entrypointHelpDiscover: vi.fn(), entrypointHelpCancel: vi.fn(async () => true),
  entrypointManifestPreview: vi.fn(), runtimeEntrypointRegister: vi.fn(), pickRuntimePath: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const store = {
  cfg: null,
  status: { state: "stopped" },
  loadConfig: async () => undefined,
} as unknown as AppStore;

const NVIDIA_REPORT = {
  profile: {
    schema_version: 1,
    os: "windows",
    arch: "x86_64",
    cpu: { name: "Test CPU", logical_cores: 8 },
    gpus: [{ vendor: "nvidia", name: "Test GPU", vram_mb: 8192, integrated: false }],
    detection: "test",
    fingerprint: "test-nvidia",
  },
  backends: [
    { backend: "cuda", fit: "recommended", reason: "nvidia" },
    { backend: "vulkan", fit: "compatible", reason: "vulkan" },
    { backend: "cpu", fit: "compatible", reason: "cpu" },
  ],
} satisfies api.DeviceReport;

const BUILTINS = [
  { id: "llama.cpp", engine: "llama.cpp", server: "llama-server", availability: { supported: true, detail: "" }, options: [] },
  { id: "mlx-vlm", engine: "MLX", server: "mlx_vlm.server", availability: { supported: false, detail: "Apple Silicon only" }, options: [] },
  { id: "vllm", engine: "vLLM", server: "vllm serve", availability: { supported: true, detail: "" }, options: [] },
] satisfies api.ProviderDescription[];
const LLAMA_REQUEST = { provider: "llama.cpp", revision: 1 } as const;
const HELP_OUTPUT = { text: "synthetic help", clean_text: "synthetic help", encoding: "utf-8", decoding_loss: false, truncated: false };
const HELP_REPORT: runtimeHelp.HelpReport = { identity: { fingerprint: "a".repeat(64), executable_sha256: "b".repeat(64), artifacts_sha256: {}, parser_version: 1 },
  scope: [], stdout: HELP_OUTPUT, stderr: { ...HELP_OUTPUT, text: "", clean_text: "" }, success: true, cancelled: false, timed_out: false, exit_code: 0, elapsed_ms: 1 };
const HELP_RESULT: [runtimeHelp.HelpReport, runtimeHelp.RuntimeDescriptor] = [HELP_REPORT, { engine: "custom.synthetic", runtime: "build-1", fingerprint: HELP_REPORT.identity.fingerprint, help_complete: true,
  schema: effectiveSchema(["model", "port"].map(key => ({ key, flag: `--${key}`, target: "launch" as const, group: "runtime", kind: { type: "text" as const } }))).schema, retained: [] }];
const REGISTERED: runtimeHelp.RegisteredManifest = { engine_id: "custom.synthetic", runtime_id: "build-1", display_name: "Synthetic",
  launch: { program: "/synthetic/python", args: [], env: {} }, probe: { program: "/synthetic/probe", args: [], env: {} } };

/** llama.cpp management is opened explicitly, as a model's runtime action does. */
function renderPanel(active = true) {
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(RuntimesPanel, { store, active, engineRequest: LLAMA_REQUEST }) }));
}

/** The cuda row already has the newest release build installed. */
function installedNewestCuda() {
  mocked.rtList.mockResolvedValue([{ backend: "cuda", build: "b10638", dir: "C:/runtimes/cuda-b10638", size_mb: 512 }]);
  mocked.rtLatest.mockImplementation(async (backend: string) => ({
    build: "b10638",
    file_name: `llama-b10638-bin-win-${backend}-x64.zip`,
    url: "https://example.invalid/runtime.zip",
  }));
}

/** The provenance the backend resolves for PR #27342. */
const PREVIEW = {
  pull_request: 27342,
  title: "server: add a thing",
  state: "open",
  draft: false,
  author: "contributor",
  repository: "contributor/llama.cpp",
  head_ref: "feature-branch",
  commit: "0123456789abcdef0123456789abcdef01234567",
  fork: true,
  url: "https://github.com/ggml-org/llama.cpp/pull/27342",
  archive_url: "https://codeload.github.com/contributor/llama.cpp/zip/0123456789abcdef0123456789abcdef01234567",
  updated_at: "2026-08-20T10:00:00Z",
  advisories: ["fork"],
} satisfies api.PullRequestPreview;

/**
 * ConfirmDialog always renders its markup and only calls showModal(), so
 * presence in the DOM proves nothing - the dialog's own open state does.
 */
function confirmDialogOpen() {
  return screen.getByText("Build this pull request?").closest("dialog")?.open === true;
}

/** Step one: type a PR and open the confirmation dialog. */
async function reviewPullRequest(expectedBackend = "cuda") {
  const picker = await screen.findByLabelText("Backend to build");
  await waitFor(() => expect(picker).toHaveTextContent(expectedBackend === "cpu" ? "CPU-only" : "CUDA (NVIDIA)"));
  const input = await screen.findByLabelText("PR number or URL");
  fireEvent.change(input, { target: { value: "27342" } });
  fireEvent.click(screen.getByRole("button", { name: "Review PR" }));
  await waitFor(() => expect(confirmDialogOpen()).toBe(true));
}

/** Both steps: review, then confirm, so the build actually starts. */
async function startPullRequestBuild() {
  const picker = await screen.findByLabelText("Backend to build");
  await waitFor(() => expect(picker).toHaveTextContent("CUDA (NVIDIA)"));
  await reviewPullRequest();
  fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
  await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit));
}

describe("RuntimesPanel pull-request builds", () => {
  it('reports an active runtime operation to its enclosing settings modal', async () => {
    mocked.providerCatalog.mockResolvedValue([{ id: 'vllm', engine: 'vLLM', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    let finish!: () => void;
    mocked.providerInstall.mockReturnValue(new Promise<void>(resolve => { finish = resolve; }));
    const onBusyChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={store} engineRequest={{ provider: 'vllm', revision: 1 }} onBusyChange={onBusyChange} /></I18nProvider>);
    const install = await screen.findByRole('button', { name: 'Install isolated environment' });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    fireEvent.click(install);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    await act(async () => { finish(); });
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(false));
  });
  it('locks runtime changes while a session command is pending before the native status poll catches up', async () => {
    mocked.providerCatalog.mockResolvedValue([{ id: 'vllm', engine: 'vLLM', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    const selectedStore = { ...store, cfg: { active_provider: 'vllm' } } as unknown as AppStore;
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={selectedStore} engineRequest={{ provider: 'vllm', revision: 1 }} /></I18nProvider>);
    const install = await screen.findByRole('button', { name: 'Install isolated environment' });
    expect(install).toBeEnabled();
    let release!: () => void;
    let command!: Promise<void>;
    act(() => { command = withSessionTransition(() => new Promise<void>(resolve => { release = resolve; })); });
    try {
      expect(install).toBeDisabled();
      expect(screen.getByText('Unload all model sessions before changing or transferring runtimes.')).toBeVisible();
    } finally {
      await act(async () => { release(); await command; });
    }
    await waitFor(() => expect(install).toBeEnabled());
  });

  it.each(['running', 'starting', 'stopping'])('locks Python runtime operations during the default model %s state', async state => {
    mocked.providerCatalog.mockResolvedValue([{ id: 'vllm', engine: 'vLLM', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    const selectedStore = { ...store, cfg: { active_provider: 'vllm' }, status: { state } } as unknown as AppStore;
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={selectedStore} engineRequest={{ provider: 'vllm', revision: 1 }} /></I18nProvider>);
    expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeDisabled();
    expect(screen.getByText('Unload all model sessions before changing or transferring runtimes.')).toBeVisible();
  });

  it('keeps runtime changes locked for a named session when the default model is stopped, then unlocks after it stops', async () => {
    mocked.sessionSummaryList.mockResolvedValue([{ id: 'synthetic-named-session', state: 'stopping' }]);
    mocked.providerCatalog.mockResolvedValue([{ id: 'vllm', engine: 'vLLM', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    const selectedStore = { ...store, cfg: { active_provider: 'vllm' } } as unknown as AppStore;
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={selectedStore} engineRequest={{ provider: 'vllm', revision: 1 }} /></I18nProvider>);
    const install = await screen.findByRole('button', { name: 'Install isolated environment' });
    await waitFor(() => expect(install).toBeDisabled());
    mocked.sessionSummaryList.mockResolvedValue([{ id: 'synthetic-named-session', state: 'stopped' }]);
    notifySessionStatusChanged();
    await waitFor(() => expect(install).toBeEnabled());
    expect(screen.queryByText('Unload all model sessions before changing or transferring runtimes.')).not.toBeInTheDocument();
  });

  it('follows a model editor engine request independently of the saved execution engine', async () => {
    mocked.providerCatalog.mockResolvedValue([{ id: 'vllm', engine: 'vLLM', server: 'vllm', availability: { supported: true, detail: '' }, options: [] }]);
    try {
      render(<I18nProvider initialLocale="en"><RuntimesPanel store={store} engineRequest={{ provider: 'vllm', revision: 1 }} /></I18nProvider>);
      expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeVisible();
      expect(screen.getByRole('heading', { name: 'vLLM' })).toBeVisible();
      expect(mocked.rtLatest).not.toHaveBeenCalled();
      expect(mocked.rtList).not.toHaveBeenCalled();
    } finally { mocked.providerCatalog.mockResolvedValue([]); }
  });
  it.each(['vllm', 'mlx-vlm'] as const)('keeps a saved %s engine in the neutral inventory until it is opened, without reading native releases or changing execution', async provider => {
    const updateConfig = vi.fn();
    const selectedStore = { ...store, cfg: { active_provider: provider, active_runtime: 'synthetic-runtime' }, updateConfig } as unknown as AppStore;
    mocked.providerCatalog.mockResolvedValue(BUILTINS.map(item => ({ ...item, availability: { supported: true, detail: '' } })));
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={selectedStore} /></I18nProvider>);
    const engine = provider === 'vllm' ? 'vLLM' : 'MLX';
    fireEvent.click(await screen.findByRole('button', { name: engine }));
    expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeVisible();
    expect(screen.getByRole('heading', { name: engine })).toHaveFocus();
    expect(screen.queryByText('Backend to build')).not.toBeInTheDocument();
    expect(screen.queryByText('Show all backends')).not.toBeInTheDocument();
    expect(mocked.rtLatest).not.toHaveBeenCalled();
    expect(mocked.rtList).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });
  it("probes only the build the user picks and reports the result under that build", async () => {
    // Nothing is probed on entry: the panel has no runtime of its own to
    // describe, and which build matters is the user's choice, not a setting.
    mocked.onRuntimeProgress.mockResolvedValue(() => undefined);
    mocked.deviceProfile.mockResolvedValue(NVIDIA_REPORT);
    let finish!: (value: api.RuntimeCapabilities) => void;
    mocked.rtProbe.mockImplementation(() => new Promise<api.RuntimeCapabilities>((resolve) => { finish = resolve; }));
    renderPanel();

    const advanced = (await screen.findByText("Advanced")).closest("details")!;
    fireEvent.click(advanced.querySelector("summary")!);
    expect(advanced).toHaveTextContent("Choose an installed build to probe.");
    expect(screen.queryByRole("button", { name: "Probe again" })).not.toBeInTheDocument();
    expect(mocked.rtProbe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Probe: CUDA (NVIDIA) b10638" }));
    await waitFor(() => expect(mocked.rtProbe).toHaveBeenCalledWith("cuda", "b10638"));
    await act(async () => finish({ backend: "cuda", build: "b10638", executable: "test/llama-server", state: "available", version: "test", flags: ["--ctx-size"], devices: ["CUDA1: Test GPU (8192 MiB)"], diagnostics: [], bench_available: true }));

    expect(advanced).toHaveTextContent("Showing cuda b10638.");
    // The build row remains the single entrance for checking that build again.
    expect(screen.queryByRole("button", { name: "Probe again" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Probe: CUDA (NVIDIA) b10638" }));
    await waitFor(() => expect(mocked.rtProbe).toHaveBeenCalledTimes(2));
    expect(mocked.rtProbe).toHaveBeenLastCalledWith("cuda", "b10638");
  });

  it("groups installed runtimes at row-update time after the published inventory can change", async () => {
    localStorage.setItem("aiolm.show-all-backends.v1", "1");
    const installed = [{ backend: "cuda", build: "b10638", dir: "C:/runtimes/cuda-b10638", size_mb: 512 }] satisfies api.InstalledRuntime[];
    let releaseLatest!: () => void;
    const latestReady = new Promise<void>(resolve => { releaseLatest = resolve; });
    mocked.rtList.mockResolvedValue(installed);
    mocked.rtLatest.mockImplementation(async (backend: string) => {
      await latestReady;
      return { build: "b10638", file_name: `llama-b10638-bin-win-${backend}-x64.zip`, url: "https://example.invalid/runtime.zip" };
    });

    renderPanel();
    await waitFor(() => expect(mocked.rtLatest).toHaveBeenCalledTimes(7));
    installed.push({ backend: "cpu", build: "b20638", dir: "C:/runtimes/cpu-b20638", size_mb: 256 });
    await act(async () => { releaseLatest(); await latestReady; });

    const cpuSection = (await screen.findByRole("heading", { name: "CPU-only" })).closest("section");
    expect(cpuSection).not.toBeNull();
    expect(within(cpuSection as HTMLElement).getByText("b20638")).toBeVisible();
  });

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocked.providerCatalog.mockResolvedValue(BUILTINS);
    mocked.providerRuntimes.mockResolvedValue([]);
    mocked.sessionSummaryList.mockResolvedValue([]);
    installedNewestCuda();
    mocked.deviceProfile.mockResolvedValue(NVIDIA_REPORT);
    mocked.onRuntimeProgress.mockResolvedValue(() => undefined);
    mocked.rtCancel.mockResolvedValue(undefined);
    mocked.rtExport.mockResolvedValue({
      path: "C:/exports/runtime.zip",
      backend: "cuda",
      build: "b10638",
      archive_sha256: "a".repeat(64),
      bytes: 1024,
    } satisfies api.RuntimeBundleInfo);
    mocked.rtImport.mockResolvedValue({
      build: "pr27342",
      backend: "cpu",
      dir: "C:/runtimes/pr27342-cpu",
      size_mb: 512,
    } satisfies api.InstalledRuntime);
    mocked.rtPrPreview.mockResolvedValue(PREVIEW);
    // A build that never settles keeps the panel in its busy state.
    mocked.rtInstallPr.mockImplementation(() => new Promise(() => undefined));
  });

  it("keeps one backend cancel action for a PR build when advanced settings are collapsed", async () => {
    renderPanel();
    await screen.findByRole("heading", { name: "Install a llama.cpp PR build" });
    await startPullRequestBuild();

    const advanced = screen.getByText("Advanced").closest("details")!;
    fireEvent.click(advanced.querySelector("summary")!);
    expect(advanced).toHaveAttribute("open");
    fireEvent.click(advanced.querySelector("summary")!);
    expect(advanced).not.toHaveAttribute("open");
    const cancel = await screen.findByRole("button", { name: "Cancel build" });
    expect(cancel.closest("details")).toBeNull();
    expect(screen.queryByRole("button", { name: "Cancel install" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Probe: CUDA (NVIDIA) b10638" })).toBeDisabled();
    fireEvent.click(cancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
  });

  it("replaces the refresh action with one retry after a runtime lookup failure", async () => {
    mocked.rtList.mockRejectedValueOnce(new Error("catalog unavailable"));
    renderPanel();
    const retry = await screen.findByRole("button", { name: "Retry" });
    expect(screen.getByRole("alert")).toHaveTextContent("catalog unavailable");
    expect(screen.queryByRole("button", { name: "Refresh available versions" })).not.toBeInTheDocument();
    fireEvent.click(retry);
    await waitFor(() => expect(mocked.rtList).toHaveBeenCalledTimes(2));
    expect(await screen.findByRole("button", { name: "Refresh available versions" })).toBeEnabled();
    expect(mocked.rtLatest).toHaveBeenCalledWith("cuda", true);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not fire a second cancel while the first is still in flight", async () => {
    let releaseCancel: () => void = () => undefined;
    mocked.rtCancel.mockImplementation(() => new Promise<void>((resolve) => { releaseCancel = () => resolve(); }));
    renderPanel();
    await screen.findByRole("heading", { name: "Install a llama.cpp PR build" });
    await startPullRequestBuild();

    const cancel = await screen.findByRole("button", { name: "Cancel build" });
    fireEvent.click(cancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
    const cancelling = await screen.findAllByRole("button", { name: "Cancelling" });
    expect(cancelling).toHaveLength(1);
    for (const button of cancelling) expect(button).toBeDisabled();
    fireEvent.click(cancelling[0]);
    releaseCancel();
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel build" })).toBeEnabled());
    expect(mocked.rtCancel).toHaveBeenCalledTimes(1);
  });

  it("offers PR builds for supported source backends and marks unsupported ones", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.click(picker);
    for (const backend of ["CPU-only", "Vulkan", "CUDA (NVIDIA)", "ROCm (AMD)"]) {
      expect(screen.getByRole("option", { name: backend })).toHaveAttribute("aria-disabled", "false");
    }
    for (const backend of ["SYCL", "OpenVINO"]) {
      expect(screen.getByRole("option", { name: new RegExp(backend + ".*not buildable here") })).toHaveAttribute("aria-disabled", "true");
    }
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("imports a portable runtime without invoking a local build", async () => {
    renderPanel();
    await screen.findByRole("heading", { name: "Portable runtime bundles" });
    fireEvent.click(screen.getByRole("button", { name: "Import runtime ZIP" }));
    await waitFor(() => expect(mocked.rtImport).toHaveBeenCalledTimes(1));
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("keeps bundle cancellation available outside collapsed advanced settings", async () => {
    mocked.rtImport.mockImplementation(() => new Promise(() => undefined));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Import runtime ZIP" }));
    await waitFor(() => expect(mocked.rtImport).toHaveBeenCalledTimes(1));
    const advanced = screen.getByText("Advanced").closest("details")!;
    fireEvent.click(advanced.querySelector("summary")!);
    expect(advanced).toHaveAttribute("open");
    fireEvent.click(advanced.querySelector("summary")!);
    expect(advanced).not.toHaveAttribute("open");
    const cancel = screen.getByRole("button", { name: "Cancel operation" });
    expect(cancel.closest("details")).toBeNull();
    fireEvent.click(cancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
  });

  it("keeps a filtered backend visible while its PR build can be cancelled", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.click(picker);
    fireEvent.click(screen.getByRole("option", { name: "CPU-only" }));
    await reviewPullRequest("cpu");
    expect(screen.queryByRole("heading", { name: "CPU-only" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cpu", "27342", PREVIEW.commit));
    expect(screen.getByRole("heading", { name: "CPU-only" })).toBeInTheDocument();
    const cancel = screen.getByRole("button", { name: "Cancel build" });
    expect(cancel.closest("details")).toBeNull();
    fireEvent.click(cancel);
    await waitFor(() => expect(mocked.rtCancel).toHaveBeenCalledTimes(1));
  });

  it("offers export for each installed runtime", async () => {
    renderPanel();
    const advanced = (await screen.findByText("Advanced")).closest("details")!;
    fireEvent.click(advanced.querySelector("summary")!);
    const exports = await screen.findByRole('group', { name: 'Export runtime' });
    const exportButton = within(exports).getByRole("button", { name: "Export runtime: cuda b10638" });
    expect(exportButton).toBeEnabled();
    fireEvent.click(exportButton);
    await waitFor(() => expect(mocked.rtExport).toHaveBeenCalledWith("cuda", "b10638"));
  });

  it('keeps installed runtime export controls named and disabled while a model is running', async () => {
    const runningStore = { ...store, status: { state: 'running' } } as AppStore;
    render(<I18nProvider initialLocale="en"><RuntimesPanel store={runningStore} engineRequest={LLAMA_REQUEST} /></I18nProvider>);
    const advanced = (await screen.findByText("Advanced")).closest("details")!;
    fireEvent.click(advanced.querySelector("summary")!);
    const exports = await screen.findByRole('group', { name: 'Export runtime' });
    const exportButton = within(exports).getByRole('button', { name: 'Export runtime: cuda b10638' });
    expect(exportButton).toBeDisabled();
    expect(exportButton).toHaveAttribute('title', 'Unload the model before changing runtimes.');
    fireEvent.click(exportButton);
    expect(mocked.rtExport).not.toHaveBeenCalled();
  });

  it("shows who wrote the code and where it comes from before building it", async () => {
    renderPanel();
    await reviewPullRequest();

    // The PR number the user typed says nothing about any of this, so all of
    // it has to be on screen before they can agree to compile it.
    expect(screen.getByText(PREVIEW.commit)).toBeInTheDocument();
    expect(screen.getByText("contributor")).toBeInTheDocument();
    expect(screen.getByText("contributor/llama.cpp")).toBeInTheDocument();
    expect(screen.getByText("feature-branch")).toBeInTheDocument();
    expect(screen.getByText(/not from ggml-org\/llama\.cpp/)).toBeInTheDocument();
    // Nothing is downloaded or built until the user confirms.
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("discloses when a matching prebuilt PR artifact removes the toolchain requirement", async () => {
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      artifact: {
        name: "aiolm-pr27342-cuda-win-x64.zip",
        sha256: "b".repeat(64),
        bytes: 128 * 1024 * 1024,
      },
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/matching prebuilt artifact is available/)).toBeInTheDocument();
    expect(screen.getByText(/does not need CMake/)).toBeInTheDocument();
  });

  it("builds nothing when the confirmation is dismissed", async () => {
    renderPanel();
    await reviewPullRequest();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(confirmDialogOpen()).toBe(false));
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("sends the confirmed head commit, not just the PR number", async () => {
    renderPanel();
    await startPullRequestBuild();
    // The backend re-resolves the PR and refuses anything but this commit, so
    // a force-push between the dialog and the build cannot ride in on it.
    expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit);
  });

  it("reports a pull request that cannot be resolved without starting a build", async () => {
    mocked.rtPrPreview.mockRejectedValue(new Error("GitHub API 404"));
    renderPanel();
    const input = await screen.findByLabelText("PR number or URL");
    fireEvent.change(input, { target: { value: "27342" } });
    fireEvent.click(screen.getByRole("button", { name: "Review PR" }));
    await screen.findByText(/Could not resolve that pull request/);
    expect(confirmDialogOpen()).toBe(false);
    expect(mocked.rtInstallPr).not.toHaveBeenCalled();
  });

  it("names every pull request state that changes what the code is", async () => {
    // The backend decides which advisories apply; the dialog must render each
    // of them rather than silently dropping one it has no branch for.
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      state: "closed",
      draft: true,
      advisories: ["draft", "closed", "fork", "no-head-ref"],
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();

    expect(screen.getByText(/still a draft/)).toBeInTheDocument();
    expect(screen.getByText(/closed without being merged/)).toBeInTheDocument();
    expect(screen.getByText(/not from ggml-org\/llama\.cpp/)).toBeInTheDocument();
    expect(screen.getByText(/no longer has a head branch/)).toBeInTheDocument();
  });

  it("says a merged pull request is already upstream instead of calling it closed", async () => {
    mocked.rtPrPreview.mockResolvedValue({ ...PREVIEW, state: "merged", advisories: ["merged"] } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/already been merged upstream/)).toBeInTheDocument();
    expect(screen.queryByText(/closed without being merged/)).not.toBeInTheDocument();
  });

  it("warns about nothing when an ordinary open upstream PR is reviewed", async () => {
    mocked.rtPrPreview.mockResolvedValue({
      ...PREVIEW,
      repository: "ggml-org/llama.cpp",
      fork: false,
      advisories: [],
    } satisfies api.PullRequestPreview);
    renderPanel();
    await reviewPullRequest();
    expect(screen.queryByText(/still a draft/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not from ggml-org\/llama\.cpp/)).not.toBeInTheDocument();
    // The build plan is not a warning and is always shown.
    expect(screen.getByText("What gets built")).toBeInTheDocument();
  });

  it("states what the build produces before the user agrees to it", async () => {
    renderPanel();
    await reviewPullRequest();
    expect(screen.getByText(/llama-server, llama-bench and llama-perplexity targets only/)).toBeInTheDocument();
    expect(screen.getByText(/embedded web UI is disabled/)).toBeInTheDocument();
    expect(screen.getByText(/BoringSSL, libcurl and OpenSSL support are off/)).toBeInTheDocument();
    // The backend is cuda here, so the architecture policy is disclosed too.
    expect(screen.getByText(/AIOLM_CUDA_ARCHITECTURES/)).toBeInTheDocument();
    // And so is the fact that one PR keeps one directory.
    expect(screen.getByText(/Installs as pr27342-cuda/)).toBeInTheDocument();
  });

  it("hides the CUDA architecture note for a backend that has no CUDA kernels", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.click(picker); fireEvent.click(screen.getByRole("option", { name: "CPU-only" }));
    const input = await screen.findByLabelText("PR number or URL");
    fireEvent.change(input, { target: { value: "27342" } });
    fireEvent.click(screen.getByRole("button", { name: "Review PR" }));
    await waitFor(() => expect(confirmDialogOpen()).toBe(true));
    expect(screen.queryByText(/AIOLM_CUDA_ARCHITECTURES/)).not.toBeInTheDocument();
    expect(screen.getByText(/Installs as pr27342-cpu/)).toBeInTheDocument();
  });

  it("binds progress to the confirmed backend when the picker changes", async () => {
    let emitProgress: ((progress: api.DownloadProgress) => void) | undefined;
    mocked.onRuntimeProgress.mockImplementation(async (callback: (progress: api.DownloadProgress) => void) => {
      emitProgress = callback;
      return () => undefined;
    });
    const view = renderPanel();
    await startPullRequestBuild();
    await waitFor(() => expect(emitProgress).toBeTypeOf("function"));

    await act(async () => {
      emitProgress?.({ backend: "cuda", build: "pr27342", phase: "building", received: 50, total: 100 });
    });
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // A build locks the picker; progress stays bound to its confirmed backend.
    const lockedPicker = await screen.findByLabelText("Backend to build");
    expect(lockedPicker).toBeDisabled();
    fireEvent.keyDown(lockedPicker, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // App models tab navigation by keeping the panel mounted and toggling its
    // active/hidden state. The native listener and build state must survive
    // that transition.
    view.rerender(createElement(I18nProvider, { initialLocale: "en", children: createElement(RuntimesPanel, { store, active: false, engineRequest: LLAMA_REQUEST }) }));
    expect(screen.getAllByText("Building")).toHaveLength(2);

    // A progress event for another backend must not replace the pinned
    // section progress either.
    await act(async () => {
      emitProgress?.({ backend: "cpu", build: "pr27342", phase: "configuring", received: 20, total: 100 });
    });
    expect(screen.getAllByText("Building")).toHaveLength(2);
    expect(screen.queryByText("Configuring")).not.toBeInTheDocument();
  });

  it("uses the picker value that was selected before confirmation", async () => {
    renderPanel();
    const picker = await screen.findByLabelText("Backend to build");
    fireEvent.click(picker); fireEvent.click(screen.getByRole("option", { name: "CPU-only" }));
    await reviewPullRequest("cpu");
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cpu", "27342", PREVIEW.commit));
  });

  it("keeps the reviewed backend when the picker changes before confirmation", async () => {
    renderPanel();
    await reviewPullRequest();
    fireEvent.click(await screen.findByLabelText("Backend to build")); fireEvent.click(screen.getByRole("option", { name: "CPU-only" }));
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await waitFor(() => expect(mocked.rtInstallPr).toHaveBeenCalledWith("cuda", "27342", PREVIEW.commit));
  });

  it("reports which commit a rebuild displaced", async () => {
    mocked.rtInstallPr.mockResolvedValue({
      build: "pr27342",
      backend: "cuda",
      dir: "C:/runtimes/pr27342-cuda",
      size_mb: 512,
      source: { pull_request: 27342, repository: "contributor/llama.cpp", commit: PREVIEW.commit, archive_sha256: "", url: PREVIEW.url },
      replaced: { previous_commit: "fedcba9876543210fedcba9876543210fedcba98", previous_pull_request: 27342 },
    } satisfies api.InstalledRuntime);
    renderPanel();
    await startPullRequestBuild();
    // One directory per PR means the bytes behind an unchanged row name have
    // changed; the short commit that went away has to be named.
    await screen.findByText(/replacing the earlier build of commit fedcba9/);
  });

  it("reports a plain install when nothing was displaced", async () => {
    mocked.rtInstallPr.mockResolvedValue({
      build: "pr27342",
      backend: "cuda",
      dir: "C:/runtimes/pr27342-cuda",
      size_mb: 512,
      source: { pull_request: 27342, repository: "contributor/llama.cpp", commit: PREVIEW.commit, archive_sha256: "", url: PREVIEW.url },
    } satisfies api.InstalledRuntime);
    renderPanel();
    await startPullRequestBuild();
    await screen.findByText(/Installed cuda from llama\.cpp PR #27342\./);
    expect(screen.queryByText(/replacing the earlier build/)).not.toBeInTheDocument();
  });

  it("keeps the confirmation closed and the panel idle after a cancelled build", async () => {
    mocked.rtInstallPr.mockRejectedValue(new Error("runtime install cancelled"));
    renderPanel();
    await reviewPullRequest();
    fireEvent.click(screen.getByRole("button", { name: "Build this commit" }));
    await screen.findByText(/cancelled/i);
    // A cancelled build is not a failure banner, and it must leave the panel
    // ready for another attempt rather than stuck busy.
    await waitFor(() => expect(confirmDialogOpen()).toBe(false));
    expect(await screen.findByRole("button", { name: "Review PR" })).toBeEnabled();
  });

  it("removes the build the default execution uses after naming what loses its runtime", async () => {
    // The runtime a model launches with lives in its profile, so a build is no
    // longer withheld for being the one in use. Removing it clears it from
    // everything that named it, which the confirmation states before it runs.
    mocked.rtUninstall.mockResolvedValue(undefined);
    const loadConfig = vi.fn(async () => undefined);
    const configured = { ...store, loadConfig, cfg: {
      active_backend: "cuda", active_build: "b10638",
      settings_profiles: { version: 1, revision: 1, legacy_imported: true, default_profile_id: "profile-default",
        entries: [{ id: "profile-default", name: "Default", scope: "global", revision: 1,
          settings: { active_backend: "cuda", active_build: "b10638" } }],
        applied: {} },
    } } as unknown as AppStore;
    render(createElement(I18nProvider, { initialLocale: "en", children: createElement(RuntimesPanel, { store: configured, active: true, engineRequest: LLAMA_REQUEST }) }));

    fireEvent.click(await screen.findByRole("button", { name: "Remove: CUDA (NVIDIA) b10638" }));

    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("These use this runtime and will be left without one:");
    expect(dialog).toHaveTextContent("Default execution");
    expect(dialog).toHaveTextContent("Profile “Default”");
    fireEvent.click(screen.getByRole("button", { name: "Remove runtime" }));

    await waitFor(() => expect(mocked.rtUninstall).toHaveBeenCalledWith("cuda", "b10638"));
    // The backend cleared the runtime from the saved profiles, so the panel
    // reloads rather than keeping a selection that no longer exists.
    await waitFor(() => expect(loadConfig).toHaveBeenCalled());
  });
  it("surfaces a build failure without clearing the typed pull request", async () => {
    mocked.rtInstallPr.mockRejectedValue(new Error("CMake configuring failed with exit code: 1"));
    renderPanel();
    await startPullRequestBuild();
    await screen.findByText(/CMake configuring failed/);
    // The source stays so the user can fix the toolchain and retry.
    expect(await screen.findByLabelText("PR number or URL")).toHaveValue("27342");
  });
});

describe('saved profile location hint (U3)', () => {
  it.each(['en', 'ko', 'ja', 'zh'] as const)('names the Model settings profiles section it opens, not a Tuning page, in %s', async (locale) => {
    const onOpenProfiles = vi.fn();
    render(createElement(I18nProvider, { initialLocale: locale, children: createElement(RuntimesPanel, { store, onOpenProfiles }) }));
    const hint = document.querySelector('.runtime-profiles-link')!;
    expect(hint).not.toBeNull();
    const copy = modelSettingsCopy[locale];
    expect(hint).toHaveTextContent(copy.title);
    expect(hint).toHaveTextContent(copy.profiles);
    expect(hint.textContent).not.toMatch(/Tuning|튜닝|チューニング|调优/);
    fireEvent.click(within(hint as HTMLElement).getByRole('button'));
    expect(onOpenProfiles).toHaveBeenCalledOnce();
  });
});

describe('neutral inference engine inventory', () => {
  const SYNTHETIC = { id: 'custom.synthetic', engine: 'Synthetic', server: 'openai-v1', kind: 'external-process', availability: { supported: true, detail: '' }, options: [] } satisfies api.ProviderDescription;
  const SYNTHETIC_RUNTIME = { provider: 'custom.synthetic', id: 'build-1', engine: 'Synthetic', server: 'openai-v1', accelerator: 'external', installation: 'registered', location: '/synthetic/engine', available: true, problems: [] } satisfies api.RuntimeInstance;
  const panel = (props: Partial<Parameters<typeof RuntimesPanel>[0]> = {}) =>
    <I18nProvider initialLocale="en"><RuntimesPanel store={store} {...props} /></I18nProvider>;

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocked.providerCatalog.mockResolvedValue(BUILTINS);
    mocked.providerRuntimes.mockResolvedValue([]);
    mocked.sessionSummaryList.mockResolvedValue([]);
    installedNewestCuda();
    mocked.deviceProfile.mockResolvedValue(NVIDIA_REPORT);
    mocked.onRuntimeProgress.mockResolvedValue(() => undefined);
  });

  it('opens on the neutral inventory for a saved llama.cpp execution engine without reading llama releases or changing settings', async () => {
    const updateConfig = vi.fn();
    const saved = { ...store, cfg: { active_provider: 'llama.cpp', active_backend: 'cuda', active_build: 'b10638' }, updateConfig } as unknown as AppStore;
    render(panel({ store: saved }));
    expect(await screen.findByRole('button', { name: 'llama.cpp' })).toBeVisible();
    for (const name of ['MLX', 'vLLM']) expect(screen.getByRole('button', { name })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Add an inference engine' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add inference engine' })).toBeVisible();
    expect(screen.getByText(/No engine is installed or registered yet/)).toBeVisible();
    expect(screen.queryByRole('combobox', { name: 'Inference engine' })).not.toBeInTheDocument();
    expect(screen.queryByText('Backend to build')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Deep verification' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Register an executable or entry point' })).not.toBeInTheDocument();
    expect(mocked.rtList).not.toHaveBeenCalled();
    expect(mocked.rtLatest).not.toHaveBeenCalled();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  it('filters to a registered fourth engine, opens its own runtimes and returns focus to it in the kept search', async () => {
    mocked.providerCatalog.mockResolvedValue([...BUILTINS, SYNTHETIC]);
    mocked.providerRuntimes.mockResolvedValue([SYNTHETIC_RUNTIME]);
    render(panel());
    fireEvent.change(await screen.findByRole('searchbox', { name: "Search engines" }), { target: { value: 'synth' } });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'llama.cpp' })).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic' }));
    expect(screen.getByRole('heading', { name: 'Synthetic' })).toHaveFocus();
    expect(screen.getByText(/Registered engine · openai-v1/)).toBeVisible();
    const runtimes = await screen.findByRole('group', { name: 'custom.synthetic · Runtime' });
    expect(within(runtimes).getByText('Runtime found')).toBeVisible();
    expect(within(runtimes).queryByText('Ready')).not.toBeInTheDocument();
    expect(within(runtimes).getByRole('button', { name: 'Remove' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Install isolated environment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Import Python runtime bundle' })).not.toBeInTheDocument();
    expect(mocked.rtList).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'All inference engines' }));
    expect(screen.getByRole('button', { name: 'Synthetic' })).toHaveFocus();
    expect(screen.getByRole('searchbox', { name: "Search engines" })).toHaveValue('synth');
    fireEvent.click(screen.getByRole('button', { name: 'Synthetic' }));
    mocked.providerCatalog.mockResolvedValue(BUILTINS);
    mocked.providerRuntimes.mockResolvedValue([]);
    act(() => notifyRuntimeInventoryChanged());
    expect(await screen.findByText(/This engine is no longer listed/)).toBeVisible();
    expect(screen.queryByText(/^(?:Built-in adapter|Registered engine · openai-v1)$/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'All inference engines' }));
    expect(screen.getByRole('searchbox', { name: "Search engines" })).toHaveValue('synth');
  });

  it('keeps llama.cpp installs, PR builds, portable bundles, hardware and deep verification inside its adapter, and Python adapters inside theirs', async () => {
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: 'llama.cpp' }));
    expect(await screen.findByRole('button', { name: 'Remove: CUDA (NVIDIA) b10638' })).toBeVisible();
    expect(mocked.rtList).toHaveBeenCalled();
    expect(screen.getByLabelText('Backend to build')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import runtime ZIP' })).toBeInTheDocument();
    expect(screen.getAllByText(/Test GPU/).length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Deep verification' })).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'All inference engines' }));
    fireEvent.click(screen.getByRole('button', { name: 'vLLM' }));
    expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Import Python runtime bundle' })).toBeVisible();
    expect(screen.queryByLabelText('Backend to build')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Deep verification' })).not.toBeInTheDocument();
  });

  it('opens the entrypoint wizard from Add and keeps typed values across back, inventory updates and busy help discovery', async () => {
    let finishHelp!: (value: [runtimeHelp.HelpReport, runtimeHelp.RuntimeDescriptor]) => void;
    vi.mocked(runtimeHelp.entrypointHelpDiscover).mockImplementation(() => new Promise(resolve => { finishHelp = resolve; }));
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: 'Add inference engine' }));
    expect(screen.getByRole('heading', { name: 'Register an executable or entry point' })).toHaveFocus();
    expect(screen.getByText("Advanced: import registration file (manifest)").closest('details')).not.toHaveAttribute('open');
    fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.synthetic' } });
    fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'build-1' } });
    fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/python' } });
    const reads = mocked.providerCatalog.mock.calls.length;
    act(() => notifyRuntimeInventoryChanged());
    await waitFor(() => expect(mocked.providerCatalog.mock.calls.length).toBeGreaterThan(reads));
    expect(screen.getByLabelText('Engine ID (custom.*)')).toHaveValue('custom.synthetic');

    fireEvent.click(screen.getByRole('button', { name: 'All inference engines' }));
    expect(screen.getByRole('button', { name: 'Add inference engine' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Add inference engine' }));
    expect(screen.getByLabelText('Executable or interpreter')).toHaveValue('/synthetic/python');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All inference engines' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeVisible();
    await act(async () => finishHelp(HELP_RESULT));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All inference engines' })).toBeEnabled());
    expect(screen.getByText(/Discovered: 2 options/)).toBeVisible();
  });

  it('registers through the wizard, refreshes the inventory and offers explicit next actions without changing execution', async () => {
    const updateConfig = vi.fn();
    const onOpenProfiles = vi.fn();
    vi.mocked(runtimeHelp.entrypointManifestPreview).mockResolvedValue(REGISTERED);
    vi.mocked(runtimeHelp.runtimeEntrypointRegister).mockImplementation(async () => {
      mocked.providerCatalog.mockResolvedValue([...BUILTINS, SYNTHETIC]);
      mocked.providerRuntimes.mockResolvedValue([SYNTHETIC_RUNTIME]);
      return REGISTERED;
    });
    render(panel({ store: { ...store, updateConfig } as unknown as AppStore, onOpenProfiles }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add inference engine' }));
    fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.synthetic' } });
    fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'build-1' } });
    fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/python' } });
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue without help' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    const [modelFlag, portFlag] = screen.getAllByLabelText('Option name');
    fireEvent.change(modelFlag, { target: { value: '--model' } });
    fireEvent.change(portFlag, { target: { value: '--port' } });
    fireEvent.change(screen.getByLabelText("Compatibility check program"), { target: { value: '/synthetic/probe' } });
    fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
    fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
    fireEvent.click(await screen.findByRole('button', { name: 'Register' }));

    expect(await screen.findByText('Synthetic · build-1 is registered')).toBeVisible();
    expect(screen.getByText(/Select this engine and a model in an execution profile/)).toBeVisible();
    expect(mocked.providerCatalog).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByRole('button', { name: 'Set up an execution profile' }));
    expect(onOpenProfiles).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Open Synthetic' }));
    expect(screen.getByRole('heading', { name: 'Synthetic' })).toHaveFocus();
    expect(await screen.findByRole('group', { name: 'custom.synthetic · Runtime' })).toBeVisible();
    expect(updateConfig).not.toHaveBeenCalled();
  });

  describe('a new build of an already registered engine', () => {
    // The catalog keeps naming the engine after its first registered build.
    const OLD_BUILD = { ...SYNTHETIC, engine: 'Synthetic G11' } satisfies api.ProviderDescription;
    const NEW_BUILD = { engine_id: 'custom.synthetic', runtime_id: 'build-2', display_name: 'Synthetic G12 1000 options' };
    const refreshes = { refreshed: () => mocked.providerCatalog.mockResolvedValue([...BUILTINS, OLD_BUILD]), 'refresh fails': () => mocked.providerCatalog.mockRejectedValue(new Error('Synthetic inventory failure')) };
    beforeEach(() => {
      mocked.providerCatalog.mockResolvedValue([...BUILTINS, OLD_BUILD]);
      mocked.providerRuntimes.mockResolvedValue([SYNTHETIC_RUNTIME]);
    });
    const expectNewBuildAnnounced = async (updateConfig: ReturnType<typeof vi.fn>) => {
      expect(await screen.findByText('Synthetic G12 1000 options · build-2 is registered')).toBeVisible();
      expect(screen.queryByText('Synthetic G11 is registered')).not.toBeInTheDocument();
      expect(screen.getByText(/Select this engine and a model in an execution profile/)).toBeVisible();
      fireEvent.click(screen.getByRole('button', { name: 'Open Synthetic G12 1000 options' }));
      expect(screen.getByRole('heading', { name: 'Synthetic G11' })).toHaveFocus();
      expect(updateConfig).not.toHaveBeenCalled();
    };

    it.each(Object.keys(refreshes) as (keyof typeof refreshes)[])('announces the build the wizard registered when the inventory is %s', async refresh => {
      const updateConfig = vi.fn();
      vi.mocked(runtimeHelp.entrypointManifestPreview).mockResolvedValue({ ...REGISTERED, ...NEW_BUILD });
      vi.mocked(runtimeHelp.runtimeEntrypointRegister).mockImplementation(async () => { refreshes[refresh](); return { ...REGISTERED, ...NEW_BUILD }; });
      render(panel({ store: { ...store, updateConfig } as unknown as AppStore }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add inference engine' }));
      fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.synthetic' } });
      fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'build-2' } });
      fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/python' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue without help' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      const [modelFlag, portFlag] = screen.getAllByLabelText('Option name');
      fireEvent.change(modelFlag, { target: { value: '--model' } });
      fireEvent.change(portFlag, { target: { value: '--port' } });
      fireEvent.change(screen.getByLabelText("Compatibility check program"), { target: { value: '/synthetic/probe' } });
      fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
      fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
      fireEvent.click(await screen.findByRole('button', { name: 'Register' }));
      await expectNewBuildAnnounced(updateConfig);
    });

    it.each(Object.keys(refreshes) as (keyof typeof refreshes)[])('announces the build an advanced manifest registered when the inventory is %s', async refresh => {
      const updateConfig = vi.fn();
      mocked.runtimeAdapterRegister.mockImplementation(async () => { refreshes[refresh](); return NEW_BUILD; });
      render(panel({ store: { ...store, updateConfig } as unknown as AppStore }));
      fireEvent.click(await screen.findByRole('button', { name: 'Add inference engine' }));
      fireEvent.click(screen.getByText("Advanced: import registration file (manifest)"));
      fireEvent.change(screen.getByRole('textbox', { name: "Registration file path (manifest)" }), { target: { value: '/synthetic/runtime.json' } });
      fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
      await expectNewBuildAnnounced(updateConfig);
      expect(mocked.runtimeAdapterRegister).toHaveBeenCalledWith('/synthetic/runtime.json');
    });
  });

  describe('a completed registration below a long reviewed manifest', () => {
    // The announcement is inserted above the wizard while Register sits at the
    // end of the reviewed manifest, and Register itself is replaced on success.
    const reviewAndRegister = async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Add inference engine' }));
      fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.synthetic' } });
      fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'build-1' } });
      fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/python' } });
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      fireEvent.click(screen.getByRole('button', { name: 'Continue without help' }));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      const [modelFlag, portFlag] = screen.getAllByLabelText('Option name');
      fireEvent.change(modelFlag, { target: { value: '--model' } });
      fireEvent.change(portFlag, { target: { value: '--port' } });
      fireEvent.change(screen.getByLabelText("Compatibility check program"), { target: { value: '/synthetic/probe' } });
      fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
      fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
      fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
      const register = await screen.findByRole('button', { name: 'Register' });
      register.focus();
      fireEvent.click(register);
      return register;
    };
    beforeEach(() => vi.mocked(runtimeHelp.entrypointManifestPreview).mockResolvedValue(REGISTERED));

    it('moves focus to the returned engine and its next actions, keeping the review and later refreshes alone', async () => {
      vi.mocked(runtimeHelp.runtimeEntrypointRegister).mockResolvedValue(REGISTERED);
      render(panel({ onOpenProfiles: vi.fn() }));
      await reviewAndRegister();
      const result = await screen.findByRole('group', { name: 'Synthetic · build-1 is registered' });
      await waitFor(() => expect(result).toHaveFocus());
      expect(within(result).getByRole('button', { name: 'Open Synthetic' })).toBeVisible();
      expect(within(result).getByRole('button', { name: 'Set up an execution profile' })).toBeVisible();
      expect(screen.getByText(/"runtime_id": "build-1"/)).toBeInTheDocument();
      const refresh = screen.getByRole('button', { name: 'Refresh list' });
      const reads = mocked.providerCatalog.mock.calls.length;
      refresh.focus();
      fireEvent.click(refresh);
      await waitFor(() => expect(mocked.providerCatalog.mock.calls.length).toBeGreaterThan(reads));
      expect(refresh).toHaveFocus();
    });

    it('leaves focus on Register when the registration fails', async () => {
      vi.mocked(runtimeHelp.runtimeEntrypointRegister).mockRejectedValue(new Error('Synthetic probe refused'));
      render(panel());
      const register = await reviewAndRegister();
      expect(await screen.findByText('Synthetic probe refused')).toBeVisible();
      expect(register).toHaveFocus();
      expect(screen.queryByRole('group', { name: /is registered/ })).not.toBeInTheDocument();
    });

    it('does not take focus for a registration that finished while the page was hidden', async () => {
      let finish!: (value: runtimeHelp.RegisteredManifest) => void;
      vi.mocked(runtimeHelp.runtimeEntrypointRegister).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
      const view = render(panel());
      const register = await reviewAndRegister();
      view.rerender(panel({ active: false }));
      register.blur();
      await act(async () => finish(REGISTERED));
      view.rerender(panel({ active: true }));
      const result = await screen.findByRole('group', { name: 'Synthetic · build-1 is registered' });
      expect(result).not.toHaveFocus();
      expect(document.body).toHaveFocus();
    });
  });

  it('opens an explicitly requested adapter and returns to the inventory after ordinary navigation', async () => {
    const view = render(panel({ active: false }));
    view.rerender(panel({ active: true, engineRequest: { provider: 'vllm', revision: 1 } }));
    expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'vLLM' })).toBeVisible();
    view.rerender(panel({ active: false, engineRequest: { provider: 'vllm', revision: 1 } }));
    view.rerender(panel({ active: true, engineRequest: { provider: 'vllm', revision: 1 } }));
    expect(screen.getByRole('button', { name: 'Add inference engine' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install isolated environment' })).not.toBeInTheDocument();
    view.rerender(panel({ active: true, engineRequest: { provider: 'vllm', revision: 2 } }));
    expect(await screen.findByRole('button', { name: 'Install isolated environment' })).toBeVisible();
    expect(mocked.rtList).not.toHaveBeenCalled();
  });

  it('remembers ordinary navigation back while an adapter operation is finishing', async () => {
    let finish!: () => void;
    mocked.providerInstall.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    const request = { provider: 'vllm', revision: 1 } as const;
    const view = render(panel({ engineRequest: request }));
    fireEvent.click(await screen.findByRole('button', { name: 'Install isolated environment' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'All inference engines' })).toBeDisabled());
    view.rerender(panel({ active: false, engineRequest: request }));
    view.rerender(panel({ active: true, engineRequest: request }));
    expect(screen.getByRole('heading', { name: 'vLLM' })).toBeVisible();
    await act(async () => finish());
    expect(await screen.findByRole('button', { name: 'Add inference engine' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Install isolated environment' })).not.toBeInTheDocument();
    expect(mocked.providerInstall).toHaveBeenCalledOnce();
  });
});
