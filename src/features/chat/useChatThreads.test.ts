import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatThread, ChatWorkspace } from "./chatHistory";
import { loadChatWorkspaceAsync } from "./chatHistory";
import { useChatThreads } from "./useChatThreads";

const thread = (id: string, title: string, updatedAt: number): ChatThread => ({
  id, title, systemPrompt: "", createdAt: updatedAt, updatedAt,
  messages: [{ role: "user", content: `${title} question` }],
});
const workspace: ChatWorkspace = {
  activeThreadId: "older",
  threads: [thread("older", "Recipes", 1), thread("newer", "Release notes", 2)],
};

vi.mock("./chatHistory", async (importOriginal) => ({
  ...await importOriginal<typeof import("./chatHistory")>(),
  loadChatWorkspace: () => workspace,
  loadChatWorkspaceAsync: vi.fn(async () => workspace),
  saveChatWorkspaceAsync: async () => "local",
}));

describe("useChatThreads", () => {
  beforeEach(() => vi.mocked(loadChatWorkspaceAsync).mockResolvedValue(workspace));

  it('hydrates an unchanged workspace without serializing the existing conversations', async () => {
    const stringify = vi.spyOn(JSON, 'stringify');
    try {
      const { result } = renderHook(useChatThreads, { initialProps: {
        phase: 'idle' as const, requireIdle: () => true, onSwitchThread: () => undefined,
      } });
      await act(async () => { await Promise.resolve(); });
      const historyReads = stringify.mock.calls.filter(([value]) => value === workspace || value === workspace.threads[0].messages);
      expect(historyReads).toHaveLength(0);
      expect(result.current.msgs).toEqual(workspace.threads[0].messages);
    } finally {
      stringify.mockRestore();
    }
  });

  it.each(['streaming', 'approval'] as const)('preserves the live turn owner when delayed history hydration finishes during %s', async stage => {
    let resolveHydration!: (stored: ChatWorkspace) => void;
    vi.mocked(loadChatWorkspaceAsync).mockReturnValue(new Promise(resolve => { resolveHydration = resolve; }));
    let pending = stage === 'approval';
    let phase: 'idle' | 'streaming' = stage === 'streaming' ? 'streaming' : 'idle';
    const switched = vi.fn();
    const options = () => ({ phase, hasPendingTurn: () => pending, requireIdle: () => phase === 'idle' && !pending, onSwitchThread: switched });
    const { result, rerender } = renderHook(useChatThreads, { initialProps: options() });
    const original = result.current.msgs;
    act(() => result.current.setMsgs([...original, { role: 'assistant', content: 'Reply in progress' }]));
    act(() => result.current.selectThread(workspace.threads[1]));
    await act(async () => { resolveHydration(workspace); });
    expect(result.current.workspace.activeThreadId).toBe('newer');
    expect(result.current.viewingLiveThread).toBe(false);
    expect(result.current.msgs.at(-1)?.content).toBe('Reply in progress');
    expect(switched).not.toHaveBeenCalled();
    act(() => result.current.setMsgs([...original, { role: 'assistant', content: 'Final original answer' }]));
    phase = 'idle'; pending = false;
    rerender(options());
    expect(result.current.workspace.threads.find(item => item.id === 'older')?.messages.at(-1)?.content).toBe('Final original answer');
    const reader = result.current.workspace.threads.find(item => item.id === 'newer')!;
    expect(reader.messages).toEqual(workspace.threads[1].messages);
    expect(result.current.msgs).toEqual(reader.messages);
    expect(switched).toHaveBeenCalledOnce();
  });

  it('retains a preparing turn whose initial conversation is absent from the hydrated history', async () => {
    let resolveHydration!: (stored: ChatWorkspace) => void;
    vi.mocked(loadChatWorkspaceAsync).mockReturnValue(new Promise(resolve => { resolveHydration = resolve; }));
    let phase: 'thinking' | 'idle' = 'thinking';
    const options = () => ({ phase, requireIdle: () => phase === 'idle', onSwitchThread: vi.fn() });
    const { result, rerender } = renderHook(useChatThreads, { initialProps: options() });
    const original = result.current.msgs;
    await act(async () => { resolveHydration({ activeThreadId: 'newer', threads: [workspace.threads[1]] }); });
    expect(result.current.workspace.activeThreadId).toBe('older');
    expect(result.current.msgs).toEqual(original);
    expect(result.current.workspace.threads.find(item => item.id === 'older')?.messages).toEqual(original);
    act(() => result.current.setMsgs([...original, { role: 'assistant', content: 'Answer after preparation' }]));
    phase = 'idle'; rerender(options());
    expect(result.current.workspace.threads.find(item => item.id === 'older')?.messages.at(-1)?.content).toBe('Answer after preparation');
    expect(result.current.workspace.threads.find(item => item.id === 'newer')?.messages).toEqual(workspace.threads[1].messages);
  });

  it.each(['existing', 'new'] as const)('keeps an approval-pending turn in its original conversation while reading a %s conversation', async destination => {
    let pending = true;
    const switched = vi.fn();
    const options = () => ({ phase: 'idle' as const, hasPendingTurn: () => pending, requireIdle: () => !pending, onSwitchThread: switched });
    const { result, rerender } = renderHook(useChatThreads, { initialProps: options() });
    await act(async () => { await Promise.resolve(); });
    const original = result.current.msgs;
    act(() => result.current.setMsgs([...original, { role: 'assistant', content: '' }]));
    act(() => {
      if (destination === 'existing') result.current.selectThread(workspace.threads[1]);
      else result.current.newThread();
    });
    const readerId = result.current.workspace.activeThreadId;
    expect(readerId).not.toBe('older');
    expect(result.current.viewingLiveThread).toBe(false);
    expect(result.current.msgs).toEqual([...original, { role: 'assistant', content: '' }]);
    expect(switched).not.toHaveBeenCalled();

    // Approval starts a follow-up, and its final answer belongs to the buffer's owner.
    act(() => result.current.setMsgs([...original, { role: 'assistant', content: 'Tool-assisted answer' }]));
    pending = false;
    rerender(options());
    expect(result.current.workspace.threads.find(item => item.id === 'older')?.messages.at(-1)?.content).toBe('Tool-assisted answer');
    const reader = result.current.workspace.threads.find(item => item.id === readerId)!;
    expect(reader.messages.some(message => message.content === 'Tool-assisted answer')).toBe(false);
    expect(result.current.viewingLiveThread).toBe(true);
    expect(result.current.msgs).toEqual(reader.messages);
    expect(switched).toHaveBeenCalledOnce();
  });

  it('releases a rejected pending turn even when its idle phase and messages do not change', async () => {
    let pending = true;
    const switched = vi.fn();
    const options = () => ({ phase: 'idle' as const, hasPendingTurn: () => pending, requireIdle: () => !pending, onSwitchThread: switched });
    const { result, rerender } = renderHook(useChatThreads, { initialProps: options() });
    await act(async () => { await Promise.resolve(); });
    act(() => result.current.selectThread(workspace.threads[1]));
    expect(result.current.msgs).toEqual(workspace.threads[0].messages);
    pending = false;
    rerender(options());
    expect(result.current.msgs).toEqual(workspace.threads[1].messages);
    expect(switched).toHaveBeenCalledOnce();
  });

  it("keeps a searched thread list across renders that leave threads and query unchanged", async () => {
    const options = () => ({ phase: "idle" as const, requireIdle: () => true, onSwitchThread: () => undefined });
    const { result, rerender } = renderHook(useChatThreads, { initialProps: options() });
    await act(async () => { await Promise.resolve(); });

    act(() => result.current.setThreadQuery("re"));
    const searched = result.current.visibleThreads;
    expect(searched.map((item) => item.id)).toEqual(["newer", "older"]);

    // A composer keystroke or streaming tick re-renders the panel with fresh callbacks.
    rerender(options());
    expect(result.current.visibleThreads).toBe(searched);

    act(() => result.current.setThreadQuery("recipes"));
    expect(result.current.visibleThreads.map((item) => item.id)).toEqual(["older"]);
  });
});
