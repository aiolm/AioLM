import { useRef, useState, type Dispatch, type SetStateAction } from "react";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../../shared/api/index";
import { createTestStore } from "../../testing/appStore";
import { CHAT_WORKSPACE_CLEAR_EVENT, createChatThread, type ChatHistoryMessage, type ChatThread } from "./chatHistory";
import type { ImageAttachment } from "./chatTypes";
import { toChatMessage } from "./chatSendHelpers";
import { useChatSend } from "./useChatSend";

const conversion = vi.hoisted(() => ({
  calls: [] as Array<{ message: unknown; mediaBeforeText: boolean }>,
}));

vi.mock("./chatSendHelpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./chatSendHelpers")>();
  return {
    ...actual,
    toChatMessage: vi.fn((message, mediaBeforeText = false) => {
      conversion.calls.push({ message, mediaBeforeText });
      return actual.toChatMessage(message, mediaBeforeText);
    }),
  };
});

vi.mock("../../shared/api/index", () => ({
  chatStream: vi.fn(async () => "Synthetic answer"),
  serverActivity: vi.fn(async () => undefined),
}));
vi.mock("../../shared/api/personalization", () => ({
  getChatPersonalization: vi.fn(async () => ({ instructions: [], skills: [], warnings: [] })),
  readSkill: vi.fn(),
  PERSONALIZATION_CHANGED_EVENT: "aiolm-personalization-changed",
}));
vi.mock("../../shared/lib/notifications", () => ({ notifyCompletion: vi.fn(async () => undefined) }));

const image: ImageAttachment = { name: "synthetic.png", kind: "image", dataUrl: "data:image/png;base64,AA==" };
const document = { name: "notes.md", path: "synthetic/notes.md", text: "Original synthetic document" };
const audio = { name: "speech.wav", kind: "audio" as const, ref: `${"a".repeat(64)}.wav`, dataUrl: "",
  preparation: { kind: "transcription" as const, text: "Prepared transcript", sessionId: "speech", model: "whisper-small" } };
const video = { name: "scene.mp4", kind: "video" as const, ref: `${"b".repeat(64)}.mp4`, dataUrl: "",
  preparation: { kind: "video-frames" as const, frames: [{ ref: `${"c".repeat(64)}.jpg`, timestampSeconds: 2.5 }] } };

interface SetupProps {
  messages: ChatHistoryMessage[];
  thread: ChatThread;
  sessionId: string;
  input: string;
}

function setup(messages: ChatHistoryMessage[], thread = createChatThread(1, "cache-thread"), sessionId = "cache-session", input = "Current question") {
  const store = createTestStore();
  return renderHook(({ messages: currentMessages, thread: currentThread, sessionId: currentSessionId, input: currentInput }: SetupProps) => {
    const [phase, setPhase] = useState<"idle" | "thinking" | "streaming">("idle");
    const atBottomRef = useRef(true);
    const setMsgs = vi.fn() as unknown as Dispatch<SetStateAction<ChatHistoryMessage[]>>;
    const setInput = vi.fn();
    const setAttachments = vi.fn();
    const setDocuments = vi.fn();
    const send = useChatSend({
      store, effectiveConfig: store.cfg, modelProfile: null, sessionId: currentSessionId,
      baseUrl: "http://127.0.0.1:8080", apiKey: "synthetic-key", model: "synthetic-model",
      activeThread: currentThread, msgs: currentMessages, setMsgs, input: currentInput, setInput,
      attachments: [], documents: [], setAttachments, setDocuments, atBottomRef, phase, setPhase,
      mcpDefinitions: [], mcpEntryByFunctionName: new Map(),
    });
    return { ...send, phase };
  }, { initialProps: { messages, thread, sessionId, input } });
}

function history(): ChatHistoryMessage[] {
  return [
    { role: "user", content: "Earlier question", images: [image], documents: [document] },
    { role: "assistant", content: "Earlier answer" },
  ];
}

function request(index: number): api.ChatMessage[] {
  return vi.mocked(api.chatStream).mock.calls[index][3];
}

async function send(result: { current: { send: () => Promise<void> } }) {
  await act(async () => { await result.current.send(); });
}

beforeEach(() => {
  vi.clearAllMocks();
  conversion.calls.length = 0;
  vi.mocked(api.chatStream).mockReset().mockResolvedValue("Synthetic answer");
  localStorage.clear();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation(() => 1);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
});

describe("private normal history conversion cache", () => {
  it("reuses unchanged identities without changing the request history", async () => {
    const messages = history();
    const hook = setup(messages);

    await send(hook.result);
    const first = structuredClone(request(0));
    expect(conversion.calls).toHaveLength(messages.length);
    expect(conversion.calls.filter(call => (call.message as ChatHistoryMessage).documents?.length)).toHaveLength(1);

    conversion.calls.length = 0;
    await send(hook.result);

    expect(conversion.calls).toHaveLength(0);
    expect(request(1)).toEqual(first);
    expect(JSON.stringify(request(1))).toBe(JSON.stringify(first));
  });

  it("invalidates only an immutable replacement and observes refreshed document text", async () => {
    const messages = history();
    const hook = setup(messages);
    await send(hook.result);
    conversion.calls.length = 0;

    const refreshed = messages.slice();
    refreshed[0] = { ...refreshed[0], documents: [{ ...document, text: "Refreshed synthetic document" }] };
    hook.rerender({ messages: refreshed, thread: createChatThread(1, "cache-thread"), sessionId: "cache-session", input: "Current question" });
    await send(hook.result);

    expect(conversion.calls).toHaveLength(1);
    expect(conversion.calls[0].message).toBe(refreshed[0]);
    expect(JSON.stringify(request(1))).toContain("Refreshed synthetic document");
    expect(JSON.stringify(request(1))).not.toContain("Original synthetic document");
  });

  it("keeps separate mode entries and preserves prepared media ordering", async () => {
    const messages: ChatHistoryMessage[] = [{ role: "user", content: "Describe", images: [image] }, { role: "assistant", content: "Earlier" }];
    const textFirst = createChatThread(1, "mode-thread");
    const hook = setup(messages, textFirst);
    await send(hook.result);
    conversion.calls.length = 0;

    const mediaFirst = { ...textFirst, mediaBeforeText: true };
    hook.rerender({ messages, thread: mediaFirst, sessionId: "cache-session", input: "Current question" });
    await send(hook.result);
    expect(conversion.calls).toHaveLength(messages.length);
    expect(request(1).find(message => message.role === "user")?.content).toEqual([
      { type: "image_url", image_url: { url: image.dataUrl } },
      { type: "text", text: "Describe" },
    ]);

    conversion.calls.length = 0;
    await send(hook.result);
    expect(conversion.calls).toHaveLength(0);
    expect(request(2)).toEqual(request(1));
  });

  it("reuses prepared audio/video and does not cache malformed media conversions", async () => {
    const prepared: ChatHistoryMessage[] = [{ role: "user", content: "Summarize", images: [audio, video] }];
    const hook = setup(prepared);
    await send(hook.result);
    const preparedRequest = JSON.stringify(request(0));
    expect(preparedRequest).toContain("Prepared transcript");
    expect(preparedRequest).toContain("Audio track is not included");
    expect(preparedRequest).not.toContain(audio.ref);

    const malformed: ChatHistoryMessage[] = [{
      role: "user", content: "Summarize", images: [{ ...audio, preparation: { ...audio.preparation, text: "" } }],
    }];
    vi.mocked(api.chatStream).mockClear();
    const broken = setup(malformed);
    await send(broken.result);
    expect(broken.result.current.error).toContain("preparation");
    expect(api.chatStream).not.toHaveBeenCalled();
    conversion.calls.length = 0;
    await send(broken.result);
    expect(conversion.calls).toHaveLength(1);
    expect(api.chatStream).not.toHaveBeenCalled();
  });

  it("keeps full or trimmed request output exact when the entry bound overflows", async () => {
    const messages = Array.from({ length: 260 }, (_, index): ChatHistoryMessage => ({
      role: index % 2 === 0 ? "user" : "assistant", content: `Synthetic history ${index}`,
    }));
    const hook = setup(messages);
    await send(hook.result);
    const first = structuredClone(request(0));
    conversion.calls.length = 0;
    await send(hook.result);

    expect(conversion.calls.length).toBe(4);
    expect(request(1)).toEqual(first);
    expect(JSON.stringify(request(1))).toBe(JSON.stringify(first));
  });

  it("keeps the payload bound independent of history retention and still emits the same trimmed request", async () => {
    const messages = Array.from({ length: 90 }, (_, index): ChatHistoryMessage => ({
      role: index % 2 === 0 ? "user" : "assistant", content: `Synthetic payload ${index} ${"x".repeat(12_000)}`,
    }));
    const hook = setup(messages);
    await send(hook.result);
    const first = structuredClone(request(0));
    conversion.calls.length = 0;
    await send(hook.result);

    expect(conversion.calls).toHaveLength(8);
    expect(request(1)).toEqual(first);
    expect(JSON.stringify(request(1))).toBe(JSON.stringify(first));
  });

  it("resets the private cache on session/thread ownership changes and workspace clearing", async () => {
    const messages = history();
    const thread = createChatThread(1, "owner-a");
    const hook = setup(messages, thread, "session-a");
    await send(hook.result);

    conversion.calls.length = 0;
    hook.rerender({ messages, thread, sessionId: "session-b", input: "Current question" });
    await send(hook.result);
    expect(conversion.calls).toHaveLength(messages.length);

    conversion.calls.length = 0;
    hook.rerender({ messages, thread: { ...thread, id: "owner-b" }, sessionId: "session-b", input: "Current question" });
    await send(hook.result);
    expect(conversion.calls).toHaveLength(messages.length);

    conversion.calls.length = 0;
    window.dispatchEvent(new CustomEvent(CHAT_WORKSPACE_CLEAR_EVENT, { detail: { state: "clearing" } }));
    await send(hook.result);
    expect(conversion.calls).toHaveLength(messages.length);
  });

  it("keeps the public helper uncached so in-place edits remain visible", () => {
    const message: ChatHistoryMessage = { role: "user", content: "Before", documents: [document] };
    const before = toChatMessage(message);
    message.content = "After";
    const after = toChatMessage(message);
    expect(before).not.toBe(after);
    expect(after.content).toContain("After");
  });
});
