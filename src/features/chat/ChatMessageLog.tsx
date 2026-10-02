import StableLabel from "../../shared/ui/StableLabel";
import type { RefObject } from "react";
import type * as api from "../../shared/api/types";
import type { ChatHistoryMessage } from "./chatHistory";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import MessageBubble from "./MessageBubble";
import EmptyState from "../../shared/ui/EmptyState";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import type { ResponseMetrics } from "../../shared/lib/metrics";

interface ChatMessageLogProps {
  scrollRef: RefObject<HTMLDivElement | null>;
  onScrollAtBottomChange: (atBottom: boolean) => void;
  disabled: boolean;
  status: api.ServerStatus;
  model: string;
  serverOn: boolean;
  msgs: ChatHistoryMessage[];
  streamingDraft: { content: string; reasoning: string; metrics?: ResponseMetrics } | null;
  phase: "idle" | "thinking" | "streaming";
  copiedIndex: number | null;
  compactMessages: boolean;
  locale: Locale;
  onCopy: (index: number, text: string) => void;
  error: string | null;
  canRetry: boolean;
  onRetry: () => void;
  ct: (key: ChatTextKey) => string;
  onOpenModels?: () => void;
  modelSettingsLabel?: string;
  onOpenDiagnostics?: () => void;
  onStart: () => void;
  starting: boolean;
}

export default function ChatMessageLog({
  scrollRef, onScrollAtBottomChange, disabled, status, model, serverOn, msgs, streamingDraft, phase,
  copiedIndex, compactMessages, locale, onCopy, error, canRetry, onRetry, ct,
  onOpenModels, modelSettingsLabel, onOpenDiagnostics, onStart, starting,
}: ChatMessageLogProps) {
  const isFailed = status.state === "failed" || status.state === "crashed";
  return (
    <div
      ref={scrollRef}
      role="log"
      aria-live="off"
      aria-label={ct("conversation")}
      onScroll={(event) => {
        const element = event.currentTarget;
        onScrollAtBottomChange(element.scrollTop + element.clientHeight >= element.scrollHeight - 80);
      }}
      className="chat-message-log"
    >
      {disabled && msgs.length === 0 && (
        <div className="mt-10">
          <EmptyState
            icon={isFailed ? (
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M10 7v5M10 13.5h.01" strokeLinecap="round" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true"><path d="M10 3.5 11.8 8.2H16.5L12.6 10.9 13.9 15.5 10 12.8 6.1 15.5 7.4 10.9 3.5 8.2H8.2L10 3.5Z" /></svg>
            )}
            title={isFailed ? ct("requestFailed") : !model ? modelSettingsLabel ?? ct("openModels") : serverOn ? ct("startingServer") : ct("modelReady")}
            description={isFailed ? ct("blockedFailedDescription") : !model ? ct("blockedNoModelDescription") : serverOn ? ct("blockedStartingDescription") : ct("blockedStoppedDescription")}
          >
          <div className="app-empty-actions">
            {onOpenModels && <button type="button" className="app-button app-button--secondary" data-icon="settings" onClick={onOpenModels} disabled={starting}>{modelSettingsLabel ?? ct("openModels")}</button>}
            {model && !serverOn && !isFailed && <button type="button" className="app-button app-button--primary" onClick={onStart} disabled={starting}><StableLabel value={starting || status.state === "starting" ? ct("startingServer") : ct("startServer")} labels={[ct("startingServer"), ct("startServer")]} /></button>}
            {isFailed && onOpenDiagnostics && <button type="button" className="app-button app-button--secondary" data-icon="probe" onClick={onOpenDiagnostics}>{ct("openDiagnostics")}</button>}
          </div>
          </EmptyState>
        </div>
      )}

      {!disabled && msgs.length === 0 && (
        <div className="mt-12">
          <EmptyState
            icon={<svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"><path d="M4.5 5.5a1.6 1.6 0 0 1 1.6-1.6h7.8a1.6 1.6 0 0 1 1.6 1.6v5.4a1.6 1.6 0 0 1-1.6 1.6H8.3L5.8 14V12.5A1.6 1.6 0 0 1 4.5 11V5.5Z" /><path d="M7 7.2h6M7 9.7h3.5" strokeWidth="1.2" /></svg>}
            title={ct("newConversationTitle")}
            description={ct("newConversationDescription")}
          />
        </div>
      )}

      {msgs.map((message, index) => (
        <MessageBubble
          key={`${message.role}-${index}`}
          message={streamingDraft && index === msgs.length - 1 && message.role === "assistant" ? { ...message, ...streamingDraft } : message}
          index={index}
          messageCount={msgs.length}
          phase={phase}
          copied={copiedIndex === index}
          compact={compactMessages}
          locale={locale}
          onCopy={onCopy}
        />
      ))}

      {error && <FeedbackBanner tone="error" title={ct("requestFailed")}>
        <div className="whitespace-pre-wrap break-words">{normalizeDisplayText(error)}</div>
        {canRetry && <button type="button" data-icon="refresh" onClick={onRetry} disabled={!serverOn || phase !== "idle"} className="app-button app-button--danger app-button--sm mt-2.5">{ct("retry")}</button>}
      </FeedbackBanner>}
    </div>
  );
}
