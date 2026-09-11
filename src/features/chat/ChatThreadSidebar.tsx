import { useEffect, useRef } from "react";
import type { ChatThread } from "./chatHistory";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";

interface ChatThreadSidebarProps {
  open: boolean;
  onClose?: () => void;
  activeThreadId: string;
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
  open, onClose, activeThreadId, threadCount, threadQuery, setThreadQuery, visibleThreads,
  onSelect, onDelete, onNewThread, ct,
}: ChatThreadSidebarProps) {
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    if (document.getElementById("chat-thread-toggle-button")?.getClientRects().length) {
      searchInputRef.current?.focus();
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose?.();
        document.getElementById("chat-thread-toggle-button")?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  return (
    <aside
      id="chat-thread-panel"
      aria-label={ct("conversations")}
      role={open ? "region" : undefined}
      className={`chat-thread-sidebar${open ? " is-open" : ""}`}

    >
      <div className="flex items-center gap-2 pb-3">
        <div className="min-w-0 flex-1">
          <div className="app-eyebrow ui-color-faint" >{ct("conversations")}</div>
          <div className="mt-0.5 text-xs tabular-nums ui-color-faint" >{threadCount} {ct("conversations")}</div>
        </div>
        <button type="button" onClick={onNewThread} className="app-button app-button--primary app-button--sm">{ct("newChat")}</button>
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
      <input
        ref={searchInputRef}
        id="chat-thread-search"
        value={threadQuery}
        onChange={(event) => setThreadQuery(event.target.value)}
        placeholder={ct("search")}
        className="app-input mb-2.5"
      />
      <div className="chat-thread-list min-h-0 flex-1 space-y-1 overflow-auto" role="list">
        {visibleThreads.length === 0 && <p className="px-2 py-4 text-xs ui-color-faint" >{ct("noMatches")}</p>}
        {visibleThreads.map((thread) => (
          <div key={thread.id} role="listitem" className={`app-list-row chat-thread-row flex items-start justify-between gap-1 px-1 py-1 ${thread.id === activeThreadId ? "is-selected" : ""}`}>
            <div className="min-w-0 flex-1">
            <button
              type="button"
              onClick={() => {
                onSelect(thread);
                onClose?.();
              }}
              className="chat-thread-entry min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--ui-focus)]"
              aria-current={thread.id === activeThreadId ? "true" : undefined}
            >
              <span className="chat-thread-title app-text-wrap text-xs font-medium ui-color-ink" >{thread.title || ct("newConversation")}</span>
            </button>
              <span className="mt-0.5 block px-2.5 text-xs tabular-nums ui-color-faint" >{thread.messages.length ? `${thread.messages.length} ${ct("messages")}` : ct("empty")}</span>
            </div>
            <button type="button" onClick={() => onDelete(thread)} aria-label={`${ct("delete")}: ${thread.title || ct("newConversation")}`} className="app-icon-button app-icon-button--danger mr-1" title={ct("delete")}>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}
