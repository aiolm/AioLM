import { useRef, useState } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { getChatPersonalization, readSkill, type ChatPersonalization, type ChatSkill } from "../../shared/api/personalization";
import { notifyCompletion } from "../../shared/lib/notifications";
import { createTestStore } from "../../testing/appStore";
import type { ChatHistoryMessage, ChatThread } from "./chatHistory";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import { useChatSend } from "./useChatSend";

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(),
  serverActivity: vi.fn(async () => undefined),
  mcpCallTool: vi.fn(async () => ({ content: "Tool result" })),
}));
vi.mock("../../shared/api/personalization", () => ({
  getChatPersonalization: vi.fn(),
  readSkill: vi.fn(),
  PERSONALIZATION_CHANGED_EVENT: "aiolm-personalization-changed",
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const streamMock = vi.mocked(api.chatStream);
const loadMock = vi.mocked(getChatPersonalization);
const readMock = vi.mocked(readSkill);
const notifyMock = vi.mocked(notifyCompletion);

const pdf: ChatSkill = { id: "aiolm:pdf", name: "pdf", description: "Work with PDF files", source: "aiolm", path: "synthetic/aiolm/skills/pdf" };
const review: ChatSkill = { id: "agents:review", name: "review", description: "Review code", source: "agents", path: "synthetic/agents/skills/review" };

function context(overrides: Partial<ChatPersonalization> = {}): ChatPersonalization {
  return {
    // Deliberately AioLM first: the chat must still put the general file first.
    instructions: [
      { source: "aiolm", path: "synthetic/aiolm/AGENTS.md", exists: true, content: "AIOLM-RULE", revision: "r2" },
      { source: "agents", path: "synthetic/agents/AGENTS.md", exists: true, content: "AGENTS-RULE", revision: "r1" },
    ],
    skills: [pdf, review],
    warnings: [],
    ...overrides,
  };
}

const thread: ChatThread = { id: "t1", title: "Project chat", systemPrompt: "PROJECT-PROMPT", messages: [], createdAt: 1, updatedAt: 1 } as unknown as ChatThread;

function setup(options: { input?: string; selected?: string[]; ctxSize?: number; withMcp?: boolean } = {}) {
  const store = createTestStore(options.ctxSize ? { ctx_size: options.ctxSize } : {});
  const accepted = vi.fn();
  const hook = renderHook(() => {
    const [msgs, setMsgs] = useState<ChatHistoryMessage[]>([]);
    const [input, setInput] = useState(options.input ?? "Hello");
    const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
    const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
    const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
    const atBottomRef = useRef(true);
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null,
      sessionId: "skills-session", baseUrl: "http://127.0.0.1:8080", apiKey: "test-key", model: "model.gguf",
      activeThread: thread, msgs, setMsgs, input, setInput, phase, setPhase,
      attachments, setAttachments, documents, setDocuments, atBottomRef,
      mcpEntryByFunctionName: options.withMcp
        ? new Map([["catalog__lookup", { serverId: "catalog", serverName: "Catalog", tool: { name: "lookup", input_schema: { type: "object" } } }]])
        : new Map(),
      mcpDefinitions: options.withMcp ? [{ type: "function", function: { name: "catalog__lookup", parameters: { type: "object" } } }] : [],
      selectedSkillIds: options.selected ?? [], onSkillsAccepted: accepted,
    });
    return { ...send, msgs, input, setInput, phase };
  });
  return { ...hook, accepted };
}

function answers(text: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ content: text });
    return text;
  });
}

function callsTool(name: string, args: string) {
  streamMock.mockImplementationOnce(async (_url, _key, _model, _messages, _sampling, onDelta) => {
    onDelta({ tool_calls: [{ index: 0, id: "call-1", name, arguments: args }] });
    return "";
  });
}

const requestMessages = (call: number) => streamMock.mock.calls[call][3];
const systemText = (call: number) => String(requestMessages(call)[0].content);

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockReset();
  loadMock.mockReset();
  readMock.mockReset();
  loadMock.mockResolvedValue(context());
  readMock.mockImplementation(async (id) => ({ skill: [pdf, review].find((skill) => skill.id === id)!, content: `BODY-OF-${id}` }));
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("chat personalization", () => {
  it("puts .agents then .aiolm instructions before the conversation prompt without saving them in history", async () => {
    answers("Done");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    const system = systemText(0);
    expect(system.indexOf("AGENTS-RULE")).toBeLessThan(system.indexOf("AIOLM-RULE"));
    expect(system.indexOf("AIOLM-RULE")).toBeLessThan(system.indexOf("PROJECT-PROMPT"));
    expect(system).toContain("id: aiolm:pdf");
    expect(system).not.toContain("BODY-OF");
    expect(streamMock.mock.calls[0][4].tools?.map((tool) => tool.function.name)).toEqual(["aiolm_read_skill"]);
    expect(JSON.stringify(result.current.msgs)).not.toContain("AGENTS-RULE");
    expect(thread.systemPrompt).toBe("PROJECT-PROMPT");
  });

  it("sends the conversation prompt unchanged when there is nothing local", async () => {
    loadMock.mockResolvedValue({ instructions: [{ source: "agents", path: "synthetic/a", exists: false, content: "", revision: null }], skills: [], warnings: [] });
    answers("Done");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(systemText(0)).toBe("PROJECT-PROMPT");
    expect(streamMock.mock.calls[0][4].tools).toEqual([]);
  });

  it("includes a skill picked and referenced with $name once, and leaves amounts and code alone", async () => {
    answers("Done");
    const { result, accepted } = setup({ input: "Use $pdf for the $5 invoice, not `$review`", selected: ["aiolm:pdf"] });
    await act(async () => { await result.current.send(); });
    expect(readMock.mock.calls).toEqual([["aiolm:pdf"]]);
    expect(systemText(0).split("BODY-OF-aiolm:pdf").length - 1).toBe(1);
    expect(accepted).toHaveBeenCalledOnce();
    expect(result.current.input).toBe("");
    expect(result.current.msgs[0]).toMatchObject({ role: "user", content: "Use $pdf for the $5 invoice, not `$review`" });
  });

  it("keeps the draft and selection when an explicit skill is unknown", async () => {
    const { result, accepted } = setup({ input: "Please use $missing-skill" });
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toContain("$missing-skill");
    expect(streamMock).not.toHaveBeenCalled();
    expect(readMock).not.toHaveBeenCalled();
    expect(result.current.input).toBe("Please use $missing-skill");
    expect(accepted).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("shows a load failure instead of silently sending without instructions", async () => {
    loadMock.mockRejectedValueOnce(new Error("permission denied"));
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toContain("permission denied");
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.current.input).toBe("Hello");
  });

  it("surfaces unreadable or oversized file warnings", async () => {
    loadMock.mockResolvedValue(context({ warnings: ["skills/huge/SKILL.md exceeds 64 KiB and was skipped."] }));
    answers("Done");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.contextWarning).toContain("exceeds 64 KiB");
  });

  it("reads a catalog skill automatically, continues the stream and announces only the final answer", async () => {
    callsTool("aiolm_read_skill", JSON.stringify({ id: "agents:review" }));
    answers("Reviewed");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.pendingToolCall).toBeNull();
    expect(readMock.mock.calls).toEqual([["agents:review"]]);
    const followup = requestMessages(1);
    expect(followup.at(-1)).toMatchObject({ role: "tool", name: "aiolm_read_skill", tool_call_id: "call-1" });
    expect(String(followup.at(-1)!.content)).toContain("BODY-OF-agents:review");
    expect(followup[0]).toEqual(requestMessages(0)[0]);
    expect(result.current.msgs.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Reviewed" });
    expect(JSON.stringify(result.current.msgs)).not.toContain("BODY-OF");
    expect(notifyMock.mock.calls).toEqual([["chat"]]);
  });

  it("still requires approval for MCP tools", async () => {
    callsTool("catalog__lookup", "{}");
    const { result } = setup({ withMcp: true });
    await act(async () => { await result.current.send(); });
    expect(result.current.pendingToolCall).toMatchObject({ toolName: "lookup" });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(streamMock.mock.calls[0][4].tools?.map((tool) => tool.function.name)).toEqual(["catalog__lookup", "aiolm_read_skill"]);
  });

  it.each([
    ["a path-like id", JSON.stringify({ id: "../../secrets/SKILL.md" })],
    ["an id outside the catalog", JSON.stringify({ id: "agents:other" })],
    ["extra arguments", JSON.stringify({ id: "aiolm:pdf", path: "C:/x" })],
    ["invalid JSON", "{"],
  ])("answers %s with an error without touching the native reader", async (_label, args) => {
    callsTool("aiolm_read_skill", args);
    answers("Recovered");
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(readMock).not.toHaveBeenCalled();
    expect(String(requestMessages(1).at(-1)!.content)).toMatch(/^Error: /);
    expect(result.current.msgs.at(-1)).toMatchObject({ content: "Recovered" });
  });

  it("stops after a bounded number of automatic skill reads", async () => {
    for (let index = 0; index < 5; index += 1) callsTool("aiolm_read_skill", JSON.stringify({ id: "aiolm:pdf" }));
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(streamMock).toHaveBeenCalledTimes(5);
    expect(readMock).toHaveBeenCalledOnce();
    expect(result.current.error).toBe("Skill read limit reached (4 reads per response).");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("applies a file change to the next turn only and retries with the original snapshot", async () => {
    streamMock.mockRejectedValueOnce(new Error("HTTP 500"));
    const { result } = setup();
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toBe("HTTP 500");
    loadMock.mockResolvedValue(context({ instructions: [{ source: "agents", path: "synthetic/agents/AGENTS.md", exists: true, content: "CHANGED-RULE", revision: "r3" }] }));
    answers("Retried");
    await act(async () => { await result.current.send(true); });
    expect(loadMock).toHaveBeenCalledOnce();
    expect(systemText(1)).toBe(systemText(0));
    expect(systemText(1)).toContain("AGENTS-RULE");
    act(() => result.current.setInput("Next turn"));
    answers("Next");
    await act(async () => { await result.current.send(); });
    expect(loadMock).toHaveBeenCalledTimes(2);
    expect(systemText(2)).toContain("CHANGED-RULE");
    expect(systemText(2)).not.toContain("AGENTS-RULE");
  });

  it("retries a failed skill follow-up with the original request and the skill body already read", async () => {
    callsTool("aiolm_read_skill", JSON.stringify({ id: "aiolm:pdf" }));
    streamMock.mockRejectedValueOnce(new Error("HTTP 500"));
    const { result } = setup({ input: "Summarize the PDF" });
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toBe("HTTP 500");
    expect(result.current.failedRef.current).toMatchObject({ text: "Summarize the PDF" });
    const failedHistory = requestMessages(1);

    // The files change on disk before the user retries.
    loadMock.mockResolvedValue(context({ instructions: [], skills: [] }));
    readMock.mockResolvedValue({ skill: pdf, content: "CHANGED-BODY" });
    answers("Summary");
    await act(async () => { await result.current.send(true); });
    expect(streamMock).toHaveBeenCalledTimes(3);
    expect(requestMessages(2)).toEqual(failedHistory);
    expect(String(requestMessages(2).at(-1)!.content)).toContain("BODY-OF-aiolm:pdf");
    expect(loadMock).toHaveBeenCalledOnce();
    expect(readMock).toHaveBeenCalledOnce();
    expect(result.current.msgs.map((message) => [message.role, message.content])).toEqual([["user", "Summarize the PDF"], ["assistant", "Summary"]]);
    expect(notifyMock.mock.calls).toEqual([["chat"]]);
  });

  it("does not offer to retry an earlier failure when a new message fails during preparation", async () => {
    streamMock.mockRejectedValueOnce(new Error("HTTP 500"));
    const { result } = setup({ input: "First" });
    await act(async () => { await result.current.send(); });
    expect(result.current.failedRef.current).not.toBeNull();
    act(() => result.current.setInput("Use $missing-skill"));
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toContain("$missing-skill");
    expect(result.current.failedRef.current).toBeNull();
    expect(result.current.input).toBe("Use $missing-skill");
    expect(streamMock).toHaveBeenCalledOnce();
  });

  it("keeps the snapshot through an MCP follow-up even when files change", async () => {
    callsTool("catalog__lookup", "{}");
    const { result } = setup({ withMcp: true });
    await act(async () => { await result.current.send(); });
    loadMock.mockResolvedValue(context({ instructions: [] }));
    answers("Final");
    await act(async () => { await result.current.approvePendingTool(); });
    expect(loadMock).toHaveBeenCalledOnce();
    expect(systemText(1)).toBe(systemText(0));
    expect(notifyMock.mock.calls).toEqual([["chat"]]);
  });

  it("does not start a request when stopped while instructions load", async () => {
    let resolveLoad!: (value: ChatPersonalization) => void;
    loadMock.mockReturnValueOnce(new Promise((resolve) => { resolveLoad = resolve; }));
    const { result, accepted } = setup({ input: "Use $pdf" });
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(loadMock).toHaveBeenCalledOnce());
    act(() => result.current.stop());
    await act(async () => { resolveLoad(context()); await sending; });
    expect(readMock).not.toHaveBeenCalled();
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.current.input).toBe("Use $pdf");
    expect(accepted).not.toHaveBeenCalled();
    expect(result.current.phase).toBe("idle");
  });

  it("does not continue when stopped while a skill is read", async () => {
    callsTool("aiolm_read_skill", JSON.stringify({ id: "aiolm:pdf" }));
    let resolveRead!: (value: { skill: ChatSkill; content: string }) => void;
    readMock.mockReturnValueOnce(new Promise((resolve) => { resolveRead = resolve; }));
    const { result } = setup();
    let sending!: Promise<void>;
    act(() => { sending = result.current.send(); });
    await waitFor(() => expect(readMock).toHaveBeenCalledOnce());
    act(() => result.current.stop());
    await act(async () => { resolveRead({ skill: pdf, content: "BODY" }); await sending; });
    expect(streamMock).toHaveBeenCalledOnce();
    expect(result.current.phase).toBe("idle");
    expect(notifyMock).not.toHaveBeenCalled();
  });

  it("refuses to send instructions that exceed the context budget instead of truncating them", async () => {
    loadMock.mockResolvedValue(context({ instructions: [{ source: "agents", path: "synthetic/agents/AGENTS.md", exists: true, content: "rule ".repeat(2000), revision: "r1" }] }));
    const { result } = setup({ ctxSize: 512 });
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toMatch(/more than this model's 384-token context budget/);
    expect(streamMock).not.toHaveBeenCalled();
    expect(result.current.input).toBe("Hello");
  });

  it("refuses a skill tool result that would overflow the context budget", async () => {
    callsTool("aiolm_read_skill", JSON.stringify({ id: "aiolm:pdf" }));
    readMock.mockResolvedValueOnce({ skill: pdf, content: "step ".repeat(2000) });
    const { result } = setup({ ctxSize: 1024 });
    await act(async () => { await result.current.send(); });
    expect(result.current.error).toMatch(/^Skill pdf would bring this request/);
    expect(streamMock).toHaveBeenCalledOnce();
    expect(notifyMock).not.toHaveBeenCalled();
  });
});
