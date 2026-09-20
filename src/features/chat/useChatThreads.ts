import { useEffect, useRef, useState } from "react";
import { createChatThread, loadChatWorkspace, loadChatWorkspaceAsync, mergeHydratedWorkspace, saveChatWorkspaceAsync, threadMatchesQuery, titleFromMessage, type ChatHistoryMessage, type ChatThread, type ChatWorkspace } from "./chatHistory";
import { removeDocumentVectorsForPaths } from "./documentIndex";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { trackInitialRead } from "../../shared/ui/initialLayout";

type Msg = ChatHistoryMessage;

interface UseChatThreadsOptions {
  phase: "idle" | "thinking" | "streaming";
  /** True (and proceeds) only when the panel is idle; otherwise surfaces an error and blocks the action. */
  requireIdle: () => boolean;
  /** Resets composer-local state (input, attachments, context warnings) after a thread switch. */
  onSwitchThread: () => void;
}

/**
 * A conversation nothing has been put into yet: no messages, no instructions of
 * its own, and still carrying the generated name. Pressing "New chat" repeatedly
 * used to stack identical rows like this, so at most one is kept — a record is
 * worth storing once it holds something.
 */
function unused(thread: ChatThread): boolean {
  return thread.messages.length === 0 && !thread.systemPrompt?.trim() && thread.title === "New conversation";
}

/** Document paths this thread used that no remaining thread still needs. */
function orphanedDocumentPaths(removed: ChatThread, remaining: ChatThread[]): string[] {
  const pathsOf = (threads: ChatThread[]) => new Set(
    threads.flatMap((item) => item.messages.flatMap((message) => (message.documents ?? []).map((document) => document.path))),
  );
  const kept = pathsOf(remaining);
  return [...pathsOf([removed])].filter((path) => !kept.has(path));
}

export function useChatThreads({ phase, requireIdle, onSwitchThread }: UseChatThreadsOptions) {
  const [workspace, setWorkspace] = useState<ChatWorkspace>(() => loadChatWorkspace());
  const activeThread = workspace.threads.find((thread) => thread.id === workspace.activeThreadId) ?? workspace.threads[0];
  const [msgs, setMsgs] = useState<Msg[]>(() => activeThread?.messages ?? []);
  // Which conversation `msgs` is the live buffer for. It is normally the one on
  // screen, but a turn in flight owns it: the reader may move on to another
  // conversation while a reply is still arriving, and the reply has to land in
  // the conversation that asked for it, not in whichever one is being read.
  const [msgsThreadId, setMsgsThreadId] = useState(() => activeThread?.id ?? "");
  const [threadQuery, setThreadQuery] = useState("");
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);
  const hydratedRef = useRef(false);
  const initialWorkspaceRef = useRef(workspace);
  const initialMsgsRef = useRef(msgs);
  const workspaceRef = useRef(workspace);
  const msgsRef = useRef(msgs);
  // Held in a ref so the effect that re-points the buffer does not re-run on
  // every render just because the caller passes a fresh closure.
  const switchRef = useRef(onSwitchThread);
  workspaceRef.current = workspace;
  msgsRef.current = msgs;
  switchRef.current = onSwitchThread;

  useEffect(() => {
    let cancelled = false;
    void trackInitialRead(loadChatWorkspaceAsync).then((persisted) => {
      if (cancelled) return;
      const merged = mergeHydratedWorkspace(persisted, workspaceRef.current, initialWorkspaceRef.current);
      const localMessagesChanged = JSON.stringify(msgsRef.current) !== JSON.stringify(initialMsgsRef.current);
      const nextActive = merged.threads.find((thread) => thread.id === merged.activeThreadId) ?? merged.threads[0];
      hydratedRef.current = true;
      setWorkspace(merged);
      // The buffer belongs to whichever conversation is active after the merge —
      // which may carry a different id — whether or not the messages it is
      // holding came from disk or from a turn the reader already started.
      setMsgsThreadId(nextActive?.id ?? "");
      if (!localMessagesChanged) setMsgs(nextActive?.messages ?? []);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (hydratedRef.current) void saveChatWorkspaceAsync(workspace);
  }, [workspace]);

  useEffect(() => {
    if (phase !== "idle") return;
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === msgsThreadId);
      if (!thread || thread.messages === msgs) return current;
      const firstUser = msgs.find((message) => message.role === "user");
      const nextTitle = thread.title === "New conversation" && firstUser ? titleFromMessage(firstUser.content) : thread.title;
      return {
        ...current,
        threads: current.threads.map((item) => item.id === thread.id
          ? { ...item, messages: msgs, title: nextTitle, updatedAt: Date.now() }
          : item),
      };
    });
  }, [msgs, msgsThreadId, phase]);

  // The turn is over and the reader is somewhere else: the buffer follows them,
  // now that the reply it was holding has been written back above.
  useEffect(() => {
    if (phase !== "idle" || !activeThread || msgsThreadId === activeThread.id) return;
    setMsgsThreadId(activeThread.id);
    setMsgs(activeThread.messages);
    switchRef.current();
  }, [phase, msgsThreadId, activeThread]);

  const visibleThreads = workspace.threads
    .filter((thread) => threadMatchesQuery(thread, threadQuery))
    .sort((left, right) => right.updatedAt - left.updatedAt);

  // Reading another conversation is always allowed. Only the buffer stays put
  // while a reply is arriving; the view is free to move.
  const keeping = (keepId: string) => (item: ChatThread) => item.id === keepId || item.id === msgsThreadId || !unused(item);

  const selectThread = (thread: ChatThread) => {
    setWorkspace((current) => ({ activeThreadId: thread.id, threads: current.threads.filter(keeping(thread.id)) }));
    setThreadPanelOpen(false);
    if (phase !== "idle") return;
    setMsgsThreadId(thread.id);
    setMsgs(thread.messages);
    onSwitchThread();
  };

  const newThread = () => {
    // An untouched conversation already is a new one; opening it again beats
    // creating a second copy that is indistinguishable from it.
    const reusable = workspace.threads.find((item) => unused(item) && (phase === "idle" || item.id !== msgsThreadId));
    const now = Date.now();
    let id = `thread-${now}`;
    let suffix = 1;
    while (workspace.threads.some((thread) => thread.id === id)) id = `thread-${now}-${suffix++}`;
    const thread = reusable ?? createChatThread(now, id);
    setWorkspace((current) => {
      const kept = current.threads.filter(keeping(thread.id));
      return { activeThreadId: thread.id, threads: reusable ? kept : [thread, ...kept] };
    });
    setThreadPanelOpen(false);
    if (phase !== "idle") return;
    setMsgsThreadId(thread.id);
    setMsgs(thread.messages);
    onSwitchThread();
  };

  const deleteThread = (thread: ChatThread) => {
    if (!requireIdle()) return;
    if (shouldConfirmDestructive()) setPendingDelete(thread);
    else performDeleteThread(thread);
  };

  const performDeleteThread = (thread: ChatThread) => {
    setPendingDelete(null);
    const remaining = workspace.threads.filter((item) => item.id !== thread.id);
    // The embedding cache is shared between conversations, so only drop vectors
    // for documents nothing else references any more.
    const orphaned = orphanedDocumentPaths(thread, remaining);
    if (orphaned.length > 0) void removeDocumentVectorsForPaths(orphaned).catch(() => undefined);
    if (thread.id !== workspace.activeThreadId) {
      setWorkspace((current) => ({ ...current, threads: remaining }));
      return;
    }
    const replacement = remaining[0] ?? createChatThread(Date.now(), `thread-${Date.now()}`);
    setWorkspace({ activeThreadId: replacement.id, threads: remaining.length ? remaining : [replacement] });
    setMsgsThreadId(replacement.id);
    setMsgs(replacement.messages);
    onSwitchThread();
  };

  const updateActiveThread = (patch: Partial<Pick<ChatThread, "title" | "systemPrompt">>) => {
    if (!activeThread || !requireIdle()) return;
    setWorkspace((current) => ({
      ...current,
      threads: current.threads.map((thread) => thread.id === current.activeThreadId
        ? { ...thread, ...patch, updatedAt: Date.now() }
        : thread),
    }));
  };

  // What the log renders: the live buffer for the conversation that owns it,
  // and the stored messages for any other one the reader opens meanwhile.
  const viewingLiveThread = msgsThreadId === activeThread?.id;
  const viewMessages = viewingLiveThread ? msgs : activeThread?.messages ?? [];

  return {
    workspace, setWorkspace, activeThread, msgs, setMsgs, viewMessages, viewingLiveThread,
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  };
}
