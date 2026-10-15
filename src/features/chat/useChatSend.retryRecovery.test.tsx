import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { getChatPersonalization } from "../../shared/api/personalization";
import { createTestStore } from "../../testing/appStore";
import { loadChatWorkspace, saveChatWorkspace, type ChatHistoryMessage, type ChatThread } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { useChatSend } from "./useChatSend";

// The native call settles only when cancelled or failed, the way the backend
// answers a Stop that lands during the native approval prompt or the tool RPC.
const inFlight = new Map<string, (error: Error) => void>();

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  embedText: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn((_server: string, _tool: string, _args: unknown, callId: string) => new Promise((_resolve, reject) => {
    inFlight.set(callId, reject);
  })),
  mcpCancelToolCall: vi.fn(async (callId: string) => {
    inFlight.get(callId)?.(new Error("MCP tool call cancelled"));
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
const cancelMock = vi.mocked(api.mcpCancelToolCall);
const personalizationMock = vi.mocked(getChatPersonalization);

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6xkAAAAASUVORK5CYII=";
const lookupEntry = { serverId: "catalog", serverName: "Catalog", tool: { name: "lookup", input_schema: { type: "object" } } };
const lookupDefinition: api.ChatToolDefinition = { type: "function", function: { name: "catalog__lookup", parameters: { type: "object" } } };

interface Session { baseUrl: string; apiKey: string; tools: boolean }

function setup(options: { initial?: ChatHistoryMessage[]; input?: string; images?: ImageAttachment[]; documents?: DocumentAttachment[]; session?: Session } = {}) {
  const store = createTestStore();
  const thread: ChatThread = { id: "retry-thread", title: "Synthetic retry", systemPrompt: "Synthetic thread prompt", messages: [], createdAt: 1, updatedAt: 1 };
  return renderHook(({ session }: { session: Session }) => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>(options.initial ?? []);
    const [input, setInput] = useState(options.input ?? "Synthetic question");
    const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
    const [attachments, setAttachments] = useState<ImageAttachment[]>(options.images ?? []);
    const [documents, setDocuments] = useState<DocumentAttachment[]>(options.documents ?? []);
    const atBottomRef = useRef(true);
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null, sessionId: "retry-session",
      baseUrl: session.baseUrl, apiKey: session.apiKey, model: "model.gguf",
      activeThread: thread, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpEntryByFunctionName: session.tools ? new Map([["catalog__lookup", lookupEntry]]) : new Map(),
      mcpDefinitions: session.tools ? [lookupDefinition] : [],
    });
    return { ...send, msgs, phase, input, setInput, setMsgs };
  }, { initialProps: { session: options.session ?? { baseUrl: "http://127.0.0.1:8080", apiKey: "original-session-key", tools: true } } });
}

function streamsReasoningUntilStopped(reasoning: string) {
  streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, onDelta, signal) => new Promise((_resolve, reject) => {
    onDelta({ reasoning });
    signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
}

function requestsLookup(id = "call-1") {
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

/** What a restart or a conversation switch gives back: the saved conversation, without this session's memory. */
function reloaded(messages: ChatHistoryMessage[]): ChatHistoryMessage[] {
  const thread: ChatThread = { id: "saved", title: "Saved", systemPrompt: "", messages, createdAt: 1, updatedAt: 1 };
  saveChatWorkspace({ activeThreadId: thread.id, threads: [thread] });
  return loadChatWorkspace().threads[0].messages;
}

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockReset();
  localStorage.clear();
  inFlight.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("D09a: Retry for an interrupted reply survives a restart or conversation switch", () => {
  it("resends the exact prepared request saved with the interrupted reply, with the current session's key, and no duplicate turn", async () => {
    const document = { name: "notes.md", path: "synthetic/notes.md", text: "Synthetic document context" };
    vi.mocked(api.embedText).mockRejectedValue(new Error("no embedding session"));
    streamsReasoningUntilStopped("Synthetic reasoning");
    // This turn offered no MCP tools; one that did is covered by the D17 tests.
    const first = setup({ images: [{ name: "pixel.png", dataUrl: PIXEL }], documents: [document], session: { baseUrl: "http://127.0.0.1:8080", apiKey: "original-session-key", tools: false } });
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    const originalRequest = structuredClone(streamMock.mock.calls[0][3]);
    expect(first.result.current.msgs.at(-1)).toMatchObject({ role: "assistant", reasoning: "Synthetic reasoning", interrupted: true });

    // Restart: only what the conversation saved is left.
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    expect(JSON.stringify(restored)).not.toContain("original-session-key");
    const next = setup({ initial: restored, input: "", session: { baseUrl: "http://127.0.0.1:9090", apiKey: "current-session-key", tools: false } });
    expect(next.result.current.failedRef.current).toBeNull();
    expect(next.result.current.canRetry).toBe(true);
    expect(next.result.current.retryUnavailable).toBeNull();

    answers("Recovered answer");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledTimes(2);
    const [url, key, , history, sampling] = streamMock.mock.calls[1];
    expect(history).toEqual(originalRequest);
    expect(JSON.stringify(history)).toContain(PIXEL);
    expect(JSON.stringify(history)).toContain("Synthetic document context");
    // Auth belongs to the live session the retry runs on, never to the saved turn; a turn that offered no tools is resent without any.
    expect([url, key]).toEqual(["http://127.0.0.1:9090", "current-session-key"]);
    expect(sampling.tools).toEqual([]);
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Synthetic question"], ["assistant", "Recovered answer"]]);
    expect(next.result.current.msgs[0]).toEqual(restored[0]);
    expect(next.result.current.msgs.at(-1)?.retry).toBeUndefined();
    expect(next.result.current.canRetry).toBe(false);
  });

  it("adds no second user turn when the saved message text was shortened for storage", async () => {
    const longQuestion = `Synthetic long question ${"z".repeat(20 * 1024)}`;
    streamsReasoningUntilStopped("Partial");
    const first = setup({ input: longQuestion });
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    const originalRequest = structuredClone(streamMock.mock.calls[0][3]);
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    expect(restored[0].content.length).toBeLessThan(longQuestion.length);

    const next = setup({ initial: restored, input: "" });
    answers("Long answer");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", restored[0].content], ["assistant", "Long answer"]]);
  });

  it("never rereads local instructions for a saved turn, and explains why it cannot retry it exactly", async () => {
    personalizationMock.mockResolvedValueOnce({ instructions: [{ source: "aiolm", path: "synthetic/AGENTS.md", exists: true, content: "SYNTHETIC-RULE", revision: "r1" }], skills: [], warnings: [] });
    streamsReasoningUntilStopped("Partial");
    const first = setup();
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    // This session still holds the snapshot in memory.
    expect(first.result.current.canRetry).toBe(true);
    const restored = reloaded(first.result.current.msgs);
    expect(JSON.stringify(restored)).not.toContain("SYNTHETIC-RULE");
    first.unmount();

    const next = setup({ initial: restored, input: "" });
    expect(next.result.current.canRetry).toBe(false);
    expect(next.result.current.retryUnavailable).toBe("local-instructions");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(personalizationMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs).toEqual(restored);
  });

  it("offers no exact retry for an interrupted reply saved before snapshots existed", async () => {
    const legacy: ChatHistoryMessage[] = [
      { role: "user", content: "Legacy question" },
      { role: "assistant", content: "Legacy partial", interrupted: true, model: "model.gguf" },
    ];
    const { result } = setup({ initial: reloaded(legacy), input: "" });
    expect(result.current.canRetry).toBe(false);
    expect(result.current.retryUnavailable).toBe("not-saved");
    await act(async () => { await result.current.send(true); });
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.current.msgs).toEqual(legacy);
  });

  it("does not resend a saved interrupted turn after a newer message supersedes it", async () => {
    streamsReasoningUntilStopped("Partial");
    const first = setup();
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    const restored = reloaded(first.result.current.msgs);
    first.unmount();

    personalizationMock.mockRejectedValueOnce(new Error("synthetic preparation failure"));
    const next = setup({ initial: restored, input: "A newer question" });
    await act(async () => { await next.result.current.send(); });
    expect(next.result.current.error).toContain("synthetic preparation failure");
    expect(next.result.current.canRetry).toBe(false);
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs.map((message) => message.content)).toEqual(["Synthetic question", ""]);
  });

  it("saves only a bounded snapshot and explains when the original request was too large", async () => {
    streamsReasoningUntilStopped("Partial");
    const first = setup({ input: "x".repeat(1024 * 1024) });
    let sending!: Promise<void>;
    act(() => { sending = first.result.current.send(); });
    await waitFor(() => expect(streamMock).toHaveBeenCalledOnce());
    await act(async () => { first.result.current.stop(); await sending; });
    expect(first.result.current.canRetry).toBe(true);
    expect(JSON.stringify(first.result.current.msgs.at(-1)?.retry).length).toBeLessThan(100);
    first.unmount();

    const next = setup({ initial: reloaded(first.result.current.msgs), input: "" });
    expect(next.result.current.canRetry).toBe(false);
    expect(next.result.current.retryUnavailable).toBe("too-large");
  });
});

describe("D09b: Retry after cancelling an approved MCP tool call", () => {
  async function cancelDuringNativeApproval() {
    requestsLookup();
    const hook = setup();
    await act(async () => { await hook.result.current.send(); });
    expect(hook.result.current.pendingToolCall).not.toBeNull();
    // A pending approval is not a recoverable turn yet.
    expect(hook.result.current.msgs.at(-1)).toMatchObject({ finishReason: "tool_calls" });
    let approving!: Promise<void>;
    act(() => { approving = hook.result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
    const callId = callMock.mock.calls[0][3]!;
    await act(async () => { hook.result.current.stop(); await approving; });
    expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);
    return { ...hook, callId, originalRequest: structuredClone(streamMock.mock.calls[0][3]) };
  }

  it("offers Retry that regenerates the original request and requires a fresh approval for any new tool call", async () => {
    const { result, originalRequest, callId } = await cancelDuringNativeApproval();
    expect(result.current.phase).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.canRetry).toBe(true);
    expect(result.current.msgs.at(-1)).toMatchObject({ role: "assistant", finishReason: "tool_calls" });

    requestsLookup("call-2");
    await act(async () => { await result.current.send(true); });
    expect(streamMock).toHaveBeenCalledTimes(2);
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    // The cancelled call is never resumed: nothing runs until the new request is approved again.
    expect(callMock).toHaveBeenCalledOnce();
    expect(result.current.pendingToolCall?.call.id).toBe("call-2");
    expect(result.current.msgs.filter((message) => message.role === "user")).toHaveLength(1);
    expect(result.current.msgs).toHaveLength(2);

    let approving!: Promise<void>;
    act(() => { approving = result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledTimes(2));
    expect(callMock.mock.calls[1][3]).not.toBe(callId);
    await act(async () => { result.current.stop(); await approving; });
  });

  it("keeps the cancelled tool turn retryable after a restart without reviving the tool call", async () => {
    const { result, originalRequest, unmount } = await cancelDuringNativeApproval();
    const restored = reloaded(result.current.msgs);
    unmount();
    expect(JSON.stringify(restored)).not.toContain("original-session-key");

    const next = setup({ initial: restored, input: "", session: { baseUrl: "http://127.0.0.1:8080", apiKey: "current-session-key", tools: true } });
    expect(next.result.current.pendingToolCall).toBeNull();
    expect(next.result.current.canRetry).toBe(true);
    answers("Answer without the tool");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(streamMock.mock.calls[1][1]).toBe("current-session-key");
    expect(callMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Synthetic question"], ["assistant", "Answer without the tool"]]);
  });

  it("offers Retry after the native approval itself fails", async () => {
    requestsLookup();
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    let approving!: Promise<void>;
    act(() => { approving = result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
    await act(async () => {
      inFlight.get(callMock.mock.calls[0][3]!)?.(new Error("MCP tool approval timed out"));
      await approving;
    });
    expect(result.current.error).toContain("MCP tool approval timed out");
    expect(result.current.canRetry).toBe(true);
    const restored = reloaded(result.current.msgs);
    expect(restored.at(-1)).toMatchObject({ finishReason: "tool_calls" });
    expect(restored.at(-1)?.retry).toBeDefined();
  });
});

function waitsForStop() {
  streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, _onDelta, signal) => new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
  }));
}

async function stopFirstRequest(hook: ReturnType<typeof setup>, sendIt: () => Promise<void> = () => hook.result.current.send()) {
  let sending!: Promise<void>;
  const calls = streamMock.mock.calls.length;
  act(() => { sending = sendIt(); });
  await waitFor(() => expect(streamMock).toHaveBeenCalledTimes(calls + 1));
  await act(async () => { hook.result.current.stop(); await sending; });
}

describe("Recovery when an issued request produced no output", () => {
  it("keeps a reply stopped before its first token, with its exact request, and retries it after a restart without a duplicate turn", async () => {
    waitsForStop();
    const first = setup();
    await stopFirstRequest(first);
    const originalRequest = structuredClone(streamMock.mock.calls[0][3]);
    const reply = first.result.current.msgs.at(-1)!;
    expect(first.result.current.msgs).toHaveLength(2);
    expect(reply).toMatchObject({ role: "assistant", content: "", reasoning: "", interrupted: true });
    // Measured times only; the cancelled empty response reported no token counts.
    expect(reply.metrics?.tg.tokens).toBeUndefined();
    expect(reply.metrics?.pp.tokens).toBeUndefined();
    expect(first.result.current.canRetry).toBe(true);
    expect(first.result.current.error).toBeNull();

    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    // The tools the turn offered are selected again; without them nothing is resent (D17).
    const next = setup({ initial: restored, input: "", session: { baseUrl: "http://127.0.0.1:9090", apiKey: "current-session-key", tools: true } });
    expect(next.result.current.canRetry).toBe(true);
    answers("Answer after an empty stop");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(streamMock.mock.calls[1][1]).toBe("current-session-key");
    expect(streamMock.mock.calls[1][4].tools).toEqual([lookupDefinition]);
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Synthetic question"], ["assistant", "Answer after an empty stop"]]);
  });

  it("keeps a reply that failed before any output, reports the real error, and retries it once after a restart", async () => {
    streamMock.mockRejectedValueOnce(new Error("HTTP 503: synthetic engine unavailable"));
    const first = setup();
    await act(async () => { await first.result.current.send(); });
    expect(first.result.current.error).toBe("HTTP 503: synthetic engine unavailable");
    expect(first.result.current.msgs.at(-1)).toMatchObject({ role: "assistant", content: "", failed: true });
    expect(first.result.current.msgs.at(-1)?.interrupted).toBeFalsy();
    const originalRequest = structuredClone(streamMock.mock.calls[0][3]);

    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const next = setup({ initial: restored, input: "" });
    expect(next.result.current.canRetry).toBe(true);
    answers("Recovered after an error");
    await act(async () => { await next.result.current.send(true); });
    expect(streamMock.mock.calls[1][3]).toEqual(originalRequest);
    expect(next.result.current.msgs).toHaveLength(2);
    expect(next.result.current.msgs.at(-1)).toMatchObject({ content: "Recovered after an error" });
    expect(next.result.current.msgs.at(-1)?.failed).toBeUndefined();
  });

  it.each(["live", "restored"] as const)("leaves the earlier partial reply and its measurements unchanged when a %s Retry is stopped before a new token", async (source) => {
    streamMock.mockImplementationOnce((_url, _key, _model, _messages, _sampling, onDelta, signal) => new Promise((_resolve, reject) => {
      onDelta({ reasoning: "Earlier partial reasoning", content: "Earlier partial answer", usage: { prompt_tokens: 12, completion_tokens: 5 } });
      signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    }));
    const first = setup();
    await stopFirstRequest(first);
    const earlier = first.result.current.msgs.at(-1)!;
    expect(earlier).toMatchObject({ content: "Earlier partial answer", reasoning: "Earlier partial reasoning", interrupted: true });
    expect(earlier.metrics?.tg.tokens).toBe(5);
    let hook = first;
    let expected = first.result.current.msgs;
    if (source === "restored") {
      expected = reloaded(first.result.current.msgs);
      first.unmount();
      hook = setup({ initial: expected, input: "" });
    }

    waitsForStop();
    await stopFirstRequest(hook, () => hook.result.current.send(true));
    expect(hook.result.current.msgs).toEqual(expected);
    expect(hook.result.current.canRetry).toBe(true);

    streamMock.mockRejectedValueOnce(new Error("HTTP 500: synthetic retry failure"));
    await act(async () => { await hook.result.current.send(true); });
    expect(hook.result.current.error).toBe("HTTP 500: synthetic retry failure");
    expect(hook.result.current.msgs).toEqual(expected);
    expect(hook.result.current.canRetry).toBe(true);
  });

  it("keeps the draft and never issues or snapshots a request when a new message is stopped during preparation", async () => {
    let release!: () => void;
    personalizationMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ instructions: [], skills: [], warnings: [] });
    }));
    const earlier: ChatHistoryMessage[] = [{ role: "user", content: "Earlier" }, { role: "assistant", content: "Earlier answer", finishReason: "stop" }];
    const { result } = setup({ initial: earlier, input: "Draft that is still preparing" });
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(personalizationMock).toHaveBeenCalledOnce());
    await act(async () => { result.current.stop(); release(); await sending; });
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.current.msgs).toEqual(earlier);
    expect(result.current.input).toBe("Draft that is still preparing");
    expect(result.current.canRetry).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it("does not drop the saved recovery of an earlier reply when a newer message is stopped before it is issued", async () => {
    waitsForStop();
    const first = setup();
    await stopFirstRequest(first);
    const restored = reloaded(first.result.current.msgs);
    first.unmount();

    let release!: () => void;
    personalizationMock.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ instructions: [], skills: [], warnings: [] });
    }));
    const next = setup({ initial: restored, input: "A newer draft" });
    let sending!: Promise<void>;
    act(() => { sending = next.result.current.send(); });
    await waitFor(() => expect(personalizationMock).toHaveBeenCalledTimes(2));
    await act(async () => { next.result.current.stop(); release(); await sending; });
    // The newer draft supersedes the old turn in this session, but nothing was issued, so its saved recovery stays.
    expect(next.result.current.canRetry).toBe(false);
    expect(next.result.current.retryUnavailable).toBeNull();
    expect(next.result.current.msgs).toEqual(restored);
    next.unmount();
    const later = setup({ initial: reloaded(next.result.current.msgs), input: "" });
    expect(later.result.current.canRetry).toBe(true);
  });

  it("keeps the saved reply and its recovery when a restored Retry is stopped during preparation", async () => {
    waitsForStop();
    const first = setup();
    await stopFirstRequest(first);
    const restored = reloaded(first.result.current.msgs);
    first.unmount();
    const personalizationReads = personalizationMock.mock.calls.length;

    let wake: (() => void) | undefined;
    vi.mocked(api.serverActivity).mockImplementationOnce(() => new Promise<void>((resolve) => { wake = resolve; }));
    const next = setup({ initial: restored, input: "" });
    let sending!: Promise<void>;
    act(() => { sending = next.result.current.send(true); });
    await waitFor(() => expect(wake).toBeDefined());
    await act(async () => { next.result.current.stop(); wake!(); await sending; });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs).toEqual(restored);
    expect(next.result.current.canRetry).toBe(true);
    expect(personalizationMock).toHaveBeenCalledTimes(personalizationReads);
  });
});

describe("MCP rounds whose runtime reported no tool_calls finish reason", () => {
  function requestsLookupWithoutFinishReason() {
    streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
      onDelta({ tool_calls: [{ index: 0, id: "call-1", name: "catalog__lookup", arguments: "{\"key\":\"synthetic-key\"}" }] });
      return "";
    });
  }

  it.each(["cancelled", "failed"] as const)("marks a %s round recoverable from app state without inventing a finish reason or resuming the call", async (ending) => {
    requestsLookupWithoutFinishReason();
    const { result, unmount } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.pendingToolCall?.call.id).toBe("call-1");
    let approving!: Promise<void>;
    act(() => { approving = result.current.approvePendingTool(); });
    await waitFor(() => expect(callMock).toHaveBeenCalledOnce());
    const callId = callMock.mock.calls[0][3]!;
    await act(async () => {
      if (ending === "cancelled") result.current.stop();
      else inFlight.get(callId)?.(new Error("MCP tool approval timed out"));
      await approving;
    });
    const reply = result.current.msgs.at(-1)!;
    expect(reply.finishReason).toBeUndefined();
    expect(reply.toolRound).toBe(ending);
    expect(result.current.canRetry).toBe(true);
    if (ending === "failed") expect(result.current.error).toContain("MCP tool approval timed out");
    else expect(cancelMock).toHaveBeenCalledExactlyOnceWith(callId);

    const restored = reloaded(result.current.msgs);
    unmount();
    expect(restored.at(-1)).toMatchObject({ toolRound: ending });
    const next = setup({ initial: restored, input: "" });
    expect(next.result.current.canRetry).toBe(true);
    answers("Answer without resuming the tool");
    await act(async () => { await next.result.current.send(true); });
    expect(callMock).toHaveBeenCalledOnce();
    expect(next.result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Synthetic question"], ["assistant", "Answer without resuming the tool"]]);
    expect(next.result.current.msgs.at(-1)?.toolRound).toBeUndefined();
  });
});
