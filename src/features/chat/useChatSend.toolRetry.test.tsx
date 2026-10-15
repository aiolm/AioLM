import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { getChatPersonalization } from "../../shared/api/personalization";
import { createTestStore } from "../../testing/appStore";
import { loadChatWorkspace, saveChatWorkspace, type ChatHistoryMessage, type ChatThread } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { mcpToolDefinition, type ChatMcpTool } from "./useChatMcpTools";
import { useChatSend } from "./useChatSend";

// The native call settles only when answered, cancelled or failed, the way the
// backend answers a Stop that lands during the native approval or the tool RPC.
const inFlight = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  embedText: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn((_server: string, _tool: string, _args: unknown, callId: string) => new Promise((resolve, reject) => {
    inFlight.set(callId, { resolve, reject });
  })),
  mcpCancelToolCall: vi.fn(async (callId: string) => {
    inFlight.get(callId)?.reject(new Error("MCP tool call cancelled"));
    inFlight.delete(callId);
  }),
}));
vi.mock("../../shared/api/personalization", () => ({
  getChatPersonalization: vi.fn(async () => ({ instructions: [], skills: [], warnings: [] })),
  readSkill: vi.fn(),
  PERSONALIZATION_CHANGED_EVENT: "aiolm-personalization-changed",
}));
vi.mock("./documentIndex", () => ({ loadDocumentVectors: vi.fn(async () => null), saveDocumentVectors: vi.fn(async () => undefined) }));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const streamMock = vi.mocked(api.chatStream);
const callMock = vi.mocked(api.mcpCallTool);
const personalizationMock = vi.mocked(getChatPersonalization);

const lookup: ChatMcpTool = { serverId: "catalog", serverName: "Synthetic catalog", tool: { name: "lookup", description: "Synthetic lookup", input_schema: { type: "object", properties: { key: { type: "string" } } } } };
const extra: ChatMcpTool = { serverId: "catalog", serverName: "Synthetic catalog", tool: { name: "unrelated", input_schema: { type: "object" } } };
const lookupDefinition = mcpToolDefinition(lookup, "catalog__lookup");

/** The MCP tools selected in the live session. */
type Tools = "none" | "lookup" | "lookup-and-extra" | "changed";

function selection(tools: Tools): { entries: Map<string, ChatMcpTool>; definitions: api.ChatToolDefinition[] } {
  const chosen = tools === "none" ? [] : tools === "lookup" ? [lookup] : tools === "changed"
    ? [{ ...lookup, tool: { ...lookup.tool, description: "Synthetic lookup, new wording" } }] : [lookup, extra];
  const names = chosen.map((entry) => `${entry.serverId}__${entry.tool.name}`);
  return { entries: new Map(chosen.map((entry, index) => [names[index], entry])), definitions: chosen.map((entry, index) => mcpToolDefinition(entry, names[index])) };
}

function setup(options: { initial?: ChatHistoryMessage[]; tools?: Tools } = {}) {
  const store = createTestStore();
  const thread: ChatThread = { id: "tool-retry-thread", title: "Synthetic tool retry", systemPrompt: "Synthetic thread prompt", messages: [], createdAt: 1, updatedAt: 1 };
  return renderHook(({ tools }: { tools: Tools }) => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>(options.initial ?? []);
    const [input, setInput] = useState(options.initial ? "" : "Synthetic question for the lookup tool");
    const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
    const atBottomRef = useRef(true);
    const { entries, definitions } = selection(tools);
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null, sessionId: "tool-retry-session",
      baseUrl: "http://127.0.0.1:8080", apiKey: "live-session-key", model: "model.gguf",
      activeThread: thread, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpEntryByFunctionName: entries, mcpDefinitions: definitions,
    });
    return { ...send, msgs, phase };
  }, { initialProps: { tools: options.tools ?? "lookup" } });
}

function requestsLookup(id: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ tool_calls: [{ index: 0, id, name: "catalog__lookup", arguments: "{\"key\":\"synthetic-key\"}" }], finish_reason: "tool_calls" });
    return "";
  });
}

function answers(text: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: text });
    return text;
  });
}

/** What a restart gives back: the saved conversation, without this session's memory. */
function reloaded(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const thread: ChatThread = { id: "saved", title: "Saved", systemPrompt: "", messages, createdAt: 1, updatedAt: 1 };
  saveChatWorkspace({ activeThreadId: thread.id, threads: [thread] });
  return loadChatWorkspace().threads[0].messages;
}

/** Sends with only the lookup tool selected, approves its call, and stops it while it runs. */
async function cancelledToolTurn() {
  requestsLookup("call-1");
  const hook = setup();
  await act(async () => { await hook.result.current.send(); });
  let approving!: Promise<void>;
  act(() => { approving = hook.result.current.approvePendingTool(); });
  await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
  await act(async () => { hook.result.current.stop(); await approving; });
  expect(hook.result.current.msgs.at(-1)).toMatchObject({ role: "assistant", finishReason: "tool_calls", toolRound: "cancelled" });
  return { ...hook, originalRequest: structuredClone(streamMock.mock.calls[0][3]) };
}

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockReset();
  localStorage.clear();
  inFlight.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("D17: Retry of a saved MCP tool turn needs the tools it was offered", () => {
  it("saves which tools the turn offered, and sends no request without them after a restart, consuming nothing", async () => {
    const first = await cancelledToolTurn();
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    expect(restored.at(-1)?.retry).toMatchObject({ tools: [{ serverId: "catalog", serverName: "Synthetic catalog", toolName: "lookup", definition: lookupDefinition }] });
    expect(JSON.stringify(restored)).not.toContain("live-session-key");

    // After a restart nothing is loaded until the user asks for MCP tools.
    const next = setup({ initial: restored, tools: "none" });
    expect(next.result.current.canRetry).toBe(false);
    expect(next.result.current.retryUnavailable).toBeNull();
    expect(next.result.current.retryToolsMissing).toEqual([expect.objectContaining({ serverId: "catalog", toolName: "lookup" })]);
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs).toEqual(restored);
    expect(next.result.current.failedRef.current).toBeNull();
    expect(next.result.current.error).toBeNull();

    // A changed tool is not the one the turn used.
    next.rerender({ tools: "changed" });
    expect(next.result.current.canRetry).toBe(false);
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs).toEqual(restored);
  });

  it("once the same tool is selected again, resends the exact request offering only that tool, and runs nothing until a fresh approval", async () => {
    const first = await cancelledToolTurn();
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const next = setup({ initial: restored, tools: "none" });
    next.rerender({ tools: "lookup-and-extra" });
    expect(next.result.current.canRetry).toBe(true);
    expect(next.result.current.retryToolsMissing).toBeNull();

    requestsLookup("call-2");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledTimes(2);
    const [, key, , history, sampling] = streamMock.mock.calls[1];
    expect(history).toEqual(first.originalRequest);
    expect(key).toBe("live-session-key");
    expect(sampling.tools).toEqual([lookupDefinition]);
    expect(next.result.current.pendingToolCall).toMatchObject({ serverId: "catalog", toolName: "lookup", call: { id: "call-2" } });
    expect(callMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs.filter((message) => message.role === "user")).toHaveLength(1);

    // Rejecting the new request runs nothing.
    act(() => next.result.current.rejectPendingTool());
    expect(callMock).toHaveBeenCalledOnce();
    expect(streamMock).toHaveBeenCalledTimes(2);
  });

  it("feeds an approved call's result into the follow-up of the retried turn", async () => {
    const first = await cancelledToolTurn();
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const next = setup({ initial: restored, tools: "lookup" });
    requestsLookup("call-2");
    await act(async () => { await next.result.current.send(true); });
    answers("Synthetic answer from the tool");
    let approving!: Promise<void>;
    act(() => { approving = next.result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
    expect(callMock.mock.calls[1].slice(0, 3)).toEqual(["catalog", "lookup", { key: "synthetic-key" }]);
    await act(async () => { inFlight.get(callMock.mock.calls[1][3]!)?.resolve({ content: [{ type: "text", text: "synthetic-key: amber" }] }); await approving; });
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(streamMock.mock.calls[2][3].slice(-2)).toEqual([
      { role: "assistant", content: "", tool_calls: [expect.objectContaining({ id: "call-2" })] },
      { role: "tool", tool_call_id: "call-2", name: "catalog__lookup", content: "{\"text\":\"synthetic-key: amber\"}" },
    ]);
    expect(streamMock.mock.calls[2][4].tools).toEqual([lookupDefinition]);
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Synthetic question for the lookup tool"], ["assistant", "Synthetic answer from the tool"]]);
    expect(next.result.current.msgs.at(-1)?.retry).toBeUndefined();
  });

  it("cancels a retried turn's call when stopped during approval, and keeps it retryable with the same tools", async () => {
    const first = await cancelledToolTurn();
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const next = setup({ initial: restored, tools: "lookup" });
    requestsLookup("call-2");
    await act(async () => { await next.result.current.send(true); });
    let approving!: Promise<void>;
    act(() => { approving = next.result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
    await act(async () => { next.result.current.stop(); await approving; });
    expect(vi.mocked(api.mcpCancelToolCall)).toHaveBeenLastCalledWith(callMock.mock.calls[1][3]);
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(next.result.current.msgs.at(-1)).toMatchObject({ toolRound: "cancelled", retry: { tools: [expect.objectContaining({ toolName: "lookup" })] } });
    expect(next.result.current.canRetry).toBe(true);
  });

  it("does not let a live Retry drop a tool deselected after the call was stopped", async () => {
    const { result, rerender, originalRequest } = await cancelledToolTurn();
    rerender({ tools: "none" });
    expect(result.current.canRetry).toBe(false);
    await act(async () => { await result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(result.current.failedRef.current).not.toBeNull();

    rerender({ tools: "lookup" });
    expect(result.current.canRetry).toBe(true);
    answers("Answer with the tool offered again");
    await act(async () => { await result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(streamMock.mock.calls[1][4].tools).toEqual([lookupDefinition]);
  });

  it("retries a failed tool follow-up, whose request carries the tool result, only with the same tools", async () => {
    requestsLookup("call-1");
    const first = setup();
    await act(async () => { await first.result.current.send(); });
    streamMock.mockRejectedValueOnce(new Error("HTTP 500: synthetic follow-up failure"));
    let approving!: Promise<void>;
    act(() => { approving = first.result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
    await act(async () => { inFlight.get(callMock.mock.calls[0][3]!)?.resolve({ content: "synthetic result" }); await approving; });
    expect(first.result.current.error).toBe("HTTP 500: synthetic follow-up failure");
    const followupRequest = structuredClone(streamMock.mock.calls[1][3]);
    expect(followupRequest.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call-1" });
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    expect(restored.at(-1)).toMatchObject({ role: "assistant", failed: true });

    const next = setup({ initial: restored, tools: "none" });
    expect(next.result.current.canRetry).toBe(false);
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(next.result.current.msgs).toEqual(restored);

    next.rerender({ tools: "lookup" });
    answers("Recovered follow-up");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[2][3]).toEqual(followupRequest);
    expect(streamMock.mock.calls[2][4].tools).toEqual([lookupDefinition]);
    expect(callMock).toHaveBeenCalledOnce();
  });

  it.each([
    ["before the first token", undefined],
    ["during ordinary reasoning", "Synthetic planning before any tool call"],
  ] as const)("protects a turn that offered a tool when stopped %s, after a restart and live", async (_point, reasoning) => {
    streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, onDelta, signal) => new Promise((_resolve, reject) => {
      if (reasoning) onDelta({ reasoning });
      signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const first = setup();
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    const originalRequest = structuredClone(streamMock.mock.calls[0][3]);
    const reply = first.result.current.msgs.at(-1)!;
    expect(reply).toMatchObject({ role: "assistant", interrupted: true, reasoning: reasoning ?? "" });
    expect(reply.finishReason).toBeUndefined();
    expect(reply.toolRound).toBeUndefined();
    expect(reply.retry).toMatchObject({ tools: [expect.objectContaining({ serverId: "catalog", toolName: "lookup" })] });

    // Live: the tool deselected after the stop blocks Retry without touching the turn.
    first.rerender({ tools: "none" });
    expect(first.result.current.canRetry).toBe(false);
    await act(async () => { await first.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(first.result.current.failedRef.current).not.toBeNull();
    expect(first.result.current.msgs.at(-1)).toBe(reply);

    // After a restart nothing is loaded: no request, and the reply, its snapshot and metrics stay.
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const next = setup({ initial: restored, tools: "none" });
    expect(next.result.current.retryToolsMissing).toEqual([expect.objectContaining({ serverId: "catalog", toolName: "lookup" })]);
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs).toEqual(restored);
    expect(next.result.current.msgs.at(-1)?.metrics).toEqual(restored.at(-1)?.metrics);

    // With the same tool selected again the exact request is resent, offering only it; its call waits for approval.
    next.rerender({ tools: "lookup-and-extra" });
    requestsLookup("call-after-restore");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(streamMock.mock.calls[1][4].tools).toEqual([lookupDefinition]);
    expect(next.result.current.pendingToolCall).toMatchObject({ serverId: "catalog", toolName: "lookup" });
    expect(callMock).not.toHaveBeenCalled();
  });

  it("keeps the earlier Retry for a turn that offered no tools", async () => {
    streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, _onDelta, signal) => new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const first = setup({ tools: "none" });
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    expect(restored.at(-1)?.retry).toMatchObject({ tools: [] });
    // A newly selected tool must not broaden this originally plain request.
    const next = setup({ initial: restored, tools: "lookup-and-extra" });
    expect(next.result.current.canRetry).toBe(true);
    answers("Plain answer");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][4].tools).toEqual([]);
  });

  it("still saves no snapshot, and so no tool definitions, for a tool turn that used local instructions", async () => {
    personalizationMock.mockResolvedValueOnce({ instructions: [{ source: "aiolm", path: "synthetic/AGENTS.md", exists: true, content: "SYNTHETIC-RULE", revision: "r1" }], skills: [], warnings: [] });
    const { result, unmount } = await cancelledToolTurn();
    const restored = reloaded(result.current.msgs);
    unmount();
    expect(restored.at(-1)?.retry).toEqual({ version: 1, unavailable: "local-instructions" });
    expect(JSON.stringify(restored)).not.toContain("Synthetic lookup");
    const next = setup({ initial: restored, tools: "lookup" });
    expect(next.result.current.retryUnavailable).toBe("local-instructions");
    expect(next.result.current.retryToolsMissing).toBeNull();
  });
});
