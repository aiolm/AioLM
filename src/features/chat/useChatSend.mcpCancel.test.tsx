import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { IpcError } from "../../shared/api/ipcError";
import { createTestStore } from "../../testing/appStore";
import { defined } from "../../testing/assertDefined";
import { CHAT_WORKSPACE_CLEAR_EVENT } from "./chatHistory";
import type { ChatHistoryMessage } from "../../shared/api/conversationTypes";
import type { DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes";
import { useChatSend } from "./useChatSend";
import type { ChatPhase } from "./chatSendTypes";

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
    inFlight.get(callId)?.(new IpcError("cancelled", "MCP tool call cancelled"));
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
    const [phase, setPhase] = useState<ChatPhase>("idle");
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
  const callId = defined(defined(callMock.mock.calls[0])[3]);
  expect(callId).toEqual(expect.any(String));
  return { ...hook, approving, callId };
}

beforeEach(() => {
  vi.clearAllMocks();
  inFlight.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("MCP tool call cancellation", () => {
  it("sends the approved native observation under its tool-call ID without nesting a simple text block", async () => {
    const observation = { content: [{ type: "text", text: "River-482: 31" }] };
    callMock.mockResolvedValueOnce(observation);
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }] });
      return "";
    });
    streamMock.mockResolvedValueOnce("Read the observation");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(callMock).not.toHaveBeenCalled();
    await act(async () => { await result.current.approvePendingTool(); });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(defined(streamMock.mock.calls[1])[3].at(-1)).toEqual({
      role: "tool", tool_call_id: "call-1", name: "lookup", content: '{"text":"River-482: 31"}',
    });
    expect(observation).toEqual({ content: [{ type: "text", text: "River-482: 31" }] });
    expect(cancelMock).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("Stop cancels the native call it started and does not continue the turn", async () => {
    const { result, approving, callId } = await startToolCall();
    expect(result.current.toolCallInProgress).toBe(true);
    expect(result.current.phase).toBe("preparing");
    await act(async () => { result.current.stop(); await approving; });
    expect(result.current.toolCallInProgress).toBe(false);
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    // The cancelled tool never feeds a follow-up model request.
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("handles native cancellation without a frontend Stop regardless of wording", async () => {
    const { result, approving, callId } = await startToolCall();
    await act(async () => {
      inFlight.get(callId)?.(new IpcError("cancelled", "Synthetic operation superseded"));
      await approving;
    });
    expect(result.current.toolCallInProgress).toBe(false);
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.msgs.at(-1)).toMatchObject({ toolRound: "cancelled" });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it("preserves native denial diagnostics with the existing failure copy", async () => {
    const { result, approving, callId } = await startToolCall();
    await act(async () => {
      inFlight.get(callId)?.(new IpcError("denied", "Synthetic launch approval withheld"));
      await approving;
    });
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBe("MCP tool call failed: Synthetic launch approval withheld");
    expect(result.current.msgs.at(-1)).toMatchObject({ toolRound: "failed" });
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("leaving the chat cancels the native call", async () => {
    const { unmount, approving, callId } = await startToolCall();
    unmount();
    await approving;
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
  });

  it("clears the tool wait after native approval failure without requesting a follow-up", async () => {
    const { result, approving, callId } = await startToolCall();
    await act(async () => {
      inFlight.get(callId)?.(new IpcError("timeout", "MCP tool approval timed out"));
      await approving;
    });
    expect(result.current.toolCallInProgress).toBe(false);
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toContain("MCP tool approval timed out");
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("workspace clearing immediately removes the tool wait and ignores its cancelled completion", async () => {
    const { result, approving, callId } = await startToolCall();
    act(() => { window.dispatchEvent(new CustomEvent(CHAT_WORKSPACE_CLEAR_EVENT, { detail: { state: "clearing" } })); });
    expect(result.current.toolCallInProgress).toBe(false);
    expect(result.current.phase).toBe("idle");
    await act(async () => { await approving; });
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
    expect(result.current.error).toBeNull();
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("gives every call its own id and leaves a finished call alone", async () => {
    let finishFollowup!: () => void;
    const followup = new Promise<void>(resolve => { finishFollowup = resolve; });
    callMock.mockResolvedValueOnce({ content: "Tool result" });
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }] });
      return "";
    });
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ content: "Answer" });
      await followup;
      return "Answer";
    });
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    let approving!: Promise<void>;
    act(() => { approving = result.current.approvePendingTool(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(2));
    expect(result.current.toolCallInProgress).toBe(false);
    await act(async () => { finishFollowup(); await approving; });
    act(() => result.current.stop());
    expect(cancelMock).not.toHaveBeenCalled();
    expect(defined(callMock.mock.calls[0])[3]).toMatch(/^[0-9a-f-]{36}$/);
  });
});
