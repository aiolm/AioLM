import { memo } from "react";
import type { ChatHistoryMessage } from "./chatHistory";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { translate } from "../../shared/i18n/i18nUnified";
import { modelDisplayName, normalizeDisplayText } from "../../shared/lib/displayPaths";
import ModelIcon from "../../shared/ui/ModelIcon";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import ChatMarkdown from "./ChatMarkdown";
import ResponseMetrics from "./ResponseMetrics";

interface MessageBubbleProps {
  message: ChatHistoryMessage;
  index: number;
  messageCount: number;
  phase: "idle" | "thinking" | "streaming";
  copied: boolean;
  compact: boolean;
  locale: Locale;
  onCopy: (index: number, text: string) => void;
}

/**
 * Memoized so a streaming tick — which only replaces the last message's content —
 * doesn't re-render every earlier bubble in a long conversation. That guarantee only
 * holds if every prop here is either a primitive or a reference that stays stable
 * across renders (locale, onCopy), which is why this takes `locale` instead of a
 * per-render-bound text-lookup closure.
 */
// Named export (in addition to the memoized default) exists solely so tests can
// verify the memoization contract itself, by re-wrapping this in `memo()` and
// spying on calls — see MessageBubble.perf.test.tsx.
export function MessageBubble({ message, index, messageCount, phase, copied, compact, locale, onCopy }: MessageBubbleProps) {
  const text = (key: ChatTextKey) => translate(locale, `chat.${key}`);
  const isUser = message.role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"} px-1`}>
      <div
        className={[`relative min-w-0 text-sm leading-[1.7] ${compact ? "chat-message-compact" : ""} ${
          isUser
            ? "max-w-[68%] rounded-2xl rounded-br-md border px-3.5 py-2.5"
            : "w-full px-1 py-2"
        }`, (isUser ? ["ui-background-panel-raised","ui-border-color-border","ui-color-ink"].join(" ") : ["ui-color-ink"].join(" "))].filter(Boolean).join(" ")}

      >
        <div className="min-w-0">
        {message.role === "assistant" && message.reasoning && (
          <details className="chat-reasoning mb-2.5 rounded-lg border px-2.5 py-2 text-xs leading-relaxed ui-border-color-border ui-background-surface-muted ui-color-muted" >
            <summary className="cursor-pointer select-none font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ui-focus)] ui-color-faint" >{text("thinking")}</summary>
            {/* The body collapses on click too, so a long trace can be put away
                from wherever the reader's eye already is. Copying text out of it
                still works: a click that ends a selection is not a toggle. */}
            <div
              className="chat-reasoning-body mt-1.5 whitespace-pre-wrap break-words"
              onClick={(event) => {
                if (!window.getSelection()?.isCollapsed) return;
                const details = event.currentTarget.closest("details");
                if (details) details.open = false;
              }}
            >{message.reasoning}</div>
          </details>
        )}
        {message.images?.length ? <div className="mb-2.5 flex flex-wrap gap-2">{message.images.map((image) => <img key={image.dataUrl} src={image.dataUrl} alt={normalizeDisplayText(image.name)} loading="lazy" decoding="async" width={144} height={144} className="h-36 w-36 max-h-40 max-w-40 rounded-lg border object-contain ui-border-color-border ui-background-mono-bg"  />)}</div> : null}
        {message.documents?.length ? <div className="mb-2 flex flex-wrap gap-1.5">{message.documents.map((document) => <span key={document.path} className="rounded-full border px-2.5 py-1 text-xs font-medium ui-border-color-border ui-background-surface-muted ui-color-muted" >{text("document")} · {normalizeDisplayText(document.name)}</span>)}</div> : null}
        {/* Only the assistant's side is markdown. What the user typed is shown
            back exactly as typed, since they did not ask for it to be formatted. */}
        {message.content && !isUser
          ? <ChatMarkdown source={message.content} />
          : <div className="whitespace-pre-wrap break-words">{message.content || (phase === "thinking" && index === messageCount - 1 ? <span className="animate-pulse ui-color-faint" >{text("thinkingNow")}</span> : "")}</div>}
        {message.interrupted && <div className="mt-2 text-xs ui-color-warning"  role="status">{text("interrupted")}</div>}
        {message.failed && <div className="mt-2 text-xs ui-color-danger"  role="alert">{text("partialFailed")}</div>}
        </div>
        {!isUser && <div className="mt-2 flex min-w-0 items-center gap-2 text-xs ui-color-muted">
          {message.model && <ModelIcon model={message.model} />}
          <span className="min-w-0 break-all">
            <span className="sr-only">{translate(locale, "ui.responseModel")}: </span>
            {message.model ? modelDisplayName(message.model) : translate(locale, "ui.responseModelUnknown")}
          </span>
        </div>}
        {/* One closing row for the answer: measurements along the left, the copy
            action at the right edge. The button is shown outright rather than
            revealed on hover, because hidden it still reserved a row of its own
            and every finished answer ended in a band of blank space. */}
        {message.role === "assistant" && (message.metrics || message.content) && <div className="chat-message-footer">
          {message.metrics && <ResponseMetrics metrics={message.metrics} locale={locale} />}
          {message.content && <button type="button" onClick={() => onCopy(index, message.content)} className="chat-message-copy app-button app-button--secondary app-button--sm" aria-label={copied ? text("copied") : text("copy")}>{copied ? text("copied") : text("copy")}</button>}
        </div>}
      </div>
    </div>
  );
}

export default memo(MessageBubble);
