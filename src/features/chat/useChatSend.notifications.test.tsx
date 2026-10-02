import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { notifyCompletion } from "../../shared/lib/notifications";
import { createTestStore } from "../../testing/appStore";
import type { ChatHistoryMessage } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { useChatSend } from "./useChatSend";

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn(async () => ({ content: "Tool result" })),
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const notifyMock = vi.mocked(notifyCompletion);
const streamMock = vi.mocked(api.chatStream);

function setup(withTool = false) {
  const store = createTestStore();
  return renderHook(() => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>([]);
    const [input, setInput] = useState("Hello");
    const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
    const atBottomRef = useRef(true);
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null,
      sessionId: "notify-session", baseUrl: "http://127.0.0.1:8080", apiKey: "test-key", model: "model.gguf",
      activeThread: undefined, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpEntryByFunctionName: withTool
        ? new Map([["lookup", { serverId: "catalog", serverName: "Catalog", tool: { name: "lookup", input_schema: { type: "object" } } }]])
        : new Map(),
      mcpDefinitions: withTool ? [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] : [],
    });
    return { ...send, msgs, phase };
  });
}

/** A stream that answers immediately with text. */
function answers(text: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: text });
    return text;
  });
}

/** A stream that asks for the MCP lookup tool instead of answering. */
function requestsTool() {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }] });
    return "";
  });
}

/** A stream that only ends when its request is aborted. */
function hangsUntilAborted() {
  streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, _onDelta, signal) => new Promise<string>((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("chat completion notifications", () => {
  it("announces a completed answer once", async () => {
    answers("Answer");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Answer" });
    expect(notifyMock.mock.calls).toEqual([["chat"]]);
  });

  it("stays silent when the request fails", async () => {
    streamMock.mockRejectedValueOnce(new Error("HTTP 500"));
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toBe("HTTP 500");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stays silent when the user stops generation", async () => {
    hangsUntilAborted();
    const { result } = setup();
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { result.current.stop(); await sending; });
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stays silent when the chat unmounts mid-response", async () => {
    hangsUntilAborted();
    const { result, unmount } = setup();
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    unmount();
    await sending;
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("waits through an MCP tool request and announces only the final follow-up answer", async () => {
    requestsTool();
    const { result } = setup(true);
    await act(async () => { await result.current.send(); });
    expect(result.current.pendingToolCall).not.toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
    answers("Final answer");
    await act(async () => { await result.current.approvePendingTool(); });
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Final answer" });
    expect(notifyMock.mock.calls).toEqual([["chat"]]);
  });

  it("stays silent when an MCP tool is rejected", async () => {
    requestsTool();
    const { result } = setup(true);
    await act(async () => { await result.current.send(); });
    act(() => result.current.rejectPendingTool());
    expect(result.current.error).toBe("MCP tool call rejected by the user.");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("stays silent when an MCP tool call fails", async () => {
    requestsTool();
    const { result } = setup(true);
    await act(async () => { await result.current.send(); });
    vi.mocked(api.mcpCallTool).mockRejectedValueOnce(new Error("tool down"));
    await act(async () => { await result.current.approvePendingTool(); });
    expect(result.current.error).toBe("MCP tool call failed: tool down");
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
