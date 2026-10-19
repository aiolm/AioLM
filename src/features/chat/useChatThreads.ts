import { useEffect, useMemo, useRef, useState } from "react";
import { CHAT_WORKSPACE_CLEAR_EVENT, createChatThread, isChatWorkspaceClearing, loadChatWorkspace, loadChatWorkspaceAsync, mergeHydratedWorkspace, saveChatWorkspaceAsync, threadMatchesQuery, titleFromMessage, type ChatHistoryMessage, type ChatThread, type ChatWorkspace, type ChatWorkspaceClearDetail } from "./chatHistory";
import { removeDocumentVectorsForPaths } from "./documentIndex";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { trackInitialRead } from "../../shared/ui/initialLayout";
import { displayChatTitle } from './chatThreadTitle';

type Msg = ChatHistoryMessage;

interface UseChatThreadsOptions {
  defaultThreadTitle?: string;
  phase: "idle" | "thinking" | "streaming";
  /** Read after rendering: MCP approval keeps a turn alive while its stream is idle. */
  hasPendingTurn?: () => boolean;
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

export function useChatThreads({ phase, hasPendingTurn, requireIdle, onSwitchThread, defaultThreadTitle = 'New conversation' }: UseChatThreadsOptions) {
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
  const [clearingWorkspace, setClearingWorkspace] = useState(isChatWorkspaceClearing);
  const hydratedRef = useRef(false);
  const initialWorkspaceRef = useRef(workspace);
  const initialMsgsRef = useRef(msgs);
  const workspaceRef = useRef(workspace);
  const msgsRef = useRef(msgs);
  const bufferRef = useRef({ threadId: msgsThreadId, phase });
  // Held in a ref so the effect that re-points the buffer does not re-run on
  // every render just because the caller passes a fresh closure.
  const switchRef = useRef(onSwitchThread);
  const pendingTurnRef = useRef(hasPendingTurn);
  workspaceRef.current = workspace;
  msgsRef.current = msgs;
  bufferRef.current = { threadId: msgsThreadId, phase };
  switchRef.current = onSwitchThread;
  pendingTurnRef.current = hasPendingTurn;
  const turnInProgress = () => phase !== 'idle' || pendingTurnRef.current?.() === true;

  useEffect(() => {
    let cancelled = false;
    let hydrationRevision = 0;
    const hydrate = () => {
      const revision = ++hydrationRevision;
      void trackInitialRead(loadChatWorkspaceAsync).then((persisted) => {
        if (cancelled || revision !== hydrationRevision || isChatWorkspaceClearing()) return;
        const current = workspaceRef.current;
        let merged = mergeHydratedWorkspace(persisted, current, initialWorkspaceRef.current);
        const localMessagesChanged = msgsRef.current !== initialMsgsRef.current
          && JSON.stringify(msgsRef.current) !== JSON.stringify(initialMsgsRef.current);
        const preserveBuffer = localMessagesChanged || bufferRef.current.phase !== 'idle' || pendingTurnRef.current?.() === true;
        const owner = preserveBuffer ? current.threads.find(thread => thread.id === bufferRef.current.threadId) : undefined;
        if (owner) {
          const messages = msgsRef.current;
          const firstUser = messages.find(message => message.role === 'user');
          const bufferedOwner = { ...owner, messages,
            title: owner.title === 'New conversation' && firstUser ? titleFromMessage(firstUser.content) : owner.title,
            updatedAt: owner.messages === messages ? owner.updatedAt : Date.now() };
          // Disk hydration must not move a reply into the reader's conversation,
          // or discard an initial conversation still preparing its first request.
          merged = { ...merged,
            activeThreadId: current.activeThreadId === owner.id ? owner.id : merged.activeThreadId,
            threads: merged.threads.some(thread => thread.id === owner.id)
              ? merged.threads.map(thread => thread.id === owner.id ? bufferedOwner : thread)
              : [...merged.threads, bufferedOwner] };
        }
        const nextActive = merged.threads.find((thread) => thread.id === merged.activeThreadId) ?? merged.threads[0];
        hydratedRef.current = true;
        setWorkspace(merged);
        if (!owner) {
          setMsgsThreadId(nextActive?.id ?? "");
          if (!localMessagesChanged) setMsgs(nextActive?.messages ?? []);
        }
      });
    };
    const onClear = (event: Event) => {
      const detail = (event as CustomEvent<ChatWorkspaceClearDetail>).detail;
      if (detail.state === "clearing") {
        hydrationRevision += 1;
        hydratedRef.current = false;
        setClearingWorkspace(true);
        switchRef.current();
      } else if (detail.state === "cleared") {
        const fresh = detail.workspace;
        const thread = fresh.threads[0];
        workspaceRef.current = fresh;
        msgsRef.current = thread.messages;
        initialWorkspaceRef.current = fresh;
        initialMsgsRef.current = thread.messages;
        bufferRef.current = { threadId: thread.id, phase: "idle" };
        hydratedRef.current = true;
        setWorkspace(fresh);
        setMsgsThreadId(thread.id);
        setMsgs(thread.messages);
        setPendingDelete(null);
        setClearingWorkspace(false);
      } else {
        setClearingWorkspace(false);
        // A failed erase keeps any recoverable data visible and resumes reads.
        hydrate();
      }
    };
    window.addEventListener(CHAT_WORKSPACE_CLEAR_EVENT, onClear);
    if (!isChatWorkspaceClearing()) hydrate();
    return () => { cancelled = true; window.removeEventListener(CHAT_WORKSPACE_CLEAR_EVENT, onClear); };
  }, []);

  useEffect(() => {
    if (hydratedRef.current && !isChatWorkspaceClearing()) void saveChatWorkspaceAsync(workspace);
  }, [workspace]);

  useEffect(() => {
    if (phase !== "idle" || clearingWorkspace) return;
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
  }, [msgs, msgsThreadId, phase, clearingWorkspace]);

  // The turn is over and the reader is somewhere else: the buffer follows them,
  // now that the reply it was holding has been written back above.
  // Approval can end without changing the idle phase or messages, so its
  // callback also participates in handing the buffer to the reader.
  useEffect(() => {
    if (clearingWorkspace || phase !== 'idle' || pendingTurnRef.current?.() || !activeThread || msgsThreadId === activeThread.id) return;
    setMsgsThreadId(activeThread.id);
    setMsgs(activeThread.messages);
    switchRef.current();
  }, [phase, msgsThreadId, activeThread, hasPendingTurn, clearingWorkspace]);

  // A search scans every message and attached document, so it must not rerun on
  // each composer keystroke or streaming tick, which leave the threads unchanged.
  const visibleThreads = useMemo(() => workspace.threads
    .filter((thread) => threadMatchesQuery(thread, threadQuery)
      || displayChatTitle(thread.title, defaultThreadTitle).toLowerCase().includes(threadQuery.trim().toLowerCase()))
    .sort((left, right) => right.updatedAt - left.updatedAt), [workspace.threads, threadQuery, defaultThreadTitle]);

  // Reading another conversation is always allowed. Only the buffer stays put
  // while a reply is arriving; the view is free to move.
  const keeping = (keepId: string) => (item: ChatThread) => item.id === keepId || item.id === msgsThreadId || !unused(item);

  const selectThread = (thread: ChatThread) => {
    setThreadPanelOpen(false);
    // Reselecting the reader's conversation must keep its unsent composer and
    // the current reply owner intact; only a different conversation switches.
    if (thread.id === workspace.activeThreadId) return;
    setWorkspace((current) => ({ activeThreadId: thread.id, threads: current.threads.filter(keeping(thread.id)) }));
    if (turnInProgress()) return;
    setMsgsThreadId(thread.id);
    setMsgs(thread.messages);
    onSwitchThread();
  };

  const newThread = () => {
    // An untouched conversation already is a new one; opening it again beats
    // creating a second copy that is indistinguishable from it.
    const reusable = workspace.threads.find((item) => unused(item) && (!turnInProgress() || item.id !== msgsThreadId));
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
    if (turnInProgress()) return;
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

  const updateActiveThread = (patch: Partial<Pick<ChatThread, "title" | "systemPrompt" | "useDefaultSystemPrompt" | "mediaBeforeText">>) => {
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
    workspace, setWorkspace, activeThread, msgs, setMsgs, viewMessages, viewingLiveThread, clearingWorkspace,
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  };
}
