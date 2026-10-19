import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { I18nProvider } from "../../shared/i18n/i18n";
import type { AppStore } from "../../shared/state/store";
import { SESSION_STATUS_CHANGED_EVENT } from "../../shared/runtime/sessionUtils";
import { useModelSettings, type ModelSettingsContext } from "../model-settings/ModelSettingsProvider";
import { setSessionActivity } from "../../shared/state/sessionActivity";
import SessionsPanel from "./Sessions";
import { getTaskSnapshot, removeTask } from "../../shared/state/taskRegistry";
import { profileLibrary } from "../model-settings/profileEditor";
import { profileTargetKey } from "../../shared/config/settingsProfiles";
import TaskStrip from "../../shared/ui/TaskStrip";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));
vi.mock("../../shared/api/index", () => ({
  sessionList: vi.fn(async () => []),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
  sessionStart: vi.fn(), sessionStop: vi.fn(), sessionUnload: vi.fn(),
  isNativeRuntimeAvailable: vi.fn(() => false), rtList: vi.fn(async () => []), providerRuntimes: vi.fn(async () => []),
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
function renderPanel(config = cfg, status: api.ServerStatus = { state: "stopped" }) {
  const current = structuredClone(config);
  const store = { cfg: current, getConfig: vi.fn(() => current), status, busy: false,
    updateConfig: vi.fn(async (patch: Parameters<AppStore['updateConfig']>[0]) => Object.assign(current, typeof patch === 'function' ? patch(current) : patch)), start: vi.fn(), stop: vi.fn(), refreshStatus: vi.fn(),
  } as unknown as AppStore;
  render(<I18nProvider initialLocale="en"><SessionsPanel store={store} /></I18nProvider>);
  return store;
}
const selectWork = async () => fireEvent.click(await screen.findByRole("button", { name: /Work session/ }));
const sessionRow = (name = "Work session") => within(screen.getByRole("article", { name }));
describe("session model settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const task of getTaskSnapshot()) removeTask(task.id);
    vi.mocked(useModelSettings).mockReturnValue(settings);
    mocked.sessionList.mockResolvedValue([]);
    mocked.isNativeRuntimeAvailable.mockReturnValue(false);
    mocked.providerRuntimes.mockResolvedValue([]);
    mocked.sessionUnload.mockResolvedValue(undefined);
    mocked.sessionStart.mockResolvedValue({ id: "work", name: "Work session", state: "running" });
    setSessionActivity("work", false);
    setSessionActivity("default", false);
  });
  it('names the loaded snapshot from execution rather than the served alias or saved next model', async () => {
    mocked.isNativeRuntimeAvailable.mockReturnValue(true);
    const path = '/synthetic/cache/models--community--Qwen-model/snapshots/' + 'a'.repeat(40);
    mocked.sessionList.mockResolvedValue([{ id: 'work', name: 'Work session', state: 'running', model: 'served-alias', execution: { active_model: path } }]);
    renderPanel();
    expect(await sessionRow().findByText('Qwen-model')).toBeVisible();
    expect(sessionRow().queryByText('served-alias')).not.toBeInTheDocument();
    expect(sessionRow().queryByText('work.gguf')).not.toBeInTheDocument();
  });
  it('names the running Python engine even when the saved session had a llama build', async () => {
    mocked.isNativeRuntimeAvailable.mockReturnValue(true);
    mocked.providerRuntimes.mockResolvedValue([{ provider: 'vllm', id: 'synthetic-metal', version: '0.30.0+cpu', variant: 'vllm-metal', plugin_version: '0.30.0', accelerator: 'metal', installation: 'managed' }]);
    mocked.sessionList.mockResolvedValue([{ id: 'work', name: 'Work session', state: 'running', model: 'synthetic-snapshot',
      engine: { provider: 'vllm', runtime_id: 'synthetic-metal', upstream_model: 'served-model', modalities: { text: true, image: false, audio: false, video: false }, tasks: ['generate'], request_fields: {} } }]);
    renderPanel();
    await selectWork();
    expect(await screen.findByText('vLLM · vllm-metal 0.30.0 · vLLM 0.30.0+cpu (synthetic-metal) · metal · Installed by AioLM')).toBeVisible();
    expect(sessionRow().queryByText(/test-build/)).not.toBeInTheDocument();
  });
  it("opens the loaded default target without overriding it with saved settings", () => {
    const store = renderPanel(cfg, { state: "running", model: "models/live.gguf" });
    fireEvent.click(sessionRow("Default server").getByRole("button", { name: "Model & settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "default" } }));
    expect(vi.mocked(settings.open).mock.calls[0][0]).not.toHaveProperty("config");
    expect(sessionRow("Default server").getByText("live.gguf")).toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Primary model")).not.toBeInTheDocument();
  });
  it("keeps editing and diagnostic controls collapsed while row actions remain available", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work session", state: "running", model: "models/live.gguf", pid: 4321, port: 8094, log_tail: "Ready" }]);
    renderPanel();
    await waitFor(() => expect(sessionRow().getByRole("button", { name: "Stop session" })).toBeEnabled());
    expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Unload" })).not.toBeInTheDocument();
    expect(screen.queryByText("PID 4321")).not.toBeInTheDocument();
    expect(sessionRow().getByText("live.gguf")).toBeInTheDocument();
    await selectWork();
    expect(sessionRow().getByRole("button", { name: /Work session/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Session name")).toHaveValue("Work session");
    expect(screen.getByText("PID 4321")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Unload" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    await selectWork();
    expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument();
  });
  it("offers one stop action for the default session even when its details are expanded", async () => {
    renderPanel(cfg, { state: "running", model: cfg.active_model });
    const row = sessionRow("Default server");
    fireEvent.click(row.getByRole("button", { name: /Default server/ }));
    expect(row.getByRole("button", { name: /Default server/ })).toHaveAttribute("aria-expanded", "true");
    expect(row.queryByRole("button", { name: "Unload" })).not.toBeInTheDocument();
    fireEvent.click(row.getByRole("button", { name: "Stop session" }));
    await waitFor(() => expect(mocked.sessionStop).toHaveBeenCalledWith("default"));
    expect(mocked.sessionUnload).not.toHaveBeenCalled();
  });
  it("opens a named session's settings directly without selecting or saving it", () => {
    const store = renderPanel();
    fireEvent.click(sessionRow().getByRole("button", { name: "Model & settings" }));
    expect(settings.open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: "session", sessionId: "work" }, config: expect.objectContaining({ ctx_size: 8192 }) }));
    expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument();
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it.each(["", "models/previous.gguf"])("omits the stopped default server with saved model %s without hiding named sessions", async (activeModel) => {
    mocked.sessionList.mockResolvedValue([{ id: "default", name: "Default server", state: "stopped", model: "models/old.gguf", log_tail: "Stopped", error: "Previous failure" }]);
    renderPanel({ ...cfg, active_model: activeModel }, { state: "stopped", model: "models/old.gguf", log_tail: "Stopped" });
    await act(async () => {});
    expect(screen.queryByRole("article", { name: "Default server" })).not.toBeInTheDocument();
    expect(sessionRow().getByRole("button", { name: "Load session" })).toBeEnabled();
  });
  it.each(["running", "starting", "stopping", "failed", "crashed"] as const)("retains a default server with %s state when no model is selected", async (state) => {
    mocked.sessionList.mockResolvedValue([{ id: "default", name: "Default server", state, model: state === "running" ? "models/live.gguf" : "", error: state === "failed" ? "Launch failed" : undefined }]);
    renderPanel({ ...cfg, active_model: "" });
    expect(await screen.findByRole("article", { name: "Default server" })).toBeInTheDocument();
    if (state === "failed") expect(screen.getByRole("alert")).toHaveTextContent("Launch failed");
  });
  it("passes a session's independent execution and unsaved metadata to the common editor", async () => {
    const store = renderPanel();
    await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed draft" } });
    fireEvent.click(sessionRow().getByRole("button", { name: "Model & settings" }));
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
    fireEvent.click(sessionRow("New session").getByRole("button", { name: "Model & settings" }));
    const request = vi.mocked(settings.open).mock.calls[0][0];
    expect(request.target.kind).toBe("session");
    expect(request.definition?.id).toMatch(/^session-/);
    expect(request.config?.active_model).toBe(cfg.active_model);
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it("loads a session directly with its own settings and the existing stop policy", async () => {
    renderPanel();
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({
      active_model: definition.models.primary_model, ctx_size: 8192, temperature: 0.2, active_backend: "vulkan", gpu: definition.gpu,
    }), false));
  });

  it("persists the selected profile's latest saved options before loading a session", async () => {
    const configured = structuredClone(cfg);
    const library = profileLibrary(configured);
    const key = profileTargetKey(definition.models.primary_model, definition.id);
    const application = library.applied[key];
    library.entries = library.entries.map(profile => profile.id === application.profile_id
      ? { ...profile, revision: profile.revision + 1, settings: { ...profile.settings, ctx_size: 16384 } } : profile);
    configured.settings_profiles = library;
    const before = structuredClone(configured);
    const store = renderPanel(configured);
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({ ctx_size: 16384 }), false));
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(store.cfg!.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp')).toEqual(before.settings_profiles!.entries.filter(profile => (profile.provider ?? 'llama.cpp') === 'llama.cpp'));
    expect(store.cfg!.settings_profiles!.applied[key].profile_id).toBe(application.profile_id);
    expect(store.cfg!.settings_profiles!.applied[profileTargetKey(cfg.active_model)]).toEqual(before.settings_profiles!.applied[profileTargetKey(cfg.active_model)]);
  });

  it("does not start a session when profile preparation cannot be persisted", async () => {
    const store = renderPanel();
    vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error("Synthetic persistence failure"));
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Synthetic persistence failure");
    expect(mocked.sessionStart).not.toHaveBeenCalled();
  });

  it.each([
    ['launch', 'server exited before ready (1). gguf_init_from_file: invalid magic in /synthetic/cancel-check.gguf'],
    ['launch', 'server exited before ready (1). loader diagnostic: server start cancelled while reading an invalid fixture'],
    ['preparation', 'Unable to persist settings at /synthetic/cancel-profile/config.json'],
  ] as const)('keeps a %s failure visible when its diagnostic contains cancellation text: %s', async (phase, diagnostic) => {
    const model = '/synthetic/cancel-check.gguf';
    const target = { ...definition, models: { ...definition.models, primary_model: model } };
    const store = renderPanel({ ...cfg, sessions: [target] });
    if (phase === 'launch') mocked.sessionStart.mockRejectedValueOnce(diagnostic);
    else vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error(diagnostic));
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(diagnostic);
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')).toMatchObject({ state: 'failed', detail: diagnostic });
    expect(screen.queryByText('Cancelled')).not.toBeInTheDocument();
    await waitFor(() => expect(sessionRow().getByRole('button', { name: 'Load session' })).toBeEnabled());
    if (phase === 'launch') expect(mocked.sessionStart).toHaveBeenCalledWith('work', expect.objectContaining({ active_model: model }), false);
    else expect(mocked.sessionStart).not.toHaveBeenCalled();
  });

  it.each([
    'server start cancelled', 'runtime probe cancelled', 'runtime installation cancelled', 'runtime install cancelled',
  ])('retains the cancelled result for the explicit native sentinel "%s"', async diagnostic => {
    mocked.sessionStart.mockRejectedValueOnce(diagnostic);
    renderPanel();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('cancelled'));
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a runtime failure visible after a cancellation request when the backend does not confirm cancellation', async () => {
    let fail!: (error: string) => void;
    mocked.sessionStart.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    mocked.sessionStop.mockResolvedValueOnce(undefined);
    renderPanel();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    fireEvent.click(sessionRow().getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mocked.sessionStop).toHaveBeenCalledWith('work'));
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('cancelling');

    const diagnostic = 'server exited before ready (1). invalid header in /synthetic/cancel-check.gguf';
    await act(async () => fail(diagnostic));
    expect(screen.getByRole('alert')).toHaveTextContent(diagnostic);
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')).toMatchObject({ state: 'failed', detail: diagnostic });
  });

  it("cancels a load while profile preparation is pending without starting the engine", async () => {
    const store = renderPanel();
    await act(async () => {});
    let finish!: () => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
      finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
    }));
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    fireEvent.click(sessionRow().getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(mocked.sessionStop).toHaveBeenCalledWith("work"));
    await act(async () => finish());
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('cancelled');
  });

  it('keeps loading and cancellation labels when status polling has not created the named session yet', async () => {
    let fail!: (error: Error) => void;
    mocked.sessionStart.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    mocked.sessionStop.mockResolvedValue(undefined);
    renderPanel();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    try {
      await act(async () => { window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT)); });
      expect(sessionRow().getByText('Starting')).toBeInTheDocument();
      expect(sessionRow().queryByText('Stopped')).not.toBeInTheDocument();
      fireEvent.click(sessionRow().getByRole('button', { name: 'Cancel' }));
      await waitFor(() => expect(mocked.sessionStop).toHaveBeenCalledWith('work'));
      await act(async () => { window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT)); });
      expect(screen.getByRole('article', { name: 'Work session' }).querySelector('.app-status-badge')).toHaveTextContent('Working');
      expect(sessionRow().getByRole('button', { name: 'Working' })).toBeDisabled();
      expect(sessionRow().queryByText('Starting')).not.toBeInTheDocument();
    } finally {
      await act(async () => { fail(new Error('server start cancelled')); });
    }
    await waitFor(() => expect(sessionRow().getByText('Stopped')).toBeInTheDocument());
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('cancelled');
  });

  it("does not launch after global cancellation fails while profile preparation is pending", async () => {
    const store = renderPanel();
    render(<I18nProvider initialLocale="en"><TaskStrip /></I18nProvider>);
    await act(async () => {});
    let finish!: () => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
      finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
    }));
    mocked.sessionStop.mockRejectedValueOnce(new Error('Synthetic cancellation failure'));
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    fireEvent.click(within(screen.getByTestId('task-strip')).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('failed'));
    await act(async () => finish());
    expect(mocked.sessionStop).toHaveBeenCalledWith('work');
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('cancelled');
  });

  it.each(['global', 'local'] as const)('does not let a previous %s cancellation failure overwrite the next load of the same session', async source => {
    let failFirst!: (error: Error) => void;
    let finishNext!: (status: api.SessionStatus) => void;
    let failCancellation!: (error: Error) => void;
    mocked.sessionStart
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { failFirst = reject; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve; }));
    mocked.sessionStop.mockImplementationOnce(() => new Promise((_resolve, reject) => { failCancellation = reject; }));
    renderPanel();
    render(<I18nProvider initialLocale="en"><TaskStrip /></I18nProvider>);
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    const cancellation = source === 'global' ? within(screen.getByTestId('task-strip')) : sessionRow();
    fireEvent.click(cancellation.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(mocked.sessionStop).toHaveBeenCalledWith('work'));
    await act(async () => failFirst(new Error('server start cancelled')));
    await waitFor(() => expect(sessionRow().getByRole('button', { name: 'Load session' })).toBeEnabled());
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledTimes(2));
    try {
      await act(async () => failCancellation(new Error('Synthetic previous cancellation IPC error')));
      expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('running');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(sessionRow().getByText('Starting')).toBeInTheDocument();
    } finally {
      await act(async () => finishNext({ id: 'work', name: 'Work session', state: 'running' }));
    }
  });

  it('does not stop a new load through a cancellation callback retained from the completed load', async () => {
    let finishFirst!: (status: api.SessionStatus) => void;
    let finishNext!: (status: api.SessionStatus) => void;
    mocked.sessionStart
      .mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise(resolve => { finishNext = resolve; }));
    renderPanel();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    const previousCancel = getTaskSnapshot().find(task => task.id === 'session-load-work')!.cancel;
    await act(async () => finishFirst({ id: 'work', name: 'Work session', state: 'running' }));
    await waitFor(() => expect(sessionRow().getByRole('button', { name: 'Load session' })).toBeEnabled());
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledTimes(2));
    try {
      await act(async () => previousCancel?.());
      expect(mocked.sessionStop).not.toHaveBeenCalled();
      expect(getTaskSnapshot().find(task => task.id === 'session-load-work')?.state).toBe('running');
    } finally {
      await act(async () => finishNext({ id: 'work', name: 'Work session', state: 'running' }));
    }
  });

  it("uses settings returned by the modal for the next load", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.click(sessionRow().getByRole("button", { name: "Model & settings" }));
    const appliedDefinition = { ...definition, models: { ...definition.models, primary_model: "models/changed.gguf" }, execution: { ...definition.execution, ctx_size: 16384 } };
    await act(async () => {
      await store.updateConfig({ sessions: [appliedDefinition] });
      await vi.mocked(settings.open).mock.calls[0][0].onApply?.({ ...store.cfg!, active_model: "models/changed.gguf" });
    });
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({ active_model: "models/changed.gguf", ctx_size: 16384 }), false));
  });
  it("preserves newer execution settings when saving only a session name", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Renamed" } });
    const latest = { ...definition, enabled: false, execution: { ...definition.execution, ctx_size: 32768 } };
    vi.mocked(store.getConfig).mockReturnValue({ ...cfg, sessions: [latest] });
    fireEvent.click(screen.getByRole("button", { name: "Save session" }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith(expect.objectContaining({ sessions: [expect.objectContaining({ name: "Renamed", enabled: false, execution: latest.execution })] })));
  });
  it("blocks a load that would interrupt a current response", async () => {
    renderPanel({ ...cfg, stop_existing_sessions_on_load: true }); await selectWork();
    setSessionActivity("default", true);
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Stop the active response");
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    setSessionActivity("default", false);
  });
  it("keeps an unpersisted session visible and opens its model settings", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "transient", name: "Transient", state: "running", model: "models/temp.gguf", port: 8094 }]);
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: /Transient/ }));
    fireEvent.click(sessionRow("Transient").getByRole("button", { name: "Model & settings" }));
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
    renderPanel(cfg, { state: "running", model: cfg.active_model }); await selectWork();
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
  it("asks before closing unsaved metadata and discards it only on confirmation", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.change(screen.getByLabelText("Session name"), { target: { value: "Changed" } });
    await selectWork();
    const dialog = await screen.findByRole("dialog", { name: "Unsaved changes" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByLabelText("Session name")).not.toBeInTheDocument();
    await selectWork();
    expect(screen.getByLabelText("Session name")).toHaveValue("Work session");
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it("does not offer launch cancellation while a stop is pending", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work session", state: "running", model: definition.models.primary_model }]);
    let finish!: () => void;
    mocked.sessionStop.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Stop session" }));
    expect(sessionRow().getByRole("button", { name: "Stop session" })).toBeDisabled();
    expect(sessionRow().queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    await act(async () => { finish(); });
  });
  it("unloads a stopped session before removing its definition", async () => {
    const store = renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(store.cfg!.sessions).toEqual([]));
    expect(store.cfg!.settings_profiles).toBeUndefined();
    expect(mocked.sessionUnload).toHaveBeenCalledWith("work");
    expect(screen.queryByRole('article', { name: 'Work session' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Session name')).not.toBeInTheDocument();
  });

  it.each([true, false])('removes only the deleted session application, preserving shared profiles and other targets (assigned: %s)', async assigned => {
    const other: api.SessionDefinition = { ...definition, id: 'other', name: 'Other session',
      models: { ...definition.models, primary_model: 'models/other.gguf' } };
    const configured = { ...cfg, sessions: [definition, other] };
    const library = profileLibrary(configured);
    const key = profileTargetKey(definition.models.primary_model, definition.id);
    const application = structuredClone(library.applied[key]);
    library.revision = 21;
    library.provider_recent = { ...library.provider_recent, 'llama.cpp': application.profile_id };
    library.applied[profileTargetKey('models/remembered.gguf')] = { ...application, model: 'models/remembered.gguf' };
    library.applied['session:legacy-target'] = structuredClone(application);
    if (!assigned) delete library.applied[key];
    const expected = structuredClone(library);
    delete expected.applied[key];
    if (assigned) expected.revision++;
    const store = renderPanel({ ...configured, settings_profiles: library });
    await selectWork();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));

    await waitFor(() => expect(store.cfg!.sessions).toEqual([other]));
    expect(store.cfg!.settings_profiles).toEqual(expected);
    expect(profileLibrary(store.cfg!).applied).toEqual(expected.applied);
    expect(mocked.sessionUnload).toHaveBeenCalledExactlyOnceWith('work');
    expect(mocked.sessionStop).not.toHaveBeenCalled();
    expect(mocked.sessionStart).not.toHaveBeenCalled();
  });

  it('removes the session and its application from the latest queued configuration without losing later saves', async () => {
    const library = profileLibrary(cfg);
    library.revision = 21;
    const store = renderPanel({ ...cfg, settings_profiles: library });
    let finish!: () => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
      finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
    }));
    await selectWork();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());

    const later: api.SessionDefinition = { ...definition, id: 'later', name: 'Later session',
      models: { ...definition.models, primary_model: 'models/later.gguf' } };
    const latest = profileLibrary({ ...store.cfg!, sessions: [definition, later] });
    latest.revision = 22;
    const workKey = profileTargetKey(definition.models.primary_model, definition.id);
    const profileId = latest.applied[workKey].profile_id!;
    latest.entries = latest.entries.map(profile => profile.id === profileId
      ? { ...profile, name: 'Updated shared profile', revision: profile.revision + 1,
        settings: { ...profile.settings, ctx_size: 16384 } } : profile);
    store.cfg!.sessions = [definition, later];
    store.cfg!.settings_profiles = latest;
    const expected = structuredClone(latest);
    delete expected.applied[workKey];
    expected.revision++;

    await act(async () => finish());

    expect(store.cfg!.settings_profiles).toEqual(expected);
    expect(store.cfg!.sessions).toEqual([later]);
    expect(await screen.findByRole('article', { name: 'Later session' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Work session' })).not.toBeInTheDocument();
  });

  it.each(['unload', 'persistence'] as const)('preserves a session and its profile application after a %s failure', async failure => {
    const library = profileLibrary(cfg);
    const store = renderPanel({ ...cfg, settings_profiles: library });
    if (failure === 'unload') mocked.sessionUnload.mockRejectedValueOnce(new Error('Synthetic removal failure'));
    else vi.mocked(store.updateConfig).mockRejectedValueOnce(new Error('Synthetic removal failure'));
    await selectWork();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Synthetic removal failure');
    expect(store.cfg!.sessions).toEqual([definition]);
    expect(store.cfg!.settings_profiles).toEqual(library);
    expect(screen.getByLabelText('Session name')).toHaveValue('Work session');
  });

  it.each(['unload', 'persistence'] as const)('preserves another session selection and unsaved name after removal waits for %s', async pending => {
    const other: api.SessionDefinition = { ...definition, id: 'other', name: 'Other session',
      models: { ...definition.models, primary_model: 'models/other.gguf' } };
    const store = renderPanel({ ...cfg, sessions: [definition, other] });
    let finish!: () => void;
    if (pending === 'unload') {
      mocked.sessionUnload.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
    } else {
      vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
        finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
      }));
    }
    await selectWork();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(pending === 'unload' ? mocked.sessionUnload : store.updateConfig).toHaveBeenCalledOnce());
    fireEvent.click(sessionRow('Other session').getByRole('button', { name: /Other session/ }));
    expect(screen.getByLabelText('Session name')).toHaveValue('Other session');
    expect(sessionRow('Other session').getByRole('button', { name: /Other session/ })).toHaveAttribute('aria-expanded', 'true');
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Keep this unsaved name' } });

    await act(async () => finish());

    await waitFor(() => expect(store.cfg!.sessions).toEqual([other]));
    expect(screen.getByLabelText('Session name')).toHaveValue('Keep this unsaved name');
    expect(sessionRow('Other session').getByRole('button', { name: /Other session/ })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryByRole('article', { name: 'Work session' })).not.toBeInTheDocument();
    expect(store.cfg!.sessions![0].name).toBe('Other session');
    expect(mocked.sessionUnload).toHaveBeenCalledExactlyOnceWith('work');
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    fireEvent.click(sessionRow('Other session').getByRole('button', { name: /Other session/ }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
  });
  it("preserves the definition after an unload failure", async () => {
    mocked.sessionUnload.mockRejectedValueOnce(new Error("Unload failed"));
    const store = renderPanel(); await selectWork();
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unload failed");
    expect(store.updateConfig).not.toHaveBeenCalled();
  });
  it("does not overwrite a selection when an earlier save completes", async () => {
    const store = renderPanel(cfg, { state: "running", model: cfg.active_model });
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
  it("saves the stop-existing load option from its switch", async () => {
    const store = renderPanel();
    const option = screen.getByRole("switch", { name: "Stop existing sessions when loading" });
    expect(option).toHaveAttribute("aria-checked", "false");
    fireEvent.click(option);
    expect(option).toHaveAttribute("aria-checked", "true");
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledWith({ stop_existing_sessions_on_load: true }));
  });
  it("loads a saved session regardless of its legacy enabled value", async () => {
    const store = renderPanel({ ...cfg, sessions: [{ ...definition, enabled: false }] }); await selectWork();
    expect(sessionRow().getByRole("button", { name: "Load session" })).toBeEnabled();
    expect(sessionRow().getByRole("button", { name: "Model & settings" })).toBeEnabled();
    expect(sessionRow().queryByRole("checkbox")).not.toBeInTheDocument();
    fireEvent.click(sessionRow().getByRole("button", { name: "Load session" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({
      active_model: definition.models.primary_model, ctx_size: 8192, temperature: 0.2, active_backend: "vulkan", gpu: definition.gpu,
    }), false));
    expect(store.updateConfig).toHaveBeenCalledOnce();
    expect(store.cfg!.settings_profiles!.applied[profileTargetKey(definition.models.primary_model, definition.id)].profile_id).toBeTruthy();
  });
  it.each(['success', 'failure'] as const)('keeps an unchanged session clean after profile preparation and launch %s', async outcome => {
    const store = renderPanel();
    if (outcome === 'failure') mocked.sessionStart.mockRejectedValueOnce(new Error('Engine launch failed'));
    await selectWork();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled());
    expect(store.cfg!.sessions![0].execution).not.toEqual(definition.execution);
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.queryByRole('dialog', { name: 'Unsaved changes' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Session name')).toHaveValue('');
  });
  it.each(['before loading', 'during preparation'] as const)('preserves an unsaved session name edited %s', async timing => {
    const store = renderPanel();
    let finish!: () => void;
    if (timing === 'during preparation') {
      vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
        finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
      }));
    }
    await selectWork();
    if (timing === 'before loading') fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Keep my unsaved name' } });
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    if (timing === 'during preparation') {
      await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
      fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Keep my unsaved name' } });
      await act(async () => finish());
    }
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled());
    expect(screen.getByLabelText('Session name')).toHaveValue('Keep my unsaved name');
    expect(store.cfg!.sessions![0].name).toBe('Work session');
    fireEvent.click(screen.getByRole('button', { name: 'New session' }));
    expect(screen.getByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument();
  });
  it('retains a later session selection while an earlier session finishes profile preparation', async () => {
    const other = { ...structuredClone(definition), id: 'other', name: 'Other session' };
    const store = renderPanel({ ...cfg, sessions: [definition, other] });
    let finish!: () => void;
    vi.mocked(store.updateConfig).mockImplementationOnce(patch => new Promise(resolve => {
      finish = () => resolve(Object.assign(store.cfg!, typeof patch === 'function' ? patch(store.cfg!) : patch));
    }));
    await selectWork();
    fireEvent.click(sessionRow().getByRole('button', { name: 'Load session' }));
    await waitFor(() => expect(store.updateConfig).toHaveBeenCalledOnce());
    fireEvent.click(sessionRow('Other session').getByRole('button', { name: /Other session/ }));
    fireEvent.change(screen.getByLabelText('Session name'), { target: { value: 'Later session edit' } });
    await act(async () => finish());
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole('button', { name: 'New session' })).toBeEnabled());
    expect(screen.getByLabelText('Session name')).toHaveValue('Later session edit');
    expect(sessionRow('Other session').getByRole('button', { name: /Other session/ })).toHaveAttribute('aria-expanded', 'true');
    expect(store.cfg!.sessions!.find(item => item.id === 'other')).toEqual(other);
  });
  it("localizes active-response guard alerts and explains why Load session is disabled when no model is selected", async () => {
    const emptyModelSession: api.SessionDefinition = { ...definition, id: "empty", name: "Empty session", models: { primary_model: "", mmproj: "", draft_model: "" } };
    const current = structuredClone({ ...cfg, stop_existing_sessions_on_load: true, sessions: [definition, emptyModelSession] });
    const store = { cfg: current, getConfig: vi.fn(() => current), status: { state: "stopped" }, busy: false,
      updateConfig: vi.fn(async (patch: Parameters<AppStore['updateConfig']>[0]) => Object.assign(current, typeof patch === 'function' ? patch(current) : patch)), start: vi.fn(), stop: vi.fn(), refreshStatus: vi.fn(),
    } as unknown as AppStore;
    render(<I18nProvider initialLocale="ko"><SessionsPanel store={store} /></I18nProvider>);
    const emptyLoad = sessionRow("Empty session").getByRole("button", { name: "세션 로드" });
    expect(emptyLoad).toBeDisabled();
    expect(emptyLoad).toHaveAttribute("title", "주 모델이 선택되지 않음");

    setSessionActivity("default", true);
    fireEvent.click(sessionRow("Work session").getByRole("button", { name: "세션 로드" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("모델을 로드하기 전에 진행 중인 응답을 중지하세요.");
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    setSessionActivity("default", false);
  });
});
