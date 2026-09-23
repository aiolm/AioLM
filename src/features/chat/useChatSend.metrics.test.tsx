import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { defaultPreferences } from "../../shared/config/preferences";
import { sessionHasActivity } from "../../shared/state/sessionActivity";
import { createTestStore } from "../../testing/appStore";
import type { ChatHistoryMessage } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { useChatSend } from "./useChatSend";

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn(async () => ({ content: "Tool result" })),
}));

type Options = Parameters<typeof useChatSend>[0];
let now = 1000;
let renderFrame: FrameRequestCallback | undefined;

function setup(overrides: Partial<Options> = {}) {
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
      sessionId: "metrics-session", baseUrl: "http://127.0.0.1:8080", apiKey: "test-key", model: "model.gguf",
      activeThread: undefined, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpDefinitions: [], mcpEntryByFunctionName: new Map(), ...overrides,
    });
    return { ...send, msgs, phase, store };
  });
}

function controlledStream() {
  let emit!: (delta: api.ChatDelta) => void;
  let finish!: (text: string) => void;
  let fail!: (error: Error) => void;
  vi.mocked(api.chatStream).mockImplementationOnce((_url, _key, _model, _messages, _sampling, onDelta, signal) => {
    emit = onDelta;
    return new Promise<string>((resolve, reject) => {
      finish = resolve;
      fail = reject;
      signal?.addEventListener("abort", () => reject(new DOMException("Stopped", "AbortError")), { once: true });
    });
  });
  return {
    emit: (delta: api.ChatDelta) => act(() => {
      emit(delta);
      const frame = renderFrame;
      renderFrame = undefined;
      frame?.(now);
    }),
    finish: async (text: string) => act(async () => finish(text)),
    fail: async (error: Error) => act(async () => fail(error)),
  };
}

describe("request-scoped response metrics", () => {
  it("retains the request model when the selected model changes during generation", async () => {
    const stream = controlledStream();
    const options = { model: "Qwen-example.gguf" };
    const { result, rerender } = setup(options);
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    expect(result.current.msgs.at(-1)?.model).toBe("Qwen-example.gguf");
    options.model = "gemma-example.gguf";
    rerender();
    stream.emit({ content: "Answer" });
    await stream.finish("Answer");
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Answer", model: "Qwen-example.gguf" });
  });

  beforeEach(() => {
    vi.clearAllMocks();
    now = 1000;
    renderFrame = undefined;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { renderFrame = callback; return 1; });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => { renderFrame = undefined; });
    vi.mocked(api.serverActivity).mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it("separates preparation and TTFT from server PP/TG durations and updates only the draft", async () => {
    vi.mocked(api.serverActivity).mockImplementationOnce(async () => { now = 5000; });
    const stream = controlledStream();
    const { result } = setup();
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    const messages = result.current.msgs;
    stream.emit({ usage: { prompt_tokens: 110, prompt_tokens_details: { cached_tokens: 10 } } });
    expect(result.current.streamingDraft?.metrics?.firstTokenMs).toBeUndefined();
    now = 5200;
    stream.emit({ reasoning: "Thinking", timings: { prompt_n: 100, prompt_ms: 100, prompt_per_second: 999 } });
    now = 5600;
    stream.emit({ content: "Answer", timings: { predicted_n: 20, predicted_ms: 400 } });
    expect(result.current.msgs).toBe(messages);
    expect(result.current.streamingDraft?.metrics).toMatchObject({
      pp: { tokens: 100, durationMs: 100, tokensPerSecond: 999 },
      tg: { tokens: 20, durationMs: 400, tokensPerSecond: 50 },
      preparationMs: 4000, firstTokenMs: 200, requestMs: 600, cachedTokens: 10,
    });
    now = 6200;
    stream.emit({ timings: { predicted_n: 50, predicted_ms: 1000 } });
    await stream.finish("Answer");
    expect(result.current.msgs.at(-1)).toMatchObject({
      content: "Answer", reasoning: "Thinking",
      metrics: { tg: { tokens: 50, durationMs: 1000, tokensPerSecond: 50 }, firstTokenMs: 200, requestMs: 1200 },
    });
    expect(result.current.streamingDraft).toBeNull();
    expect(sessionHasActivity("metrics-session")).toBe(false);
  });

  it("keeps text buffered when streaming is disabled while accepting statistics", async () => {
    const preferences = defaultPreferences();
    preferences.chat.streamResponses = false;
    const stream = controlledStream();
    const { result } = setup({ preferences });
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    now = 1200;
    stream.emit({ content: "Buffered answer", usage: { completion_tokens: 4 } });
    expect(result.current.streamingDraft).toMatchObject({ content: "", reasoning: "", metrics: { tg: { tokens: 4 } } });
    await stream.finish("Buffered answer");
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Buffered answer", metrics: { tg: { tokens: 4 } } });
  });

  it.each(["abort", "error"] as const)("saves partial %s metrics and starts a retry without stale statistics", async (ending) => {
    const stream = controlledStream();
    const { result } = setup();
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    now = 1200;
    stream.emit({ content: "Partial", timings: { prompt_n: 30, predicted_n: 5, predicted_ms: 100 } });
    now = 1500;
    if (ending === "abort") await act(async () => result.current.stop());
    else await stream.fail(new Error("Connection lost"));
    expect(result.current.msgs.at(-1)).toMatchObject({
      content: "Partial", interrupted: ending === "abort", failed: ending === "error",
      metrics: { pp: { tokens: 30 }, tg: { tokens: 5 }, requestMs: 500 },
    });
    const retry = controlledStream();
    now = 3000;
    act(() => { void result.current.send(true); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledTimes(2));
    now = 3100;
    retry.emit({ content: "Fresh answer" });
    await retry.finish("Fresh answer");
    expect(result.current.msgs).toHaveLength(2);
    expect(result.current.msgs.at(-1)).toMatchObject({
      content: "Fresh answer", metrics: { pp: {}, tg: {}, firstTokenMs: 100, requestMs: 100 },
    });
    expect(result.current.msgs.at(-1)?.failed).toBeUndefined();
  });

  it("removes an empty cancelled response even if statistics have arrived", async () => {
    const stream = controlledStream();
    const { result } = setup();
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    stream.emit({ timings: { prompt_n: 100, prompt_ms: 300 } });
    await act(async () => result.current.stop());
    expect(result.current.msgs).toEqual([expect.objectContaining({ role: "user" })]);
    expect(result.current.streamingDraft).toBeNull();
    expect(result.current.failedRef.current).toBeNull();
  });

  it("cancels during preparation without starting metrics or releasing the session lock early", async () => {
    let wake!: () => void;
    vi.mocked(api.serverActivity).mockImplementationOnce(() => new Promise<void>((resolve) => { wake = resolve; }));
    const { result } = setup();
    act(() => { void result.current.send(); });
    expect(sessionHasActivity("metrics-session")).toBe(true);
    expect(result.current.streamingDraft).toBeNull();
    act(() => result.current.stop());
    await act(async () => wake());
    expect(api.chatStream).not.toHaveBeenCalled();
    expect(result.current.msgs).toEqual([]);
    expect(sessionHasActivity("metrics-session")).toBe(false);
  });

  it("replaces tool-request metrics on follow-up while retaining the original session and settings", async () => {
    const store = createTestStore({ temperature: 0.3 });
    const stream = controlledStream();
    const { result, rerender } = setup({
      store, effectiveConfig: store.cfg,
      mcpEntryByFunctionName: new Map([["lookup", {
        serverId: "catalog", serverName: "Catalog", tool: { name: "lookup", input_schema: { type: "object" } },
      }]]),
      mcpDefinitions: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }],
    });
    act(() => { void result.current.send(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledOnce());
    now = 1100;
    stream.emit({ tool_calls: [{ index: 0, id: "call-1", name: "lookup", arguments: "{}" }], timings: { predicted_n: 10, predicted_ms: 100 } });
    await stream.finish("");
    expect(result.current.pendingToolCall).not.toBeNull();
    expect(result.current.msgs.at(-1)?.metrics).toMatchObject({ tg: { tokens: 10 }, firstTokenMs: 100 });
    expect(sessionHasActivity("metrics-session")).toBe(true);
    store.cfg!.temperature = 0.9;
    rerender();
    now = 5000;
    const followup = controlledStream();
    act(() => { void result.current.approvePendingTool(); });
    await waitFor(() => expect(api.chatStream).toHaveBeenCalledTimes(2));
    expect(api.chatStream).toHaveBeenLastCalledWith(
      "http://127.0.0.1:8080", "test-key", "model.gguf", expect.any(Array),
      expect.objectContaining({ temperature: 0.3 }), expect.any(Function), expect.any(AbortSignal),
    );
    now = 5200;
    followup.emit({ content: "Final answer", timings: { predicted_n: 2, predicted_ms: 200 } });
    await followup.finish("Final answer");
    expect(result.current.msgs).toHaveLength(2);
    expect(result.current.msgs.at(-1)?.metrics).toMatchObject({
      pp: {}, tg: { tokens: 2, durationMs: 200, tokensPerSecond: 10 }, preparationMs: 0, firstTokenMs: 200, requestMs: 200,
    });
    expect(vi.mocked(api.serverActivity).mock.calls).toEqual([["start", "metrics-session"], ["end", "metrics-session"]]);
    expect(store.updateConfig).not.toHaveBeenCalled();
    expect(sessionHasActivity("metrics-session")).toBe(false);
  });
});
