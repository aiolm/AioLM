import { useEffect, useRef } from "react";
import type { ChatThread } from "./chatHistory";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { modelDisplayName, normalizeDisplayPath } from "../../shared/lib/displayPaths";
import ModelIcon from "../../shared/ui/ModelIcon";

interface ChatConversationHeaderProps {
  threadPanelOpen: boolean;
  setThreadPanelOpen: (updater: (value: boolean) => boolean) => void;
  activeThread: ChatThread | undefined;
  activeProjectName: string | null;
  phase: "idle" | "thinking" | "streaming";
  targetBusy?: boolean;
  onUpdateThread: (patch: Partial<Pick<ChatThread, "title" | "systemPrompt">>) => void;
  sessionLabel: string;
  sessionOptions: Array<{ id: string; label: string; disabled?: boolean }>;
  selectedSessionId: string;
  model: string;
  onSelectSession: (id: string) => void;
  ct: (key: ChatTextKey) => string;
}

export default function ChatConversationHeader({
  threadPanelOpen, setThreadPanelOpen, activeThread, activeProjectName, phase, onUpdateThread,
  sessionLabel, sessionOptions, selectedSessionId, model, onSelectSession, ct, targetBusy = false,
}: ChatConversationHeaderProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (detailsRef.current?.open && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="chat-conversation-heading">
      <div className="flex min-w-0 items-center gap-2">
        <button
          id="chat-thread-toggle-button"
          type="button"
          onClick={() => setThreadPanelOpen((current) => !current)}
          className="chat-thread-toggle app-button app-button--secondary app-button--sm"
          aria-expanded={threadPanelOpen}
          aria-controls="chat-thread-panel"
        >
          {ct("conversations")}
        </button>
        {/* Keep long conversation titles to one line so the controls stay visible. */}
        <div className="chat-conversation-title">
          <h2 title={activeThread?.title ?? ct("newConversation")} className="text-sm font-semibold ui-color-ink" >{activeThread?.title ?? ct("newConversation")}{activeProjectName ? ` · ${activeProjectName}` : ""}</h2>
        </div>
      </div>
      {/* No model-settings action here: the app header opens the same editor, and
          the blocked view below offers it when the panel cannot be used at all. */}
      <div className="chat-heading-controls">
      <details
        ref={detailsRef}
        className="relative shrink-0"
        onKeyDown={(event) => {
          if (event.key === "Escape" && detailsRef.current?.open) {
            event.preventDefault();
            event.stopPropagation();
            detailsRef.current.open = false;
            summaryRef.current?.focus();
          }
        }}
      >
        <summary ref={summaryRef} className="app-button app-button--secondary app-button--sm cursor-pointer list-none">
          {ct("conversationSettings")}
        </summary>
        <div className="absolute right-0 z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] app-card app-card--raised space-y-3" >
          {/* Answering target lives here rather than in the heading row: it is
              set once and then left alone, so it does not earn permanent space. */}
          <div>
            <label className="block text-xs font-medium ui-color-ink" htmlFor="chat-session-target">{sessionLabel}</label>
            <CustomSelect id="chat-session-target" className="chat-session-picker mt-1.5" value={selectedSessionId} disabled={phase !== "idle" || targetBusy} onChange={onSelectSession} options={sessionOptions.map(option => ({ value: option.id, label: option.label, disabled: option.disabled }))} />
            {model && <p className="mt-1.5 text-xs app-text-wrap ui-color-muted" title={normalizeDisplayPath(model)}><ModelIcon model={model} />{modelDisplayName(model)}</p>}
          </div>
          <div>
            <label className="block text-xs font-medium ui-color-ink"  htmlFor="chat-thread-title">{ct("title")}</label>
            <input
              id="chat-thread-title"
              value={activeThread?.title ?? ""}
              onChange={(event) => onUpdateThread({ title: event.target.value })}
              disabled={phase !== "idle"}
              className="app-input mt-1.5"
            />
          </div>
          <div>
            <label className="block text-xs font-medium ui-color-ink"  htmlFor="chat-system-prompt">{ct("systemPrompt")}</label>
            <textarea
              id="chat-system-prompt"
              value={activeThread?.systemPrompt ?? ""}
              onChange={(event) => onUpdateThread({ systemPrompt: event.target.value })}
              disabled={phase !== "idle"}
              rows={4}
              className="app-textarea mt-1.5"
              placeholder={ct("systemPromptPlaceholder")}
            />
          </div>
          <p className="text-xs leading-relaxed ui-color-faint" >{ct("savedLocallyDescription")}</p>
        </div>
      </details>
      </div>
    </div>
  );
}
