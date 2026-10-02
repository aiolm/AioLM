import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { createTestStore } from "../../testing/appStore";
import type { ChatHistoryMessage } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { useChatSend } from "./useChatSend";

// The native call only settles when it is cancelled, the way the backend
// answers a Stop that lands during the approval prompt or the tool RPC.
const inFlight = new Map<string, (error: Error) => void>();

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn((_server: string, _tool: string, _args: unknown, callId: string) => new Promise((_resolve, reject) => {
    inFlight.set(callId, reject);
  })),
  mcpCancelToolCall: vi.fn(async (callId: string) => {
    inFlight.get(callId)?.(new Error("MCP tool call cancelled"));
    inFlight.delete(callId);
  }),
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const streamMock = vi.mocked(api.chatStream);
const callMock = vi.mocked(api.mcpCallTool);
const cancelMock = vi.mocked(api.mcpCancelToolCall);

function setup() {
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
      sessionId: "mcp-cancel-session", baseUrl: "http://127.0.0.1:8080", apiKey: "test-key", model: "model.gguf",
      activeThread: undefined, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpEntryByFunctionName: new Map([["lookup", { serverId: "catalog", serverName: "Catalog", tool: { name: "lookup", input_schema: { type: "object" } } }]]),
      mcpDefinitions: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    });
    return { ...send, msgs, phase };
  });
}

async function startToolCall() {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }] });
    return "";
  });
  const hook = setup();
  await act(async () => { await hook.result.current.send(); });
  let approving!: Promise<void>;
  act(() => { approving = hook.result.current.approvePendingTool(); });
  await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
  const callId = callMock.mock.calls[0][3];
  expect(callId).toEqual(expect.any(String));
  return { ...hook, approving, callId: callId! };
}

beforeEach(() => {
  vi.clearAllMocks();
  inFlight.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("MCP tool call cancellation", () => {
  it("Stop cancels the native call it started and does not continue the turn", async () => {
    const { result, approving, callId } = await startToolCall();
    await act(async () => { result.current.stop(); await approving; });
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    // The cancelled tool never feeds a follow-up model request.
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("leaving the chat cancels the native call", async () => {
    const { unmount, approving, callId } = await startToolCall();
    unmount();
    await approving;
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
  });

  it("gives every call its own id and leaves a finished call alone", async () => {
    callMock.mockResolvedValueOnce({ content: "Tool result" });
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }] });
      return "";
    });
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ content: "Answer" });
      return "Answer";
    });
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    await act(async () => { await result.current.approvePendingTool(); });
    act(() => result.current.stop());
    expect(cancelMock).not.toHaveBeenCalled();
    expect(callMock.mock.calls[0][3]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
