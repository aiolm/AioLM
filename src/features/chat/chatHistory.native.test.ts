import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatThread, ChatWorkspace } from "./chatHistory";

// A data folder in memory, standing in for the native conversation store.
const native = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
  calls: [] as { command: string; args: Record<string, unknown> }[],
  keepImports: true,
  failLoad: false,
}));

vi.mock("../../shared/api/transport.ts", () => ({
  isNativeRuntimeAvailable: () => true,
  invoke: vi.fn(async (command: string, args: Record<string, unknown> = {}) => {
    native.calls.push({ command, args });
    switch (command) {
      case "conversations_load":
        if (native.failLoad) throw new Error("disk unavailable");
        return { threads: [...native.files.values()].map((thread) => structuredClone(thread)), warnings: [] };
      case "conversation_save": {
        const thread = args.thread as { id: string };
        native.files.set(thread.id, structuredClone(thread));
        return null;
      }
      case "conversation_delete":
        native.files.delete(args.id as string);
        return null;
      case "conversations_import": {
        let imported = 0;
        for (const thread of args.threads as { id: string }[]) {
          if (!native.keepImports || native.files.has(thread.id)) continue;
          native.files.set(thread.id, structuredClone(thread));
          imported += 1;
        }
        return imported;
      }
      case "conversations_clear":
        native.files.clear();
        return null;
      default:
        throw new Error(`unexpected command ${command}`);
    }
  }),
}));

const WORKSPACE_KEY = "aiolm.chat-workspace.v2";
const LEGACY_KEY = "aiolm.chat-workspace.v1";
const MOVED_KEY = "aiolm.chat-storage.v1";
const ACTIVE_KEY = "aiolm.chat-active-thread.v1";

function thread(id: string, content: string, createdAt = 1): ChatThread {
  return { id, title: content, systemPrompt: "", createdAt, updatedAt: createdAt, messages: [{ role: "user", content }] };
}

// The module remembers what it last wrote; every test starts it afresh.
async function freshHistory() {
  vi.resetModules();
  return import("./chatHistory");
}

const commands = () => native.calls.map((call) => call.command);

beforeEach(() => {
  localStorage.clear();
  // jsdom has no IndexedDB; the browser copies fall back to localStorage.
  vi.stubGlobal("indexedDB", undefined);
  native.files.clear();
  native.calls.length = 0;
  native.keepImports = true;
  native.failLoad = false;
});

describe("conversations in the data folder", () => {
  it('preserves an explicit media ordering choice in an empty conversation through a fresh native load', async () => {
    const conversation: ChatThread = { id: 'media-order', title: 'New conversation', systemPrompt: '', mediaBeforeText: true, messages: [], createdAt: 1, updatedAt: 1 };
    const history = await freshHistory();
    await history.loadChatWorkspaceAsync();
    await history.saveChatWorkspaceAsync({ activeThreadId: conversation.id, threads: [conversation] });
    expect(native.files.get(conversation.id)).toMatchObject({ mediaBeforeText: true, messages: [] });
    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();
    expect(loaded.threads.find(item => item.id === conversation.id)?.mediaBeforeText).toBe(true);
  });
  it('preserves an explicit automatic-prompt opt-out in an otherwise empty conversation', async () => {
    const conversation: ChatThread = { id: 'prompt-choice', title: 'New conversation', systemPrompt: '', useDefaultSystemPrompt: false, messages: [], createdAt: 1, updatedAt: 1 };
    const history = await freshHistory();
    await history.loadChatWorkspaceAsync();
    await history.saveChatWorkspaceAsync({ activeThreadId: conversation.id, threads: [conversation] });
    expect(native.files.get(conversation.id)).toMatchObject({ useDefaultSystemPrompt: false, messages: [] });
    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();
    expect(loaded.threads.find(item => item.id === conversation.id)?.useDefaultSystemPrompt).toBe(false);
  });
  it('preserves runtime finish reasons through native saving and a fresh history load', async () => {
    const conversation = thread('limits', 'Question');
    conversation.messages.push({ role: 'assistant', content: 'Partial answer', finishReason: 'length', model: 'synthetic-model' });
    const history = await freshHistory();
    await history.loadChatWorkspaceAsync();
    await history.saveChatWorkspaceAsync({ activeThreadId: conversation.id, threads: [conversation] });
    expect((native.files.get(conversation.id) as ChatThread).messages.at(-1)).toMatchObject({ finishReason: 'length' });
    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();
    expect(loaded.threads.find(item => item.id === conversation.id)?.messages.at(-1)).toEqual(conversation.messages.at(-1));
  });

  it('keeps the original audio/video and exact prepared content across native save and reload', async () => {
    const audio = { name: 'speech.wav', kind: 'audio' as const, ref: `${'a'.repeat(64)}.wav`, dataUrl: '',
      preparation: { kind: 'transcription' as const, text: 'Keep this transcript.', sessionId: 'speech', model: 'whisper-small' } };
    const video = { name: 'scene.mp4', kind: 'video' as const, ref: `${'b'.repeat(64)}.mp4`, dataUrl: '',
      preparation: { kind: 'video-frames' as const, frames: [{ ref: `${'c'.repeat(64)}.jpg`, timestampSeconds: 2.5 }] } };
    const conversation = thread('prepared', 'Summarize');
    conversation.messages[0].images = [audio, video];
    const history = await freshHistory();
    await history.loadChatWorkspaceAsync();
    expect(await history.saveChatWorkspaceAsync({ activeThreadId: conversation.id, threads: [conversation] })).toBe('native');
    expect((native.files.get(conversation.id) as ChatThread).messages[0].images).toEqual([audio, video]);
    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();
    expect(loaded.threads.find(item => item.id === conversation.id)?.messages[0].images).toEqual([audio, video]);
  });
  it('keeps the exact retry snapshot of an unfinished last reply through native save and reload, and only that one', async () => {
    const image = { name: 'chart.png', kind: 'image' as const, ref: `${'d'.repeat(64)}.png`, dataUrl: '' };
    const request = [
      { role: 'system' as const, content: 'Synthetic system prompt' },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'Explain the chart' }, { type: 'aiolm_media' as const, media: { ref: image.ref, kind: 'image' as const } }] },
      { role: 'assistant' as const, content: '', tool_calls: [{ id: 'call-1', type: 'function' as const, function: { name: 'catalog__lookup', arguments: '{}' } }] },
      { role: 'tool' as const, tool_call_id: 'call-1', name: 'catalog__lookup', content: 'Synthetic tool result' },
    ];
    const retry = { version: 1 as const, text: 'Explain the chart', images: [image], documents: [{ name: 'notes.md', path: 'synthetic/notes.md', text: 'Synthetic notes' }], history: request };
    const conversation = thread('unfinished', 'Earlier question');
    conversation.messages.push(
      { role: 'assistant', content: 'Earlier partial', interrupted: true, retry: { version: 1, unavailable: 'too-large' } },
      { role: 'user', content: 'Explain the chart', images: [image] },
      { role: 'assistant', content: '', reasoning: 'Partial reasoning', interrupted: true, model: 'synthetic-model', retry },
    );
    const history = await freshHistory();
    await history.loadChatWorkspaceAsync();
    await history.saveChatWorkspaceAsync({ activeThreadId: conversation.id, threads: [conversation] });
    const stored = native.files.get(conversation.id) as ChatThread;
    // A superseded reply keeps its text and state but not a snapshot nothing can use.
    expect(stored.messages[1]).toEqual({ role: 'assistant', content: 'Earlier partial', interrupted: true });
    expect(stored.messages.at(-1)?.retry).toEqual(retry);
    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();
    const last = loaded.threads.find(item => item.id === conversation.id)?.messages.at(-1);
    expect(history.savedRetry(last)).toEqual({ kind: 'ready', snapshot: retry });
  });

  it('keeps a reply whose saved retry snapshot is malformed or from an unknown format, without offering an exact retry', async () => {
    const conversation = thread('unknown-retry', 'Question');
    native.files.set(conversation.id, { ...conversation, messages: [...conversation.messages,
      { role: 'assistant', content: 'Partial', failed: true, retry: { version: 2, request: 'from a newer release' } }] });
    const history = await freshHistory();
    const loaded = await history.loadChatWorkspaceAsync();
    const last = loaded.threads.find(item => item.id === conversation.id)?.messages.at(-1);
    expect(last).toMatchObject({ role: 'assistant', content: 'Partial', failed: true });
    expect(history.savedRetry(last)).toEqual({ kind: 'unavailable', reason: 'not-saved' });
    expect(history.savedRetry({ ...last!, retry: { version: 1, text: 'Question', images: [], documents: [], history: [{ role: 'user', content: 42 }] } as never }))
      .toEqual({ kind: 'unavailable', reason: 'not-saved' });
    // A finished reply is not offered for retry, whatever it carries.
    expect(history.savedRetry({ role: 'assistant', content: 'Done', finishReason: 'stop' })).toBeNull();
  });

  it("moves the browser profile's conversations into the data folder once", async () => {
    const workspace: ChatWorkspace = {
      activeThreadId: "thread-2",
      threads: [thread("thread-2", "second", 2), thread("thread-1", "first", 1)],
    };
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));

    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();

    expect([...native.files.keys()].sort()).toEqual(["thread-1", "thread-2"]);
    expect(loaded.activeThreadId).toBe("thread-2");
    expect(loaded.threads.map((item) => item.id)).toEqual(["thread-2", "thread-1"]);
    // The browser copy can no longer bring back a conversation deleted from the data folder.
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();

    native.calls.length = 0;
    await (await freshHistory()).loadChatWorkspaceAsync();
    expect(commands()).toEqual(["conversations_load"]);
  });

  it("keeps the browser copy until every conversation is in the data folder", async () => {
    native.keepImports = false;
    const workspace = { activeThreadId: "thread-1", threads: [thread("thread-1", "only here")] };
    localStorage.setItem(WORKSPACE_KEY, JSON.stringify(workspace));
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await (await freshHistory()).loadChatWorkspaceAsync();
    expect(localStorage.getItem(WORKSPACE_KEY)).not.toBeNull();
    expect(warnings).toHaveBeenCalled();

    // The next start tries again.
    native.keepImports = true;
    await (await freshHistory()).loadChatWorkspaceAsync();
    expect(native.files.has("thread-1")).toBe(true);
    expect(localStorage.getItem(WORKSPACE_KEY)).toBeNull();
    warnings.mockRestore();
  });

  it("writes only the conversations that changed and deletes the removed ones", async () => {
    native.files.set("thread-1", thread("thread-1", "first", 1));
    native.files.set("thread-2", thread("thread-2", "second", 2));
    const history = await freshHistory();
    const loaded = await history.loadChatWorkspaceAsync();
    native.calls.length = 0;

    const first = loaded.threads.find((item) => item.id === "thread-1") as ChatThread;
    const changed = { ...first, messages: [...first.messages, { role: "assistant" as const, content: "reply" }] };
    expect(await history.saveChatWorkspaceAsync({ activeThreadId: "thread-1", threads: [changed] })).toBe("native");

    expect(native.calls).toEqual([
      { command: "conversation_save", args: { thread: expect.objectContaining({ id: "thread-1" }) } },
      { command: "conversation_delete", args: { id: "thread-2" } },
    ]);
    native.calls.length = 0;
    await history.saveChatWorkspaceAsync({ activeThreadId: "thread-1", threads: [changed] });
    expect(native.calls).toEqual([]);
  });

  it("gives a conversation nothing has been put into no file", async () => {
    const history = await freshHistory();
    const loaded = await history.loadChatWorkspaceAsync();
    await history.saveChatWorkspaceAsync(loaded);
    expect(commands()).not.toContain("conversation_save");
    expect(native.files.size).toBe(0);
  });

  it("opens the remembered conversation and keeps the newest first", async () => {
    native.files.set("thread-1", thread("thread-1", "first", 1));
    native.files.set("thread-3", thread("thread-3", "third", 3));
    native.files.set("thread-2", thread("thread-2", "second", 2));
    localStorage.setItem(MOVED_KEY, "native");
    localStorage.setItem(ACTIVE_KEY, "thread-2");

    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();

    expect(loaded.activeThreadId).toBe("thread-2");
    expect(loaded.threads.map((item) => item.id)).toEqual(["thread-2", "thread-3", "thread-1"]);
  });

  it("clears the data folder together with every browser copy", async () => {
    native.files.set("thread-1", thread("thread-1", "secret"));
    localStorage.setItem(LEGACY_KEY, JSON.stringify({ activeThreadId: "thread-9", threads: [thread("thread-9", "older")] }));

    await (await freshHistory()).clearChatWorkspace();

    expect(native.files.size).toBe(0);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it("still opens when the data folder cannot be read", async () => {
    native.failLoad = true;
    localStorage.setItem(MOVED_KEY, "native");
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const loaded = await (await freshHistory()).loadChatWorkspaceAsync();

    expect(loaded.threads).toHaveLength(1);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
