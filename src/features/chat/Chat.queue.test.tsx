import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement } from "react";
import ChatPanel from "./Chat";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { defaultPreferences, type AppPreferences } from "../../shared/config/preferences";
import { useModelSettings } from "../model-settings/ModelSettingsProvider";
import { chatQueueCopy } from "./chatQueueCopy";

vi.mock("../model-settings/ModelSettingsProvider", () => ({ useModelSettings: vi.fn(() => null) }));

vi.mock("../../shared/api/index", () => ({
  isNativeRuntimeAvailable: vi.fn(() => false),
  pickAttachment: vi.fn(),
  readDocumentText: vi.fn(),
  readDocumentBinding: vi.fn(),
  readImageData: vi.fn(),
  importMedia: vi.fn(),
  embedText: vi.fn(),
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpListServers: vi.fn(),
  mcpListTools: vi.fn(),
  mcpCallTool: vi.fn(),
  mcpCancelToolCall: vi.fn(async () => undefined),
  sessionList: vi.fn(async () => []),
  sessionStart: vi.fn(),
  sessionStop: vi.fn(async () => undefined),
  normalizeSessionList: vi.fn((value: unknown): unknown[] => Array.isArray(value) ? value : []),
  apiServerStatus: vi.fn(async () => ({ running: false, port: 8080 })),
  startApiServer: vi.fn(),
  stopApiServer: vi.fn(),
  resetApiKey: vi.fn(),
}));

const mocked = api as unknown as { [K in keyof typeof api]: Mock };
const copy = chatQueueCopy.en;

const cfg = {
  config_version: 1, models_dir: "", port: 8080, ngl: 0, ctx_size: 4096, batch_size: 2048, ubatch_size: 512, keep: 0,
  cache_type_k: "f16", cache_type_v: "f16", flash_attn: "auto", n_cpu_moe: 0, threads: 8, temperature: 0.7, top_p: 0.9, top_k: 40,
  spec_type: "none", spec_draft_n_max: 16, spec_draft_n_min: 0, spec_draft_p_min: 0, spec_draft_p_split: 0, spec_draft_ngl: "auto",
  spec_draft_device: "", spec_draft_model: "", reasoning: "on", reasoning_format: "deepseek", reasoning_effort: "default",
  reasoning_budget: -1, reasoning_budget_message: "", reasoning_preserve: "", server_args: [], chat_options: { max_tokens: 512 },
  mmproj: "", active_model: "synthetic/queue-model.gguf", active_backend: "PATH", active_build: "", iters: 1, parallel: 1,
  request_timeout_seconds: 60, sleep_idle_seconds: -1, lora_adapters: [],
} satisfies api.AppConfig;

const runningStore = {
  cfg,
  status: { state: "running", url: "http://127.0.0.1:8080", api_key: "synthetic-key", model: cfg.active_model },
  busy: false,
  updateConfig: async () => cfg,
  start: async () => "",
  stop: async () => undefined,
  refreshStatus: async () => undefined,
} as unknown as AppStore;

function panel(store: AppStore, preferences?: AppPreferences) {
  return createElement(I18nProvider, { initialLocale: "en", children: createElement(ChatPanel, { store, preferences }) });
}

const composer = () => screen.getByRole("textbox", { name: "Chat message" });
const type = (text: string) => fireEvent.change(composer(), { target: { value: text } });
const log = () => within(screen.getByRole("log", { name: "Conversation" }));

/** The text of the last user message the model was asked to answer in call `index`. */
function lastUserText(index: number): string {
  const messages = mocked.chatStream.mock.calls[index]![3] as api.ChatMessage[];
  const user = messages.filter(message => message.role === "user").at(-1);
  return typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
}

/** A reply that streams `text` and then runs until released or stopped. */
function heldReply(text: string) {
  let release!: () => void;
  mocked.chatStream.mockImplementationOnce((_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown,
    onDelta: (delta: { content?: string }) => void, signal: AbortSignal) => new Promise<string>((resolve, reject) => {
    onDelta({ content: text });
    release = () => resolve(text);
    signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }));
  return () => act(async () => release());
}

function reply(text: string) {
  mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown,
    onDelta: (delta: { content?: string }) => void) => {
    onDelta({ content: text });
    return text;
  });
}

describe("composer queue and steering", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    mocked.chatStream.mockReset();
    vi.mocked(useModelSettings).mockReturnValue(null);
    mocked.sessionList.mockResolvedValue([]);
  });

  it("keeps the composer editable during a reply and sends queued messages in order once it finishes", async () => {
    const finish = heldReply("Synthetic first answer");
    reply("Synthetic second answer");
    reply("Synthetic third answer");
    render(panel(runningStore));
    type("First question");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });

    expect(composer()).toBeEnabled();
    expect(composer()).toHaveValue("");
    type("Second question");
    fireEvent.keyDown(composer(), { key: "Enter" });
    type("Third question");
    fireEvent.click(screen.getByRole("button", { name: copy.queue }));

    const queue = screen.getByRole("region", { name: copy.queued.replace("{count}", "2") });
    expect(within(queue).getAllByRole("listitem").map(item => item.textContent)).toEqual([
      expect.stringContaining("Second question"), expect.stringContaining("Third question"),
    ]);
    expect(composer()).toHaveValue("");
    expect(mocked.chatStream).toHaveBeenCalledTimes(1);

    await finish();
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(3));
    expect(lastUserText(1)).toContain("Second question");
    expect(lastUserText(2)).toContain("Third question");
    await waitFor(() => expect(log().getByText("Synthetic third answer")).toBeInTheDocument());
    // Each queued turn builds on the finished ones instead of replacing them.
    const lastHistory = JSON.stringify(mocked.chatStream.mock.calls[2]![3]);
    for (const text of ["First question", "Synthetic first answer", "Second question", "Synthetic second answer"]) {
      expect(lastHistory).toContain(text);
      expect(log().getByText(text)).toBeInTheDocument();
    }
    expect(screen.queryByRole("region", { name: /Queued messages/ })).not.toBeInTheDocument();
  });

  it("stops the running reply and sends a steering message right away", async () => {
    heldReply("Partial answer in the wrong direction");
    reply("Steered answer");
    render(panel(runningStore));
    type("Original question");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });

    type("Focus on the second part instead");
    fireEvent.click(screen.getByRole("button", { name: copy.steer }));

    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(2));
    expect(lastUserText(1)).toContain("Focus on the second part instead");
    await waitFor(() => expect(log().getByText("Steered answer")).toBeInTheDocument());
    // The interrupted reply keeps its partial text in the history the model saw.
    // The interrupted exchange stays in the conversation and in what the model saw.
    expect(log().getByText("Original question")).toBeInTheDocument();
    expect(log().getByText("Partial answer in the wrong direction")).toBeInTheDocument();
    expect(JSON.stringify(mocked.chatStream.mock.calls[1]![3])).toContain("Original question");
  });

  it("uses the preferred busy action for Enter and the other one for Alt+Enter", async () => {
    const preferences = { ...defaultPreferences(), chat: { ...defaultPreferences().chat, busySubmit: "steer" as const } };
    heldReply("Running answer");
    const finish = heldReply("Steered answer");
    reply("Queued answer");
    render(panel(runningStore, preferences));
    type("Start");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });

    type("Steer with Enter");
    // The preferred action comes first.
    const actions = screen.getAllByRole("button", { name: new RegExp(`^(${copy.queue}|${copy.steer})$`) });
    expect(actions.map(button => button.textContent)).toEqual([copy.steer, copy.queue]);
    fireEvent.keyDown(composer(), { key: "Enter" });
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(2));
    expect(lastUserText(1)).toContain("Steer with Enter");

    type("Queue with Alt+Enter");
    fireEvent.keyDown(composer(), { key: "Enter", altKey: true });
    expect(screen.getByRole("region", { name: copy.queued.replace("{count}", "1") })).toHaveTextContent("Queue with Alt+Enter");
    await finish();
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(3));
    expect(lastUserText(2)).toContain("Queue with Alt+Enter");
  });

  it("pauses the queue when the user stops a reply and resumes it on request", async () => {
    heldReply("Answer that gets stopped");
    reply("Resumed answer");
    render(panel(runningStore));
    type("Question to stop");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });
    type("Wait for me");
    fireEvent.keyDown(composer(), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    await screen.findByText(copy.paused);
    expect(mocked.chatStream).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: copy.resume }));
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(2));
    expect(lastUserText(1)).toContain("Wait for me");
  });

  it("removes a queued message or sends it ahead of the queue", async () => {
    const finish = heldReply("Running answer");
    reply("Promoted answer");
    render(panel(runningStore));
    type("Start");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });
    for (const text of ["Drop this", "Promote this"]) {
      type(text);
      fireEvent.keyDown(composer(), { key: "Enter" });
    }

    fireEvent.click(screen.getByRole("button", { name: `${copy.remove}: Drop this` }));
    const queue = screen.getByRole("region", { name: copy.queued.replace("{count}", "1") });
    expect(queue).not.toHaveTextContent("Drop this");
    fireEvent.click(within(queue).getByRole("button", { name: copy.sendNow }));

    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(2));
    expect(lastUserText(1)).toContain("Promote this");
    await finish();
    expect(mocked.chatStream).toHaveBeenCalledTimes(2);
  });

  it("queues messages while the model loads and sends them once it is running", async () => {
    reply("Answer after loading");
    const loadingStore = { ...runningStore, status: { state: "starting", model: cfg.active_model }, busy: true } as unknown as AppStore;
    const view = render(panel(loadingStore));
    expect(composer()).toBeEnabled();
    type("Written while loading");
    // Nothing is running, so there is nothing to steer past: only waiting for the load is offered.
    expect(screen.queryByRole("button", { name: copy.steer })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: copy.queueUntilLoaded })).toBeInTheDocument();
    fireEvent.keyDown(composer(), { key: "Enter" });
    expect(screen.getByRole("region", { name: copy.queued.replace("{count}", "1") })).toHaveTextContent("Written while loading");
    expect(mocked.chatStream).not.toHaveBeenCalled();

    view.rerender(panel(runningStore));
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(1));
    expect(lastUserText(0)).toContain("Written while loading");
    await waitFor(() => expect(log().getByText("Answer after loading")).toBeInTheDocument());
  });

  it("does not queue a draft while no model is loaded or loading", () => {
    const stoppedStore = { ...runningStore, status: { state: "stopped" } } as unknown as AppStore;
    render(panel(stoppedStore));
    type("Nobody is loading a model");
    expect(composer()).toBeEnabled();
    expect(screen.queryByRole("button", { name: copy.queue })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.queueUntilLoaded })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    fireEvent.keyDown(composer(), { key: "Enter" });
    // The draft stays put instead of disappearing into a queue that never runs.
    expect(composer()).toHaveValue("Nobody is loading a model");
    expect(screen.queryByRole("region", { name: /Queued messages/ })).not.toBeInTheDocument();
  });

  it("pauses the queue when the model fails to load and sends it after a reload and resume", async () => {
    reply("Answer after reload");
    const loadingStore = { ...runningStore, status: { state: "starting", model: cfg.active_model }, busy: true } as unknown as AppStore;
    const failedStore = { ...runningStore, status: { state: "failed", model: cfg.active_model } } as unknown as AppStore;
    const view = render(panel(loadingStore));
    type("Queued before the failure");
    fireEvent.keyDown(composer(), { key: "Enter" });

    view.rerender(panel(failedStore));
    expect(await screen.findByText(copy.pausedNoModel)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: copy.resume })).not.toBeInTheDocument();

    view.rerender(panel(runningStore));
    // A running model alone does not send it: the user decides when to resume.
    expect(mocked.chatStream).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: copy.resume }));
    await waitFor(() => expect(mocked.chatStream).toHaveBeenCalledTimes(1));
    expect(lastUserText(0)).toContain("Queued before the failure");
    await waitFor(() => expect(log().getByText("Answer after reload")).toBeInTheDocument());
  });

  it("returns a message whose preparation was stopped to the composer and keeps a newer draft", async () => {
    let releaseActivity!: () => void;
    mocked.serverActivity.mockImplementationOnce(() => new Promise<void>(resolve => { releaseActivity = resolve; }));
    render(panel(runningStore));
    type("Stopped during preparation");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await screen.findByRole("button", { name: "Stop generation" });
    type("Newer draft");

    fireEvent.click(screen.getByRole("button", { name: "Stop generation" }));
    await act(async () => releaseActivity());

    // The newer draft stays where it is; the unsent message waits, paused, ahead of the queue.
    await screen.findByText(copy.paused);
    expect(composer()).toHaveValue("Newer draft");
    expect(screen.getByRole("region", { name: copy.queued.replace("{count}", "1") })).toHaveTextContent("Stopped during preparation");
    expect(mocked.chatStream).not.toHaveBeenCalled();
  });
});
