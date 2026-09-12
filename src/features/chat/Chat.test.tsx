import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import ChatPanel from "./Chat";
import { I18nProvider } from "../../shared/i18n/i18n";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { SESSION_STATUS_CHANGED_EVENT } from "../../shared/runtime/sessionUtils";

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
    mocked.sessionList.mockResolvedValue([]);
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
    expect(mocked.serverActivity).toHaveBeenLastCalledWith("end");
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

    await waitFor(() => expect(screen.getByRole("option", { name: "Worker · 8092 · crashed" })).toHaveAttribute("aria-disabled", "true"));
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

  it("keeps the truncation warning visible through an approved MCP tool follow-up", async () => {
    mocked.mcpListServers.mockResolvedValue([{ id: "srv1", name: "Test Server", command: "node", args: [], enabled: true }]);
    mocked.mcpListTools.mockResolvedValue([{ name: "test_tool", description: "A test tool.", input_schema: { type: "object", properties: {} } }]);
    mocked.mcpCallTool.mockResolvedValue({ ok: true });

    renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "Load MCP tools" }));
    await screen.findByText(/Test Server/);

    await attachDocument("big.txt", OVERSIZED_DOCUMENT);

    mocked.chatStream.mockImplementationOnce(async (_url: string, _key: string, _model: string, _messages: unknown, _sampling: unknown, onDelta: (delta: { tool_calls?: Array<{ index: number; id?: string; name?: string; arguments?: string }> }) => void) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "srv1__test_tool", arguments: "{}" }] });
      return "";
    });
    await sendMessage("Use the tool on the attached document.");
    await findTruncationWarning();

    respondWithText("Final answer after the tool call.");
    fireEvent.click(await screen.findByRole("button", { name: "Approve once" }));

    await screen.findByText("Final answer after the tool call.");
    await waitFor(() => expect(mocked.mcpCallTool).toHaveBeenCalledTimes(1));
    await findTruncationWarning();
  });
});
