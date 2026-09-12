import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import { SESSION_STATUS_CHANGED_EVENT } from "../../shared/runtime/sessionUtils";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { setSessionActivity } from "../../shared/state/sessionActivity";
import SessionsPanel from "./Sessions";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));
vi.mock("../../shared/api/index", () => ({
  sessionList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  sessionStart: vi.fn(), sessionStop: vi.fn(), sessionUnload: vi.fn(),
}));
const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;
const definition: api.SessionDefinition = {
  id: "work", name: "Work session", enabled: true,
  models: { primary_model: "models/work.gguf", mmproj: "", draft_model: "" },
  gpu: { gpu_ids: ["gpu-a"], main_gpu: "gpu-a", split_mode: "none", tensor_split: [], draft_gpu_id: null },
  execution: { ctx_size: 8192, temperature: 0.2, active_backend: "vulkan", active_build: "test-build" },
};
const cfg = { active_model: "models/default.gguf", mmproj: "", spec_draft_model: "", port: 8080, temperature: 0.7, ctx_size: 4096,
  gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null },
  sessions: [definition], stop_existing_sessions_on_load: false,
} as unknown as api.AppConfig;
const settings: ModelSettingsContext = {
  open: vi.fn(), suspended: false, resume: vi.fn(),
  getRequestConfig: (_id, value) => value, getRequestProfile: () => null,
};
function renderPanel(config = cfg) {
  const store = { cfg: config, getConfig: vi.fn(() => config), status: { state: "stopped" }, busy: false,
    updateConfig: vi.fn(async () => config), start: vi.fn(), stop: vi.fn(), refreshStatus: vi.fn(),
  } as unknown as AppStore;
  render(<I18nProvider initialLocale="en"><SessionsPanel store={store} /></I18nProvider>);
  return store;
}
const selectWork = async () => fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
describe("session model settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useModelSettings).mockReturnValue(settings);
    mocked.sessionList.mockResolvedValue([]);
    mocked.sessionUnload.mockResolvedValue(undefined);
    mocked.sessionStart.mockResolvedValue({ id: "work", name: "Work session", state: "running" });
    setSessionActivity("work", false);
    setSessionActivity("default", false);
  });
  it("opens the default target without saving or loading", () => {
    const store = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Model & settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "default" }, config: expect.objectContaining({ active_model: cfg.active_model }) }));
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Primary model")).not.toBeInTheDocument();
  });
  it("passes a session's independent execution and unsaved metadata to the common editor", async () => {
    const store = renderPanel();
    await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Model & settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({
      target: { kind: "session", sessionId: "work" },
      definition: expect.objectContaining({ name: "Renamed draft" }),
      config: expect.objectContaining({ active_model: definition.models.primary_model, ctx_size: 8192, temperature: 0.2, gpu: definition.gpu }),
    }));
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(mocked.sessionStop).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Session name")).toHaveValue("Renamed draft");
  });
  it("provides an unsaved new session to the modal without a preliminary write", () => {
    const store = renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.click(screen.getByRole("button", { name: "Model & settings" }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.target.kind).toBe("session");
    expect(request.definition?.id).toMatch(/^session-/);
    expect(request.config?.active_model).toBe(cfg.active_model);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it("loads the selected session with its own settings and the existing stop policy", async () => {
    renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({
      active_model: definition.models.primary_model, ctx_size: 8192, temperature: 0.2, active_backend: "vulkan", gpu: definition.gpu,
    }), false));
  });
  it("uses settings returned by the modal for the next load", async () => {
    renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Model & settings" }));
    const appliedDefinition = { ...definition, models: { ...definition.models, primary_model: "models/changed.gguf" }, execution: { ...definition.execution, ctx_size: 16384 } };
    await act(async () => { await vi.mocked(settings.open).mock.calls[0][0].onApply?.({ ...cfg, active_model: "models/changed.gguf", sessions: [appliedDefinition] }); });
    fireEvent.click(screen.getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({ active_model: "models/changed.gguf", ctx_size: 16384 }), false));
  });
  it("preserves newer execution settings when saving only a session name", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed" } });
    const latest = { ...definition, execution: { ...definition.execution, ctx_size: 32768 } };
    vi.mocked(store.getConfig).mockReturnValue({ ...cfg, sessions: [latest] });
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ name: "Renamed", execution: latest.execution })] })));
  });
  it("blocks a load that would interrupt a current response", async () => {
    renderPanel({ ...cfg, stop_existing_sessions_on_load: true }); await selectWork();
    setSessionActivity("default", true);
    fireEvent.click(screen.getByRole("button", { name: "Load session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop the active response");
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    setSessionActivity("default", false);
  });
  it("keeps an unpersisted session visible and opens its model settings", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "transient", name: "Transient", state: "running", model: "models/temp.gguf", port: 8094 }]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Transient/ }));
    fireEvent.click(screen.getByRole("button", { name: "Model & settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "session", sessionId: "transient" }, definition: expect.objectContaining({ models: expect.objectContaining({ primary_model: "models/temp.gguf" }) }) }));
  });
  it("updates status while remaining on the session screen", async () => {
    renderPanel();
    await act(async () => {});
    mocked.sessionList.mockResolvedValue([{ id: "transient", name: "Transient", state: "running", model: "models/temp.gguf" }]);
    window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));
    expect(await screen.findByRole("button", { name: /Transient/ })).toBeInTheDocument();
  });
  it.each(["selection", "new"] as const)("asks before discarding metadata edits for %s", async (action) => {
    renderPanel(); await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: action === "selection" ? /Default server/ : "New session" }));
    expect(await screen.findByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
  });
  it("keeps edits when the selected session is clicked again", async () => {
    renderPanel(); await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Changed" } });
    await selectWork();
    expect(screen.getByLabelText("Session name")).toHaveValue("Changed");
  });
  it("unloads a stopped session before removing its definition", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ sessions: [] })));
    expect(mocked.sessionUnload).toHaveBeenCalledWith("work");
  });
  it("preserves the definition after an unload failure", async () => {
    mocked.sessionUnload.mockRejectedValueOnce(new Error("Unload failed"));
    const store = renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unload failed");
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it("does not overwrite a selection when an earlier save completes", async () => {
    const store = renderPanel();
    let finish!: (value: api.AppConfig) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    fireEvent.click(screen.getByRole("button", { name: /Default server/ }));
    await act(async () => { finish(cfg); });
    expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument();
  });
  it("preserves newer metadata edits while a save completes", async () => {
    const store = renderPanel();
    let finish!: (value: api.AppConfig) => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Newer edit" } });
    await act(async () => { finish(cfg); });
    expect(screen.getByLabelText("Session name")).toHaveValue("Newer edit");
  });
  it("keeps disabled definitions available for editing but prevents loading them", async () => {
    renderPanel({ ...cfg, sessions: [{ ...definition, enabled: false }] }); await selectWork();
    expect(screen.getByRole("button", { name: "Load session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Model & settings" })).toBeEnabled();
  });
});
