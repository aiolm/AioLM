import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import { SESSION_STATUS_CHANGED_EVENT } from "../../shared/runtime/sessionUtils";
import SessionsPanel from "./Sessions";

vi.mock("../../shared/api/index", () => ({
  sessionList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  deviceProfile: vi.fn(),
  rtProbe: vi.fn(),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(),
  sessionUnload: vi.fn(),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const definition: api.SessionDefinition = {
  id: "work",
  name: "Work session",
  models: { primary_model: "C:/models/work.gguf", mmproj: "", draft_model: "" },
  gpu: { gpu_ids: ["gpu-a", "gpu-b"], main_gpu: "gpu-a", split_mode: "layer", tensor_split: [1, 1], draft_gpu_id: null },
  enabled: true,
};
const cfg = {
  active_model: "C:/models/default.gguf",
  mmproj: "",
  spec_draft_model: "",
  port: 8080,
  gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null },
  sessions: [definition],
  stop_existing_sessions_on_load: false,
} as unknown as api.AppConfig;

function renderPanel(config = cfg) {
  const store = {
    cfg: config,
    status: { state: "stopped" },
    busy: false,
    updateConfig: vi.fn(async () => cfg),
    start: vi.fn(),
    stop: vi.fn(),
    refreshStatus: vi.fn(),
  } as unknown as AppStore;
  render(<I18nProvider initialLocale="en"><SessionsPanel store={store} /></I18nProvider>);
  return store;
}

describe("SessionsPanel editing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.sessionUnload.mockResolvedValue(undefined);
    mocked.sessionList.mockResolvedValue([]);
    mocked.normalizeSessionList.mockImplementation((value: unknown) => Array.isArray(value) ? value : []);
    mocked.deviceProfile.mockResolvedValue({ profile: { gpus: [
      { stable_id: "gpu-a", name: "Radeon", vendor: "amd", vram_mb: 8192, integrated: false },
      { stable_id: "gpu-b", name: "Radeon", vendor: "amd", vram_mb: 8192, integrated: false },
    ] } });
    mocked.sessionStart.mockResolvedValue({ id: "work", name: "Work session", state: "running" });
  });

  it("hides Windows extended path prefixes in runtime probe errors", async () => {
    mocked.rtProbe.mockRejectedValueOnce(new Error(String.raw`Runtime not found: \\?\C:\runtime\llama-server.exe`));
    renderPanel({ ...cfg, active_backend: "rocm", active_build: "b10840" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(String.raw`Runtime not found: C:\runtime\llama-server.exe`);
    expect(alert.textContent).not.toContain("\\\\?\\");
  });

  it("never substitutes OS GPU numbers when a managed runtime probe fails and can retry", async () => {
    mocked.rtProbe.mockRejectedValueOnce(new Error("Runtime probe timed out"));
    renderPanel({ ...cfg, active_backend: "rocm", active_build: "b10840" });
    expect(await screen.findByRole("alert")).toHaveTextContent("Runtime probe timed out");
    expect(mocked.deviceProfile).not.toHaveBeenCalled();
    expect(screen.queryByRole("checkbox", { name: /Radeon/ })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Main GPU")).toBeDisabled();
    mocked.rtProbe.mockResolvedValueOnce({ backend: "rocm", devices: ["ROCm1: AMD Radeon (32624 MiB)"] });
    fireEvent.click(screen.getByRole("button", { name: "Probe selected runtime" }));
    expect(await screen.findByRole("checkbox", { name: /ROCm1/ })).toBeEnabled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("uses the visible per-GPU ratio drafts when loading", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText(/gpu-a$/), { target: { value: "0.25" } });
    fireEvent.change(screen.getByLabelText(/gpu-b$/), { target: { value: "0.75" } });
    fireEvent.click(screen.getByRole("button", { name: "Load session" }));

    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalled());
    expect(mocked.sessionStart.mock.calls[0][1].gpu.tensor_split).toEqual([0.25, 0.75]);
  });
  it('keeps GPU controls mounted during a refresh but drops devices from a different runtime', async () => {
    const store = { cfg, status: { state: 'stopped' }, busy: false } as AppStore;
    const view = (active: boolean) => <I18nProvider initialLocale="en"><SessionsPanel store={store} active={active} /></I18nProvider>;
    const { rerender } = render(view(true));
    const gpu = (await screen.findAllByRole('checkbox', { name: /Radeon/ }))[0];
    rerender(view(false));
    let complete!: (value: unknown) => void;
    mocked.deviceProfile.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    rerender(view(true));
    expect(gpu.isConnected).toBe(true);
    expect(gpu).toBeDisabled();
    await act(async () => { complete({ profile: { gpus: [{ stable_id: 'gpu-a', name: 'Radeon', vendor: 'amd' }] } }); });
    expect(gpu.isConnected).toBe(true);
    expect(gpu).toBeEnabled();
    mocked.rtProbe.mockImplementationOnce(() => new Promise(() => undefined));
    store.cfg = { ...cfg, active_backend: 'vulkan', active_build: 'b234' };
    rerender(view(true));
    expect(screen.queryByRole('checkbox', { name: /Radeon/ })).not.toBeInTheDocument();
  });

  it("asks before discarding edits when switching sessions", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: /Default server/ }));

    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toHaveAccessibleDescription(/discard them/i);
  });

  it("does not discard edits when the selected session is clicked again", async () => {
    renderPanel();
    const row = await screen.findByRole("button", { name: /Work session/ });
    fireEvent.click(row);
    const name = screen.getByLabelText("Session name");
    fireEvent.change(name, { target: { value: "Changed" } });
    fireEvent.click(row);
    expect(name).toHaveValue("Changed");
  });

  it("asks before replacing an edited session with a new one", async () => {
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  });

  it("allows ratio-only edits on the default server to be saved", async () => {
    const config = { ...cfg, gpu: definition.gpu } as api.AppConfig;
    const store = renderPanel(config);
    fireEvent.change(await screen.findByLabelText(/gpu-a$/), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ gpu: expect.objectContaining({ tensor_split: [0.4, 1] }) })));
  });

  it("keeps an unpersisted running session visible and manageable", async () => {
    renderPanel();
    await waitFor(() => expect(mocked.sessionList).toHaveBeenCalled());
    mocked.sessionList.mockResolvedValue([{ id: "transient", name: "Transient", state: "running", model: "C:/models/temp.gguf", port: 8094 }]);
    window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
    expect(await screen.findByRole("button", { name: /Transient/ })).toBeInTheDocument();
  });

  it("keeps session status when GPU detection fails", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "remote", name: "Remote", state: "running", model: "remote.gguf", port: 8095 }]);
    mocked.deviceProfile.mockRejectedValue(new Error("GPU probe failed"));
    renderPanel();
    expect(await screen.findByRole("button", { name: /Remote/ })).toBeInTheDocument();
  });

  it("unloads even a stopped session before deleting its definition", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work session", state: "stopped" }]);
    const store = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    mocked.sessionList.mockResolvedValue([]);
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] })));
    expect(mocked.sessionUnload).toHaveBeenCalledWith("work");
    expect(screen.queryByRole("button", { name: /Work session/ })).not.toBeInTheDocument();
  });

  it("preserves the definition and reports failure when unloading fails", async () => {
    mocked.sessionUnload.mockRejectedValue(new Error("Unload failed"));
    const store = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unload failed");
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Work session/ })).toBeInTheDocument();
  });

  it("does not overwrite a new selection when an earlier save finishes", async () => {
    const store = renderPanel();
    let finish!: (value: api.AppConfig) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    fireEvent.click(screen.getByRole("button", { name: /Default server/ }));
    await act(async () => { finish(cfg); });
    expect(screen.getByLabelText("Primary model")).toHaveValue(cfg.active_model);
    expect(screen.getByLabelText("Primary model")).toBeDisabled();
  });

  it("preserves edits made while saving", async () => {
    const store = renderPanel();
    let finish!: (value: api.AppConfig) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Newer edit" } });
    await act(async () => { finish(cfg); });
    expect(screen.getByLabelText("Session name")).toHaveValue("Newer edit");
  });

  it("prevents loading a disabled definition", async () => {
    renderPanel({ ...cfg, sessions: [{ ...definition, enabled: false }] });
    fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
    const load = screen.getByRole("button", { name: "Load session" });
    expect(load).toBeDisabled();
    fireEvent.click(load);
    expect(mocked.sessionStart).not.toHaveBeenCalled();
  });

  it("shows session status without waiting for a pending GPU probe", async () => {
    mocked.deviceProfile.mockImplementationOnce(() => new Promise(() => {}));
    mocked.sessionList.mockResolvedValue([{ id: "remote", name: "Remote", state: "running", model: "remote.gguf" }]);
    renderPanel();
    expect(await screen.findByRole("button", { name: /Remote/ })).toBeInTheDocument();
  });
});
