import { useCallback, useEffect, useMemo, useRef, useState, type SetStateAction } from "react";
import { CHAT_WORKSPACE_CLEAR_EVENT, isChatWorkspaceClearing, loadChatWorkspace, loadChatWorkspaceAsync, saveChatWorkspaceAsync } from "./chatHistory";
import { createChatThread, mergeHydratedWorkspace, threadMatchesQuery, titleFromMessage } from "./chatWorkspace";
import { isPristineThread } from "./chatHistorySchema";
import type { ChatHistoryMessage, ChatThread, ChatWorkspace, ChatWorkspaceClearDetail } from "../../shared/api/conversationTypes";
import { removeDocumentVectorsForPaths } from "./documentIndex";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { trackInitialRead } from "../../shared/ui/initialLayout";
import { displayChatTitle } from './chatThreadTitle';
import type { ChatPhase } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

interface UseChatThreadsOptions {
  defaultThreadTitle?: string;
  phase: ChatPhase;
  /** Read after rendering: MCP approval keeps a turn alive while its stream is idle. */
  hasPendingTurn?: () => boolean;
  /** True (and proceeds) only when the panel is idle; otherwise surfaces an error and blocks the action. */
  requireIdle: () => boolean;
  /** Resets composer-local state (input, attachments, context warnings) after a thread switch. */
  onSwitchThread: () => void;
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
  // Only uncommitted turn messages live outside the persisted workspace.
  // Browsing another conversation never changes this buffer's owner.
  const [buffer, setBuffer] = useState<{ threadId: string; messages: Msg[] } | null>(null);
  const [msgsThreadId, setMsgsThreadId] = useState(() => activeThread?.id ?? "");
  const liveThread = workspace.threads.find((thread) => thread.id === msgsThreadId);
  const msgs = buffer?.messages ?? liveThread?.messages ?? [];
  const [threadQuery, setThreadQuery] = useState("");
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ChatThread | null>(null);
  const [clearingWorkspace, setClearingWorkspace] = useState(isChatWorkspaceClearing);
  const [saveFailed, setSaveFailed] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const hydratedRef = useRef(false);
  const initialWorkspaceRef = useRef(workspace);
  const currentRef = useRef({ workspace, buffer, msgsThreadId, phase, hasPendingTurn, onSwitchThread });
  currentRef.current = { workspace, buffer, msgsThreadId, phase, hasPendingTurn, onSwitchThread };
  const setMsgs = useCallback((action: SetStateAction<Msg[]>) => {
    setBuffer(current => {
      const snapshot = currentRef.current;
      const threadId = current?.threadId ?? snapshot.msgsThreadId;
      const messages = current?.messages ?? snapshot.workspace.threads.find(thread => thread.id === threadId)?.messages ?? [];
      const next = typeof action === "function" ? action(messages) : action;
      return next === messages ? current : { threadId, messages: next };
    });
  }, []);
  const turnInProgress = () => phase !== 'idle' || hasPendingTurn?.() === true;

  useEffect(() => {
    let cancelled = false;
    let hydrationRevision = 0;
    const hydrate = () => {
      const revision = ++hydrationRevision;
      void trackInitialRead(loadChatWorkspaceAsync).then((persisted) => {
        if (cancelled || revision !== hydrationRevision || isChatWorkspaceClearing()) return;
        const snapshot = currentRef.current;
        const current = snapshot.workspace;
        let merged = mergeHydratedWorkspace(persisted, current, initialWorkspaceRef.current);
        const preserveBuffer = snapshot.buffer !== null || snapshot.phase !== 'idle' || snapshot.hasPendingTurn?.() === true;
        const owner = preserveBuffer ? current.threads.find(thread => thread.id === snapshot.msgsThreadId) : undefined;
        if (owner) {
          const messages = snapshot.buffer?.messages ?? owner.messages;
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
        if (!owner) setMsgsThreadId(nextActive?.id ?? "");
      });
    };
    const onClear = (event: Event) => {
      const detail = (event as CustomEvent<ChatWorkspaceClearDetail>).detail;
      if (detail.state === "clearing") {
        hydrationRevision += 1;
        hydratedRef.current = false;
        setClearingWorkspace(true);
        currentRef.current.onSwitchThread();
      } else if (detail.state === "cleared") {
        const fresh = detail.workspace;
        const thread = fresh.threads[0];
        initialWorkspaceRef.current = fresh;
        currentRef.current = { ...currentRef.current, workspace: fresh, buffer: null, msgsThreadId: thread?.id ?? "", phase: "idle" };
        hydratedRef.current = true;
        setWorkspace(fresh);
        setMsgsThreadId(thread?.id ?? "");
        setBuffer(null);
        setPendingDelete(null);
        setClearingWorkspace(false);
        setSaveFailed(false);
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
    let cancelled = false;
    if (hydratedRef.current && !isChatWorkspaceClearing()) {
      void saveChatWorkspaceAsync(workspace).then(
        result => { if (!cancelled && !isChatWorkspaceClearing()) setSaveFailed(result === "unavailable"); },
        () => { if (!cancelled && !isChatWorkspaceClearing()) setSaveFailed(true); },
      );
    }
    return () => { cancelled = true; };
  }, [workspace, saveAttempt]);

  useEffect(() => {
    if (phase !== "idle" || clearingWorkspace || !buffer) return;
    setWorkspace((current) => {
      const thread = current.threads.find((item) => item.id === buffer.threadId);
      if (!thread || thread.messages === buffer.messages) return current;
      const msgs = buffer.messages;
      const firstUser = msgs.find((message) => message.role === "user");
      const nextTitle = thread.title === "New conversation" && firstUser ? titleFromMessage(firstUser.content) : thread.title;
      return {
        ...current,
        threads: current.threads.map((item) => item.id === thread.id
          ? { ...item, messages: msgs, title: nextTitle, updatedAt: Date.now() }
          : item),
      };
    });
    setBuffer(null);
  }, [buffer, phase, clearingWorkspace]);

  // The turn is over and the reader is somewhere else: the buffer follows them,
  // now that the reply it was holding has been written back above.
  // Approval can end without changing the idle phase or messages, so its
  // callback also participates in handing the buffer to the reader.
  useEffect(() => {
    if (clearingWorkspace || phase !== 'idle' || hasPendingTurn?.() || !activeThread || msgsThreadId === activeThread.id) return;
    setMsgsThreadId(activeThread.id);
    currentRef.current.onSwitchThread();
  }, [phase, msgsThreadId, activeThread, hasPendingTurn, clearingWorkspace]);

  // A search scans every message and attached document, so it must not rerun on
  // each composer keystroke or streaming tick, which leave the threads unchanged.
  const visibleThreads = useMemo(() => workspace.threads
    .filter((thread) => threadMatchesQuery(thread, threadQuery)
      || displayChatTitle(thread.title, defaultThreadTitle).toLowerCase().includes(threadQuery.trim().toLowerCase()))
    .sort((left, right) => right.updatedAt - left.updatedAt), [workspace.threads, threadQuery, defaultThreadTitle]);

  // Reading another conversation is always allowed. Only the buffer stays put
  // while a reply is arriving; the view is free to move.
  const keeping = (keepId: string) => (item: ChatThread) => item.id === keepId || item.id === msgsThreadId || !isPristineThread(item);

  const selectThread = (thread: ChatThread) => {
    setThreadPanelOpen(false);
    // Reselecting the reader's conversation must keep its unsent composer and
    // the current reply owner intact; only a different conversation switches.
    if (thread.id === workspace.activeThreadId) return;
    setWorkspace((current) => ({ activeThreadId: thread.id, threads: current.threads.filter(keeping(thread.id)) }));
    if (turnInProgress()) return;
    setMsgsThreadId(thread.id);
    setBuffer(null);
    onSwitchThread();
  };

  const newThread = () => {
    // An untouched conversation already is a new one; opening it again beats
    // creating a second copy that is indistinguishable from it.
    const reusable = workspace.threads.find((item) => isPristineThread(item) && (!turnInProgress() || item.id !== msgsThreadId));
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
    setBuffer(null);
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
    setBuffer(null);
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
    workspace, setWorkspace, activeThread, liveThread, msgs, setMsgs, viewMessages, viewingLiveThread, clearingWorkspace,
    saveFailed, retrySave: () => setSaveAttempt(attempt => attempt + 1),
    threadQuery, setThreadQuery, threadPanelOpen, setThreadPanelOpen,
    pendingDelete, setPendingDelete, visibleThreads,
    selectThread, newThread, deleteThread, performDeleteThread, updateActiveThread,
  };
}
