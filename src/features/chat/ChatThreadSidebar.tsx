import { useEffect, useRef } from "react";
import type { ChatThread } from "../../shared/api/conversationTypes";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { chatTitlePreview, displayChatTitle } from './chatThreadTitle';

interface ChatThreadSidebarProps {
  open: boolean;
  active?: boolean;
  onClose?: () => void;
  activeThreadId: string;
  liveThreadId?: string;
  liveActive?: boolean;
  liveApproval?: boolean;
  liveMessageCount?: number;
  threadCount: number;
  threadQuery: string;
  setThreadQuery: (value: string) => void;
  visibleThreads: ChatThread[];
  onSelect: (thread: ChatThread) => void;
  onDelete: (thread: ChatThread) => void;
  onNewThread: () => void;
  ct: (key: ChatTextKey) => string;
}

export default function ChatThreadSidebar({
  open, active = true, onClose, activeThreadId, liveThreadId, liveActive = false, liveApproval = false, liveMessageCount,
  threadCount, threadQuery, setThreadQuery, visibleThreads,
  onSelect, onDelete, onNewThread, ct,
}: ChatThreadSidebarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || !active) return;
    if (document.getElementById("chat-thread-toggle-button")?.getClientRects().length) {
      searchInputRef.current?.focus();
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (document.querySelector("dialog[open]")) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("details[open], [role='listbox']")) return;
      event.stopPropagation();
      onClose?.();
      document.getElementById("chat-thread-toggle-button")?.focus();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, active, onClose]);

  return (
    <aside
      id="chat-thread-panel"
      aria-label={ct("conversations")}
      role={open ? "region" : undefined}
      className={`chat-thread-sidebar${open ? " is-open" : ""}`}

    >
      <div className="chat-thread-header">
        <div className="min-w-0 flex-1">
          <h2 className="chat-thread-heading">{ct("conversations")} <span className="models-list-count">{threadCount}</span></h2>
        </div>
        <button type="button" onClick={onNewThread} className="app-button app-button--primary shrink-0 whitespace-nowrap">{ct("newChat")}</button>
        {onClose && (
          <button
            type="button"
            onClick={() => {
              onClose();
              document.getElementById("chat-thread-toggle-button")?.focus();
            }}
            className="app-icon-button chat-thread-close"
            aria-label={ct("close")}
            title={ct("close")}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        )}
      </div>
      <label className="sr-only" htmlFor="chat-thread-search">{ct("search")}</label>
      <div className="app-search-field mb-2.5">
        <input
          ref={searchInputRef}
          id="chat-thread-search"
          value={threadQuery}
          onChange={(event) => setThreadQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && threadQuery.length > 0) {
              event.preventDefault();
              event.stopPropagation();
              setThreadQuery("");
            }
          }}
          placeholder={ct("search")}
          className="app-input"
        />
        {threadQuery && (
          <button
            type="button"
            onClick={() => { setThreadQuery(""); searchInputRef.current?.focus(); }}
            className="app-search-clear app-icon-button app-icon-button--sm"
            aria-label={ct("clearAll")}
            title={ct("clearAll")}
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
          </button>
        )}
      </div>
      <div className="chat-thread-list min-h-0 flex-1 space-y-1 overflow-auto" role="list">
        {visibleThreads.length === 0 && <p className="px-2 py-4 text-xs ui-color-faint" >{ct("noMatches")}</p>}
        {visibleThreads.map((thread) => {
          const isLive = thread.id === liveThreadId;
          const count = isLive && liveMessageCount !== undefined ? liveMessageCount : thread.messages.length;
          return (
            <div key={thread.id} role="listitem" className={`app-list-row chat-thread-row flex items-center justify-between gap-1 ${thread.id === activeThreadId ? "is-selected" : ""}`}>
              <div className="min-w-0 flex-1 overflow-hidden">
              <button
                type="button"
                onClick={() => {
                  onSelect(thread);
                  onClose?.();
                }}
                className="chat-thread-entry app-list-row__action"
                aria-label={displayChatTitle(thread.title, ct('newConversation'))}
                aria-current={thread.id === activeThreadId ? "true" : undefined}
              >
                <span className="chat-thread-title text-sm font-medium ui-color-ink" title={displayChatTitle(thread.title, ct('newConversation'))}>{chatTitlePreview(displayChatTitle(thread.title, ct('newConversation')))}</span>
                <span className="chat-thread-meta text-xs tabular-nums ui-color-faint">
                  <span>{count ? `${count} ${ct("messages")}` : ct("empty")}</span>
                  {isLive && liveActive && (
                    <span className={`chat-thread-live ${liveApproval ? "is-approval" : ""}`}>
                      <span className="chat-thread-live-dot" aria-hidden="true" />
                      <span>{liveApproval ? ct("mcpApprovalRequired") : ct("generating")}</span>
                    </span>
                  )}
                </span>
              </button>
              </div>
              <button type="button" onClick={() => onDelete(thread)} aria-label={`${ct("delete")}: ${displayChatTitle(thread.title, ct('newConversation'))}`} className="app-icon-button app-icon-button--sm app-icon-button--danger shrink-0" title={ct("delete")}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
              </button>
            </div>
          );
        })}
      </div>
    </aside>
  );
}
