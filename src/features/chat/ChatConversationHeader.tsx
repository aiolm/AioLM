import ModelName from '../../shared/ui/ModelName';
import { useEffect, useRef, type ReactNode } from "react";
import type { ChatThread } from "../../shared/api/conversationTypes";
import type { ChatPhase } from "./chatSendTypes";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { normalizeDisplayPath } from "../../shared/lib/displayPaths";
import ModelIcon from "../../shared/ui/ModelIcon";
import RuntimeSelectionLabel from '../../shared/ui/RuntimeSelectionLabel';
import type { AppConfig } from '../../shared/api/types';
import { chatTitlePreview, displayChatTitle, isGeneratedChatTitle } from './chatThreadTitle';

interface ChatConversationHeaderProps {
  threadPanelOpen: boolean;
  setThreadPanelOpen: (updater: (value: boolean) => boolean) => void;
  activeThread: ChatThread | undefined;
  activeProjectName: string | null;
  phase: ChatPhase;
  targetBusy?: boolean;
  onUpdateThread: (patch: Partial<Pick<ChatThread, "title" | "systemPrompt" | "useDefaultSystemPrompt" | "mediaBeforeText">>) => void;
  sessionLabel: string;
  sessionOptions: Array<{ id: string; label: string; disabled?: boolean }>;
  selectedSessionId: string;
  model: string;
  runtimeConfig?: Partial<AppConfig> | null;
  onSelectSession: (id: string) => void;
  ct: (key: ChatTextKey) => string;
  embedding?: { label: string; hint: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void };
  mediaControls?: ReactNode;
}

export default function ChatConversationHeader({
  threadPanelOpen, setThreadPanelOpen, activeThread, activeProjectName, phase, onUpdateThread,
  sessionLabel, sessionOptions, selectedSessionId, model, runtimeConfig, onSelectSession, ct, embedding, mediaControls, targetBusy = false,
}: ChatConversationHeaderProps) {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const title = displayChatTitle(activeThread?.title, ct('newConversation'));
  const headingTitle = activeProjectName ? `${title} · ${activeProjectName}` : title;

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const details = detailsRef.current;
      if (!details?.open || details.contains(event.target as Node)) return;
      const target = event.target instanceof Element ? event.target : null;
      const listbox = target?.closest('[role="listbox"]');
      // A portalled menu still belongs to its control inside these settings.
      if (listbox) {
        for (const control of details.querySelectorAll('[role="combobox"][aria-expanded="true"][aria-controls]')) {
          const controlledIds = control.getAttribute('aria-controls')?.split(/\s+/) ?? [];
          if (controlledIds.some(id => details.ownerDocument.getElementById(id) === listbox)) return;
        }
      }
      details.open = false;
    };
    const details = detailsRef.current;
    const popover = popoverRef.current;
    const scroller = details?.closest<HTMLElement>(".app-page-scroll");
    const fitPopover = () => {
      if (!details?.open || !popover) return;
      // Expanded task activity can reduce the workspace without a window resize.
      const bottom = Math.min(window.innerHeight, scroller?.getBoundingClientRect().bottom ?? window.innerHeight);
      const available = Math.max(0, bottom - popover.getBoundingClientRect().top - 8);
      popover.style.setProperty("--chat-settings-available-height", `${available}px`);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(fitPopover);
    observer?.observe(scroller ?? document.documentElement);
    details?.addEventListener("toggle", fitPopover);
    scroller?.addEventListener("scroll", fitPopover, { passive: true });
    window.addEventListener("resize", fitPopover);
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      details?.removeEventListener("toggle", fitPopover);
      scroller?.removeEventListener("scroll", fitPopover);
      window.removeEventListener("resize", fitPopover);
      observer?.disconnect();
    };
  }, []);

  return (
    <header className="chat-conversation-heading">
      <div className="chat-heading-title">
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
          <h1 title={headingTitle} aria-label={headingTitle} className="chat-page-title">{chatTitlePreview(title)}</h1>
          {activeProjectName && <p className="chat-project-name" title={activeProjectName}>{activeProjectName}</p>}
          {(model || runtimeConfig) && <div className="chat-answer-context">
            {model && <span className="chat-answer-model" title={normalizeDisplayPath(model)}><ModelIcon model={model} /><span><ModelName model={model} /></span></span>}
            {runtimeConfig && <span className="chat-answer-runtime"><RuntimeSelectionLabel config={runtimeConfig} /></span>}
          </div>}
        </div>
      </div>
      <div className="chat-heading-controls">
        <div className="chat-session-target">
          <label className="sr-only" htmlFor="chat-session-target">{sessionLabel}</label>
          <CustomSelect id="chat-session-target" className="chat-session-picker" triggerClassName="chat-session-trigger" value={selectedSessionId} disabled={phase !== "idle" || targetBusy} onChange={onSelectSession} options={sessionOptions.map(option => ({ value: option.id, label: option.label, title: option.label, disabled: option.disabled }))} />
        </div>
      {/* Escape is delegated from descendant controls after their own handlers. */}
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
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
        <summary ref={summaryRef} className="chat-settings-summary app-button app-button--secondary app-button--sm cursor-pointer list-none"
          data-icon="settings" aria-label={ct("conversationSettings")} title={ct("conversationSettings")}>
          <span className="sr-only">{ct("conversationSettings")}</span>
        </summary>
        <div ref={popoverRef} className="chat-settings-popover app-card app-card--raised"
          onFocusCapture={(event) => {
            const popup = event.currentTarget;
            const field = event.target;
            if (!(field instanceof HTMLElement) || !popup.contains(field)) return;
            // Native textarea focus can reveal its caret without the whole control.
            requestAnimationFrame(() => {
              if (document.activeElement !== field || !popup.isConnected) return;
              const bounds = popup.getBoundingClientRect();
              const rect = field.getBoundingClientRect();
              const top = bounds.top + popup.clientTop + 8;
              const bottom = bounds.top + popup.clientTop + popup.clientHeight - 8;
              if (rect.bottom > bottom) popup.scrollTop += rect.bottom - bottom;
              else if (rect.top < top) popup.scrollTop += rect.top - top;
            });
          }}>
          {embedding && <div>
            <label className="block text-xs font-medium ui-color-ink" htmlFor="chat-embedding-target">{embedding.label}</label>
            <CustomSelect id="chat-embedding-target" value={embedding.value} options={embedding.options} disabled={phase !== 'idle' || targetBusy} onChange={embedding.onChange} ariaDescribedBy="chat-embedding-hint" />
            <p id="chat-embedding-hint" className="mt-1.5 text-xs ui-color-muted">{embedding.hint}</p>
          </div>}
          {mediaControls}
          <div className="chat-conversation-fields">
          <div>
            <label className="block text-xs font-medium ui-color-ink"  htmlFor="chat-thread-title">{ct("title")}</label>
            <input
              id="chat-thread-title"
              value={isGeneratedChatTitle(activeThread?.title) ? '' : activeThread?.title ?? ''}
              placeholder={ct('newConversation')}
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
          <div className="chat-conversation-options">
          <div>
            <label className="flex items-center gap-2 text-xs ui-color-ink" htmlFor="chat-default-system-prompt">
              <input id="chat-default-system-prompt" type="checkbox"
                checked={activeThread?.useDefaultSystemPrompt !== false}
                onChange={(event) => onUpdateThread({ useDefaultSystemPrompt: event.target.checked })}
                disabled={phase !== "idle" || targetBusy}
                aria-describedby="chat-default-system-prompt-hint" />
              {ct("useDefaultSystemPrompt")}
            </label>
            <p id="chat-default-system-prompt-hint" className="mt-1.5 text-xs ui-color-muted">{ct("useDefaultSystemPromptHint")}</p>
          </div>
          <div>
            <label className="flex items-center gap-2 text-xs ui-color-ink" htmlFor="chat-media-before-text">
              <input id="chat-media-before-text" type="checkbox"
                checked={activeThread?.mediaBeforeText === true}
                onChange={(event) => onUpdateThread({ mediaBeforeText: event.target.checked })}
                disabled={phase !== "idle" || targetBusy}
                aria-describedby="chat-media-before-text-hint" />
              {ct("mediaBeforeText")}
            </label>
            <p id="chat-media-before-text-hint" className="mt-1.5 text-xs ui-color-muted">{ct("mediaBeforeTextHint")}</p>
          </div>
          </div>
        </div>
      </details>
      </div>
    </header>
  );
}
