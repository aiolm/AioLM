import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import type { ChatThread, ChatWorkspace } from "./chatHistory";
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
  loadChatWorkspaceAsync: async () => workspace,
  saveChatWorkspaceAsync: async () => "local",
}));

describe("useChatThreads", () => {
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
