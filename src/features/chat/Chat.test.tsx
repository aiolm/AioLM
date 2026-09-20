import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import ChatPanel from "./Chat";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { SESSION_STATUS_CHANGED_EVENT, sessionConfig } from "../../shared/runtime/sessionUtils";
import { sessionHasActivity } from "../../shared/state/sessionActivity";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { createTestStore } from "../../testing/appStore";
import { captureProfile, defaultSettingsProfile, emptyProfileLibrary, materializeProfileApplication, profileTargetKey } from "../../shared/config/settingsProfiles";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  pickAttachment: vi.fn(),
  readDocumentText: vi.fn(),
  readDocumentBinding: vi.fn(),
  readImageData: vi.fn(),
  embedText: vi.fn(),
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  sessionList: vi.fn(async () => []),
  sessionStart: vi.fn(async () => ({ id: "work", state: "running" })),
  normalizeSessionList: vi.fn((value: unknown) => Array.isArray(value) ? value : []),
}));

const mocked = api as unknown as Record<string, ReturnType<typeof vi.fn>>;

const cfg = {
  config_version: 1,
  models_dir: "",
  port: 8080,
  ngl: 0,
  ctx_size: 4096,
  batch_size: 2048,
  ubatch_size: 512,
  keep: 0,
  cache_type_k: "f16",
  cache_type_v: "f16",
  flash_attn: "auto",
  n_cpu_moe: 0,
  threads: 8,
  temperature: 0.7,
  top_p: 0.9,
  top_k: 40,
  spec_type: "none",
  spec_draft_n_max: 16,
  spec_draft_n_min: 0,
  spec_draft_p_min: 0,
  spec_draft_p_split: 0,
  spec_draft_ngl: "auto",
  spec_draft_device: "",
  spec_draft_model: "",
  reasoning: "on",
  reasoning_format: "deepseek",
  reasoning_effort: "default",
  reasoning_budget: -1,
  reasoning_budget_message: "",
  reasoning_preserve: "",
  server_args: [],
  chat_options: { max_tokens: 512 },
  mmproj: "",
  active_model: "C:/models/example.gguf",
  active_backend: "PATH",
  active_build: "",
  iters: 1,
  parallel: 1,
  request_timeout_seconds: 60,
  sleep_idle_seconds: -1,
  lora_adapters: [],
} satisfies api.AppConfig;

const store = {
  cfg,
  status: { state: "running", url: "http://127.0.0.1:8080", api_key: "test-key", model: cfg.active_model },
  busy: false,
  updateConfig: async () => cfg,
  start: async () => "",
  stop: async () => undefined,
  refreshStatus: async () => undefined,
} as unknown as AppStore;

function renderPanel(panelStore = store) {
  return render(createElement(I18nProvider, { initialLocale: "en", children: createElement(ChatPanel, { store: panelStore }) }));
}

function namedSessionStore() {
  const definition: api.SessionDefinition = { id: "work", name: "Work", enabled: false,
    models: { primary_model: "models/work.gguf", mmproj: "", draft_model: "" },
    gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null },
    execution: { ctx_size: 8192, temperature: 0.2 },
  };
  const panelStore = createTestStore({ ...cfg, sessions: [definition], stop_existing_sessions_on_load: false });
  const target = sessionConfig(panelStore.cfg!, definition);
  const selected = { ...captureProfile({ ...target, ctx_size: 16384, temperature: 0.5, ngl: 17 }, "Saved session profile", "model", "Latest instruction"), revision: 2 };
  const fallback = defaultSettingsProfile();
  const original = { ...materializeProfileApplication(target, "Earlier instruction", selected), profile_revision: 1 };
  const defaultApplication = materializeProfileApplication(panelStore.cfg!, "", fallback);
  panelStore.cfg!.settings_profiles = { ...emptyProfileLibrary(), legacy_imported: true, entries: [fallback, selected],
    default_profile_id: fallback.id, applied: { [profileTargetKey(cfg.active_model)]: defaultApplication, "session:work": original } };
  return { panelStore, selected, defaultApplication };
}

/** 200KB of attached text: ~112 chunks at the 1800-char chunk size, well past the 64-chunk search limit. */
const OVERSIZED_DOCUMENT = "x".repeat(200_000);
/** A few chunks, safely under the 64-chunk search limit. */
const SMALL_DOCUMENT = "y".repeat(3_000);

async function attachDocument(name: string, text: string) {
  mocked.pickAttachment.mockResolvedValue(`C:/docs/${name}`);
  mocked.readDocumentText.mockResolvedValue(text);
  fireEvent.click(await screen.findByRole("button", { name: "Attach file" }));
  await screen.findByText(name);
}

function respondWithText(text: string) {
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
    onDelta({ content: text });
    return text;
  });
}

/** Streams `parts` as separate deltas, mirroring how a real server splits one response across several SSE chunks. */
function respondWithDeltas(parts: string[]) {
  const full = parts.join("");
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
    for (const part of parts) onDelta({ content: part });
    return full;
  });
}

async function sendMessage(text: string) {
  fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Send message" }));
}

async function findTruncationWarning() {
  const warning = await screen.findByRole("status", { name: "Context warning" });
  expect(warning.textContent ?? "").toMatch(/first 64 document chunks/i);
  return warning;
}

describe("ChatPanel unified attachments", () => {
  const visionStore = { ...store, status: { ...store.status, mmproj: "C:/models/mmproj.gguf" } };

  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(useModelSettings).mockReturnValue(null);
    mocked.sessionList.mockResolvedValue([]);
  });

  it("sends the original model identifier for a sharded model", async () => {
    // The heading no longer repeats the model name — the app header and the
    // composer footer already carry it — but the request must still name the
    // first shard exactly as the server knows it, not a grouped display name.
    const model = "Qwen3.8-Flash-Next-AD-4.27bpw-Q4_K_M-M64-00001-of-00033";
    renderPanel({ ...store, cfg: { ...cfg, active_model: model }, status: { ...store.status, model } });
    // Let the stored workspace finish hydrating first: it replaces the message
    // buffer, and a send racing it would be overwritten before it renders.
    await screen.findByRole("log", { name: "Conversation" });
    respondWithText("Ready");
    await sendMessage("Hello");
    await screen.findByText("Ready", { exact: true });
    expect(mocked.chatStream.mock.calls[0][2]).toBe(model);
  });

  it("attaches documents and images with one button and blocks another selection while reading", async () => {
    renderPanel(visionStore);
    await attachDocument("notes.txt", SMALL_DOCUMENT);
    const attachButton = screen.getByRole("button", { name: "Attach file" });
    expect(screen.queryByRole("button", { name: "Attach document" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Attach image" })).not.toBeInTheDocument();

    let finishReading!: (dataUrl: string) => void;
    mocked.pickAttachment.mockResolvedValue("C:/images/photo.JPEG");
    mocked.readImageData.mockImplementationOnce(() => new Promise<string>(resolve => { finishReading = resolve; }));
    fireEvent.click(attachButton);
    await waitFor(() => expect(mocked.readImageData).toHaveBeenCalledWith("C:/images/photo.JPEG"));
    expect(attachButton).toBeDisabled();
    fireEvent.click(attachButton);
    expect(mocked.pickAttachment).toHaveBeenCalledTimes(2);

    await act(async () => finishReading("data:image/jpeg;base64,cGhvdG8="));
    expect(screen.getByRole("img", { name: "photo.JPEG" })).toBeInTheDocument();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(mocked.readDocumentText).toHaveBeenCalledTimes(1);
    expect(attachButton).toBeEnabled();
  });

  it("explains the vision requirement for a selected image and still lets the user attach a document", async () => {
    renderPanel();
    mocked.pickAttachment.mockResolvedValue("C:/images/photo.png");
    fireEvent.click(await screen.findByRole("button", { name: "Attach file" }));
    const error = await screen.findByText(/Select an mmproj vision sidecar/);
    expect(mocked.readImageData).not.toHaveBeenCalled();
    expect(mocked.readDocumentText).not.toHaveBeenCalled();

    await attachDocument("notes.txt", SMALL_DOCUMENT);
    expect(error).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Attach file" })).toBeEnabled();
  });

  it("keeps existing attachments when file selection is cancelled", async () => {
    renderPanel();
    await attachDocument("notes.txt", SMALL_DOCUMENT);
    mocked.pickAttachment.mockResolvedValue(null);
    const attachButton = screen.getByRole("button", { name: "Attach file" });
    fireEvent.click(attachButton);
    await waitFor(() => expect(attachButton).toBeEnabled());

    expect(mocked.pickAttachment).toHaveBeenCalledTimes(2);
    expect(mocked.readDocumentText).toHaveBeenCalledTimes(1);
    expect(mocked.readImageData).not.toHaveBeenCalled();
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("keeps image slots available when four documents are attached and enforces both limits", async () => {
    renderPanel(visionStore);
    for (let index = 0; index < 4; index++) await attachDocument(`notes-${index}.txt`, SMALL_DOCUMENT);
    const attachButton = screen.getByRole("button", { name: "Attach file" });
    expect(attachButton).toBeEnabled();

    mocked.pickAttachment.mockResolvedValue("C:/docs/extra.txt");
    fireEvent.click(attachButton);
    await waitFor(() => expect(attachButton).toBeEnabled());
    expect(screen.queryByText("extra.txt")).not.toBeInTheDocument();

    for (let index = 0; index < 4; index++) {
      mocked.pickAttachment.mockResolvedValue(`C:/images/photo-${index}.png`);
      mocked.readImageData.mockResolvedValue(`data:image/png;base64,${btoa(`photo-${index}`)}`);
      fireEvent.click(attachButton);
      await screen.findByRole("img", { name: `photo-${index}.png` });
    }
    expect(attachButton).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Remove attachment: notes-0.txt" }));
    expect(attachButton).toBeEnabled();
    await attachDocument("replacement.txt", SMALL_DOCUMENT);
    expect(attachButton).toBeDisabled();
  });
});

describe("ChatPanel document context warning", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(useModelSettings).mockReturnValue(null);
    mocked.serverActivity.mockResolvedValue(undefined);
    // Every request embeds one vector per input string; the content does not matter for ranking here.
    mocked.embedText.mockImplementation(async (_url: string, _key: string, _model: string, input: string[]) => input.map(() => [1]));
  });

  it("lets the user target a running independent session", async () => {
    mocked.sessionList.mockResolvedValue([{
      id: "vision-session",
      name: "Vision",
      state: "running",
      url: "http://127.0.0.1:8091",
      api_key: "session-key",
      model: "C:/models/vision.gguf",
      port: 8091,
    }]);
    mocked.normalizeSessionList.mockImplementation((value: unknown) => value);

    renderPanel();

    const selector = await screen.findByLabelText("Loaded sessions");
    fireEvent.click(selector); await screen.findByRole("option", { name: "Vision · 8091 · running" });
    fireEvent.click(screen.getByRole("option", { name: "Vision · 8091 · running" }));
    expect(selector).toHaveTextContent("Vision · 8091 · running");
  });

  it("uses the selected session's live request settings and activity identity", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work", state: "running", port: 8091,
      url: "http://127.0.0.1:8091", api_key: "work-key", model: "models/work.gguf",
      execution: { ctx_size: 8192, temperature: 0.25, top_k: 12, chat_options: { max_tokens: 96 } },
    }]);
    renderPanel();
    fireEvent.click(await screen.findByLabelText("Loaded sessions"));
    fireEvent.click(await screen.findByRole("option", { name: "Work · 8091 · running" }));
    respondWithText("Session answer");
    await sendMessage("Hello");
    await screen.findByText("Session answer");
    expect(mocked.chatStream).toHaveBeenCalledWith("http://127.0.0.1:8091", "work-key", "models/work.gguf", expect.any(Array),
      expect.objectContaining({ temperature: 0.25, top_k: 12, options: { max_tokens: 96 } }), expect.any(Function), expect.any(AbortSignal));
    expect(mocked.serverActivity).toHaveBeenCalledWith("start", "work");
    expect(mocked.serverActivity).toHaveBeenLastCalledWith("end", "work");
    expect(sessionHasActivity("work")).toBe(false);
  });

  it('opens the model picker when the default session is stopped despite a saved model', async () => {
    const open = vi.fn();
    const start = vi.fn();
    vi.mocked(useModelSettings).mockReturnValue({ open, suspended: false, resume: vi.fn(), getRequestConfig: (_id, value) => value, getRequestProfile: () => null });
    renderPanel({ ...store, status: { state: 'stopped', model: cfg.active_model }, start });
    expect(screen.queryByText('Model ready')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Start server' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model & settings' }));
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ target: { kind: 'default' } }));
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps a conversation and offers no settings action of its own once its server stops", async () => {
    // The heading no longer carries a model-settings button — the app header
    // opens the same editor — so the only one the panel raises is the blocked
    // view's, and that view is for an empty conversation with nowhere to type.
    const open = vi.fn();
    vi.mocked(useModelSettings).mockReturnValue({ open, suspended: false, resume: vi.fn(), getRequestConfig: (_id, value) => value, getRequestProfile: () => null });
    mocked.sessionList.mockResolvedValue([]);
    const view = renderPanel();
    await waitFor(() => expect(localStorage.getItem("aiolm.chat-workspace.v2")).not.toBeNull());
    expect(screen.queryByRole("button", { name: "Model & settings" })).not.toBeInTheDocument();

    respondWithText("Conversation retained");
    await sendMessage("Hello");
    await screen.findByText("Conversation retained", { exact: true });
    view.rerender(createElement(I18nProvider, {
      initialLocale: "en",
      children: createElement(ChatPanel, { store: { ...store, status: { state: "stopped", model: cfg.active_model } } }),
    }));
    expect(screen.getByText("Conversation retained", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Model & settings" })).not.toBeInTheDocument();
    expect(open).not.toHaveBeenCalled();
  });

  it("starts a stopped session with its saved settings regardless of its legacy enabled value", async () => {
    mocked.sessionList.mockResolvedValue([]);
    const definition: api.SessionDefinition = { id: "work", name: "Work", enabled: false,
      models: { primary_model: "models/work.gguf", mmproj: "", draft_model: "" },
      gpu: { gpu_ids: [], main_gpu: null, split_mode: "none", tensor_split: [], draft_gpu_id: null },
      execution: { ctx_size: 8192, temperature: 0.2 },
    };
    const panelStore = createTestStore({ ...cfg, sessions: [definition], stop_existing_sessions_on_load: false });
    renderPanel(panelStore);
    fireEvent.click(await screen.findByLabelText("Loaded sessions"));
    fireEvent.click(await screen.findByRole("option", { name: "Work · — · stopped" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start server" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({ active_model: "models/work.gguf", ctx_size: 8192, temperature: 0.2 }), false));
    expect(panelStore.start).not.toHaveBeenCalled();
  });

  it("starts a named session with its latest selected profile while preserving profile identities and other targets", async () => {
    mocked.sessionList.mockResolvedValue([]);
    const { panelStore, selected, defaultApplication } = namedSessionStore();
    const entries = structuredClone(panelStore.cfg!.settings_profiles!.entries);
    renderPanel(panelStore);
    fireEvent.click(await screen.findByLabelText("Loaded sessions"));
    fireEvent.click(await screen.findByRole("option", { name: "Work · — · stopped" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start server" }));
    await waitFor(() => expect(mocked.sessionStart).toHaveBeenCalledWith("work", expect.objectContaining({
      active_model: "models/work.gguf", ctx_size: 16384, temperature: 0.5, ngl: 17,
    }), false));
    const library = panelStore.getConfig()!.settings_profiles!;
    expect(library.entries).toEqual(entries);
    expect(library.applied["session:work"]).toMatchObject({ profile_id: selected.id, profile_revision: 2, system_prompt: "Latest instruction" });
    expect(library.applied[profileTargetKey(cfg.active_model)]).toEqual(defaultApplication);
    expect(panelStore.cfg!.sessions![0]).toMatchObject({ id: "work", name: "Work", enabled: false, execution: { ctx_size: 16384, temperature: 0.5 } });
    expect(panelStore.cfg!.temperature).toBe(cfg.temperature);
    expect(panelStore.start).not.toHaveBeenCalled();
  });

  it("does not launch a named session when saving its selected profile application fails", async () => {
    mocked.sessionList.mockResolvedValue([]);
    const { panelStore } = namedSessionStore();
    const before = structuredClone(panelStore.cfg);
    vi.mocked(panelStore.updateConfig).mockRejectedValueOnce(new Error("Profile save failed"));
    renderPanel(panelStore);
    fireEvent.click(await screen.findByLabelText("Loaded sessions"));
    fireEvent.click(await screen.findByRole("option", { name: "Work · — · stopped" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start server" }));
    expect(await screen.findByText(/Profile save failed/)).toBeInTheDocument();
    expect(mocked.sessionStart).not.toHaveBeenCalled();
    expect(panelStore.start).not.toHaveBeenCalled();
    expect(panelStore.cfg).toEqual(before);
    expect(screen.getByRole("button", { name: "Start server" })).toBeEnabled();
  });

  it("changes the answering session without clearing the composer or attachments", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "work", name: "Work", state: "running", port: 8091, model: "models/work.gguf", url: "http://127.0.0.1:8091", api_key: "work-key" }]);
    renderPanel();
    await attachDocument("notes.txt", SMALL_DOCUMENT);
    fireEvent.change(screen.getByLabelText("Chat message"), { target: { value: "Keep this draft" } });
    const picker = screen.getByLabelText("Loaded sessions");
    fireEvent.click(picker);
    fireEvent.click(await screen.findByRole("option", { name: "Work · 8091 · running" }));

    expect(picker).toHaveTextContent("Work · 8091 · running");
    expect(screen.getByLabelText("Chat message")).toHaveValue("Keep this draft");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
  });

  it("keeps one untouched conversation however often a new one is asked for", async () => {
    // Every press used to append another identical "New conversation" row, and
    // leaving one behind kept it in the list for good.
    renderPanel();
    await waitFor(() => expect(localStorage.getItem("aiolm.chat-workspace.v2")).not.toBeNull());
    const list = () => within(screen.getByRole("list"));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    for (let press = 0; press < 3; press += 1) {
      fireEvent.click(screen.getByRole("button", { name: "New chat" }));
      fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    }
    expect(list().getAllByRole("listitem")).toHaveLength(1);

    // A conversation that holds something is a record worth keeping, and asking
    // for a new one beside it is not the same as asking twice for an empty one.
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    respondWithText("Kept");
    await sendMessage("Remember this");
    await screen.findByText("Kept", { exact: true });
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(list().getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(list().getAllByRole("listitem")).toHaveLength(2);
  });

  it("lets another conversation be read while a reply is still arriving, and lands the reply in the one that asked", async () => {
    // Blocking the switch used to be the only way to keep a reply attached to
    // its conversation. The message buffer stays pinned to the conversation that
    // asked instead, so the view is free to move while the answer streams in.
    const answer = "Answer for the first conversation";
    let finish!: () => void;
    mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { content?: string }) => void) => {
      onDelta({ content: answer });
      await new Promise<void>((resolve) => { finish = resolve; });
      return answer;
    });
    renderPanel();
    await waitFor(() => expect(localStorage.getItem("aiolm.chat-workspace.v2")).not.toBeNull());
    const log = () => within(screen.getByRole("log", { name: "Conversation" }));
    await sendMessage("Question");
    await waitFor(() => expect(log().getByText(answer)).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(screen.getByRole("button", { name: "New chat" }));
    expect(log().queryByText("Question")).not.toBeInTheDocument();
    expect(log().queryByText(answer)).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();

    await act(async () => { finish(); });
    // The conversation being read stays empty; the answer belongs to the older one.
    expect(log().queryByText(answer)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Question" }));
    await waitFor(() => expect(log().getByText(answer)).toBeInTheDocument());
  });

  it("captures request settings before asynchronous preparation", async () => {
    mocked.sessionList.mockResolvedValue([]);
    let release!: () => void;
    mocked.serverActivity.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const mutableConfig = structuredClone(cfg);
    renderPanel({ ...store, cfg: mutableConfig });
    respondWithText("Original settings");
    await sendMessage("Hello");
    expect(sessionHasActivity("default")).toBe(true);
    mutableConfig.temperature = 0.1;
    mutableConfig.chat_options.max_tokens = 8;
    await act(async () => release());
    await screen.findByText("Original settings");
    expect(mocked.chatStream.mock.calls[0][4]).toMatchObject({ temperature: 0.7, options: { max_tokens: 512 } });
    expect(sessionHasActivity("default")).toBe(false);
  });

  it("sets the full conversation title before asynchronous request preparation finishes", async () => {
    let release!: () => void;
    mocked.serverActivity.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    renderPanel();
    await waitFor(() => expect(localStorage.getItem("aiolm.chat-workspace.v2")).not.toBeNull());
    const title = "A complete conversation title that must not resize the heading after generation. ".repeat(5).trim();
    respondWithText("Done.");
    await sendMessage(title);
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
    expect(mocked.chatStream).not.toHaveBeenCalled();
    release();
    await screen.findByText("Done.");
    expect(screen.getByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("locks the composer while preparing a request and lets Stop cancel before generation", async () => {
    let release!: () => void;
    mocked.serverActivity.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    renderPanel();
    await sendMessage("Keep this draft when preparation is cancelled.");

    const composer = screen.getByLabelText("Chat message");
    expect(composer).toBeDisabled();
    expect(screen.getByLabelText("Loaded sessions")).toBeDisabled();
    fireEvent.keyDown(composer, { key: "Enter" });
    expect(mocked.serverActivity).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    await act(async () => release());

    await waitFor(() => expect(composer).toBeEnabled());
    expect(composer).toHaveValue("Keep this draft when preparation is cancelled.");
    expect(mocked.chatStream).not.toHaveBeenCalled();
    expect(mocked.serverActivity).toHaveBeenLastCalledWith("end", "default");
  });

  it("cancels document preparation without sending or losing the attachment", async () => {
    let release!: (vectors: number[][]) => void;
    mocked.embedText.mockImplementationOnce(() => new Promise<number[][]>(resolve => { release = resolve; }));
    renderPanel();
    await attachDocument("cancel.txt", SMALL_DOCUMENT);
    await sendMessage("Summarize this document.");
    await waitFor(() => expect(mocked.embedText).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    await act(async () => release([]));

    await waitFor(() => expect(screen.getByLabelText("Chat message")).toBeEnabled());
    expect(screen.getByLabelText("Chat message")).toHaveValue("Summarize this document.");
    expect(screen.getByText("cancel.txt")).toBeInTheDocument();
    expect(mocked.chatStream).not.toHaveBeenCalled();
  });

  it("refreshes independent session state while chat remains open", async () => {
    mocked.sessionList.mockResolvedValue([{ id: "worker", name: "Worker", state: "running", port: 8092, url: "http://127.0.0.1:8092", api_key: "key", model: "worker.gguf" }]);
    mocked.normalizeSessionList.mockImplementation((value: unknown) => value);
    renderPanel();

    const selector = await screen.findByLabelText("Loaded sessions");
    fireEvent.click(selector); await screen.findByRole("option", { name: "Worker · 8092 · running" });

    mocked.sessionList.mockResolvedValue([{ id: "worker", name: "Worker", state: "crashed", port: 8092, model: "worker.gguf" }]);
    window.dispatchEvent(new Event(SESSION_STATUS_CHANGED_EVENT));

    await waitFor(() => expect(screen.getByRole("option", { name: "Worker · 8092 · crashed" })).not.toHaveAttribute("aria-disabled", "true"));
  });

  it("warns in the DOM when an attached document exceeds the 64-chunk search limit", async () => {
    renderPanel();
    await attachDocument("big.txt", OVERSIZED_DOCUMENT);
    respondWithText("Here is what I found.");
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Here is what I found.");
    await findTruncationWarning();
  });

  it("assembles a response streamed across multiple deltas and still shows the truncation warning", async () => {
    renderPanel();
    await attachDocument("big.txt", OVERSIZED_DOCUMENT);
    respondWithDeltas(["Here ", "is what ", "I found, ", "in full."]);
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Here is what I found, in full.");
    await findTruncationWarning();
    expect(mocked.chatStream).toHaveBeenCalledTimes(1);
  });

  it("shows no truncation warning when the document stays within the 64-chunk search limit", async () => {
    renderPanel();
    await attachDocument("small.txt", SMALL_DOCUMENT);
    respondWithText("Sure, here is a summary.");
    await sendMessage("Summarize the attached document.");

    await screen.findByText("Sure, here is a summary.");
    expect(screen.queryByText(/first 64 document chunks/i)).not.toBeInTheDocument();
  });

  it("keeps earlier answers in a multi-turn conversation and its saved history", async () => {
    renderPanel();
    await waitFor(() => expect(localStorage.getItem("aiolm.chat-workspace.v2")).not.toBeNull());
    respondWithText("The first answer.");
    await sendMessage("First question.");
    await screen.findByText("The first answer.");
    respondWithText("The second answer.");
    await sendMessage("Second question.");
    await screen.findByText("The second answer.");
    expect(screen.getByText("The first answer.")).toBeInTheDocument();
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("aiolm.chat-workspace.v2") ?? "null");
      expect(saved.threads[0].messages.map((message: { content: string }) => message.content)).toEqual([
        "First question.", "The first answer.", "Second question.", "The second answer.",
      ]);
    });
  });

  it("opens tool controls without loading until their single load action is used", async () => {
    mocked.mcpListServers.mockResolvedValue([{ id: "srv1", name: "Test Server", command: "node", args: [], enabled: true }]);
    mocked.mcpListTools.mockResolvedValue([{ name: "test_tool", description: "A test tool.", input_schema: { type: "object", properties: {} } }]);
    renderPanel();
    fireEvent.click(screen.getByText("MCP tools", { selector: "summary" }));
    expect(mocked.mcpListServers).not.toHaveBeenCalled();
    const load = screen.getAllByRole("button", { name: "Load MCP tools" });
    expect(load).toHaveLength(1);
    fireEvent.click(load[0]);
    await screen.findByText(/Test Server/);
    expect(mocked.mcpListServers).toHaveBeenCalledOnce();
    expect(mocked.mcpListTools).toHaveBeenCalledWith("srv1");
  });

  it("keeps the truncation warning visible through an approved MCP tool follow-up", async () => {
    mocked.mcpListServers.mockResolvedValue([{ id: "srv1", name: "Test Server", command: "node", args: [], enabled: true }]);
    mocked.mcpListTools.mockResolvedValue([{ name: "test_tool", description: "A test tool.", input_schema: { type: "object", properties: {} } }]);
    mocked.mcpCallTool.mockResolvedValue({ ok: true });

    const mutableConfig = structuredClone(cfg);
    renderPanel({ ...store, cfg: mutableConfig });
    fireEvent.click(await screen.findByRole("button", { name: "Load MCP tools" }));
    await screen.findByText(/Test Server/);

    await attachDocument("big.txt", OVERSIZED_DOCUMENT);

    mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { tool_calls?: Array<{ index: number; id?: string; name?: string; arguments?: string }> }) => void) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "srv1__test_tool", arguments: "{}" }] });
      return "";
    });
    await sendMessage("Use the tool on the attached document.");
    await findTruncationWarning();
    expect(sessionHasActivity("default")).toBe(true);
    expect(screen.getByLabelText("Loaded sessions")).toBeDisabled();
    expect(mocked.serverActivity).toHaveBeenCalledTimes(1);
    mutableConfig.temperature = 0.05;
    mutableConfig.chat_options.max_tokens = 12;

    respondWithText("Final answer after the tool call.");
    fireEvent.click(await screen.findByRole("button", { name: "Approve once" }));

    await screen.findByText("Final answer after the tool call.");
    await waitFor(() => expect(mocked.mcpCallTool).toHaveBeenCalledTimes(1));
    await findTruncationWarning();
    expect(mocked.chatStream.mock.calls[1][4]).toMatchObject({ temperature: 0.7, options: { max_tokens: 512 } });
    expect(sessionHasActivity("default")).toBe(false);
    expect(mocked.serverActivity).toHaveBeenLastCalledWith("end", "default");
  });
});
