import MediaPreview from './MediaPreview';
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import StableLabel from "../../shared/ui/StableLabel";
import PanelFeedback from "../../shared/ui/PanelFeedback";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import Badge from "../../shared/ui/Badge";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from "react";
import type { ChatSkill } from "../../shared/api/personalization";
import type * as api from "../../shared/api/types";
import type { DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import type { Locale } from '../../shared/i18n/i18nCatalog';
import type { ChatMcpTool } from "./useChatMcpTools";
import type { PendingToolCall } from "./useChatSend";
import type { ChatPhase } from "./chatSendTypes";
import { useImeEnterGuard } from '../../shared/ui/useImeEnterGuard';
import { chatMcpSelectionCopy, chatReplyStateCopy } from './chatRetryCopy';

interface ChatComposerProps {
  dropTargetRef?: Ref<HTMLDivElement>;
  isDragOver?: boolean;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  onPasteImages?: (files: File[]) => void;
  locale?: Locale;
  contextWarning: string | null;
  contextSources: string[];
  mcpCatalog: ChatMcpTool[];
  mcpCatalogLoaded?: boolean;
  selectedMcpTools: string[];
  toggleMcpTool: (key: string) => void;
  onSelectAllMcpTools?: () => void;
  onClearMcpTools?: () => void;
  loadingMcpTools: boolean;
  refreshMcpTools: () => void;
  mcpDefinitions: api.ChatToolDefinition[];
  pendingToolCall: PendingToolCall | null;
  toolCallInProgress: boolean;
  onApproveTool: () => void;
  onRejectTool: () => void;
  attachments: ImageAttachment[];
  onRemoveAttachment: (dataUrl: string) => void;
  attachmentStatus: "idle" | "reading" | "ready" | "failed";
  documents: DocumentAttachment[];
  onRemoveDocument: (path: string) => void;
  input: string;
  setInput: (value: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  disabled: boolean;
  enterToSend?: boolean;
  loadingModel?: boolean;
  phase: ChatPhase;
  onAddAttachment: () => void;
  onStop: () => void;
  aborting: boolean;
  onSend: () => void;
  canSend: boolean;
  msgsLength: number;
  responseState: 'none' | 'complete' | 'failed' | 'interrupted' | 'tool-request';
  responseFinishReason?: string;
  /** The last reply ended before producing any text or reasoning. */
  responseWithoutOutput?: boolean;
  ct: (key: ChatTextKey) => string;
  skillPicker?: ReactNode;
  selectedSkills?: ChatSkill[];
  onRemoveSkill?: (id: string) => void;
  skillsLocked?: boolean;
  selectedSkillsLabel?: string;
  removeSkillLabel?: string;
}

export default function ChatComposer({
  dropTargetRef, isDragOver = false, textareaRef, onPasteImages,
  contextWarning, contextSources, mcpCatalog, mcpCatalogLoaded = false, selectedMcpTools, toggleMcpTool,
  onSelectAllMcpTools, onClearMcpTools, loadingMcpTools, refreshMcpTools,
  mcpDefinitions, pendingToolCall, toolCallInProgress, onApproveTool, onRejectTool, attachments, onRemoveAttachment, attachmentStatus,
  documents, onRemoveDocument, input, setInput, onKeyDown, disabled, enterToSend = true, phase, onAddAttachment, onStop,
  aborting, onSend, canSend, msgsLength, responseState, responseFinishReason, responseWithoutOutput = false, ct, locale = 'en', loadingModel = false,
  skillPicker, selectedSkills = [], onRemoveSkill, skillsLocked = false, selectedSkillsLabel, removeSkillLabel,
}: ChatComposerProps) {
  const toolStripRef = useRef<HTMLDivElement>(null);
  const internalTextareaRef = useRef<HTMLTextAreaElement>(null);
  const resolvedTextareaRef = textareaRef ?? internalTextareaRef;
  const [mcpQuery, setMcpQuery] = useState("");
  const mcpHelpId = useId();
  const mcpSearchId = useId();
  const imeHandlers = useImeEnterGuard(input, onKeyDown);
  useLayoutEffect(() => {
    const element = resolvedTextareaRef.current;
    if (!element) return;
    if (!input) {
      element.style.height = '';
      return;
    }
    element.style.height = 'auto';
    if (element.scrollHeight > 0) {
      element.style.height = `${Math.min(element.scrollHeight, 160)}px`;
    }
  }, [input, resolvedTextareaRef]);
  useEffect(() => {
    const strip = toolStripRef.current;
    if (!strip) return;
    const closeOtherPickers = (event: Event) => {
      const opened = event.target;
      if (!(opened instanceof HTMLDetailsElement) || !opened.open || opened.parentElement !== strip) return;
      // Both pickers share one overlay area; keep its visible controls reachable.
      for (const picker of strip.querySelectorAll<HTMLDetailsElement>('details')) {
        if (picker !== opened && picker.parentElement === strip) picker.open = false;
      }
    };
    const closeOutsidePickers = (target: EventTarget | null) => {
      if (!(target instanceof Node)) return;
      for (const picker of strip.querySelectorAll<HTMLDetailsElement>('details[open]')) {
        if (picker.parentElement === strip && !picker.contains(target)) picker.open = false;
      }
    };
    const onMouseDown = (event: MouseEvent) => closeOutsidePickers(event.target);
    const onFocusIn = (event: FocusEvent) => closeOutsidePickers(event.target);
    const onStripKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || !(event.target instanceof Node)) return;
      if (event.target instanceof HTMLInputElement && event.target.value.length > 0) return;
      for (const picker of strip.querySelectorAll<HTMLDetailsElement>('details[open]')) {
        if (picker.parentElement === strip && picker.contains(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          picker.open = false;
          picker.querySelector<HTMLElement>('summary')?.focus();
          return;
        }
      }
    };
    strip.addEventListener('toggle', closeOtherPickers, true);
    strip.addEventListener('keydown', onStripKeyDown);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      strip.removeEventListener('toggle', closeOtherPickers, true);
      strip.removeEventListener('keydown', onStripKeyDown);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);
  const controlsLocked = phase !== 'idle' || pendingToolCall !== null;
  useEffect(() => {
    if (!controlsLocked) return;
    for (const picker of toolStripRef.current?.querySelectorAll<HTMLDetailsElement>('details') ?? []) {
      const focused = picker.contains(document.activeElement);
      picker.open = false;
      if (focused) picker.querySelector<HTMLElement>('summary')?.focus();
    }
  }, [controlsLocked]);
  const responseStatus = responseState === 'failed' ? ct('requestFailed')
    : responseState === 'interrupted' ? (responseWithoutOutput ? chatReplyStateCopy[locale].stoppedEmpty : ct('interrupted'))
    : responseState === 'tool-request' ? ct('mcpResponseIncomplete')
    : responseState === 'complete' ? ct(responseFinishReason === 'length' ? 'responseLimited' : 'responseReady') : null;
  const conversationStatus = toolCallInProgress ? ct('waitingMcpTool')
    : pendingToolCall ? ct('mcpApprovalRequired')
    : phase !== 'idle' ? ct(phase)
    : responseStatus ? `${responseStatus} · ${msgsLength} ${ct('messages')}`
    : msgsLength === 0 ? ct('emptyConversation') : `${msgsLength} ${ct('messages')}`;
  const mcpCopy = chatMcpSelectionCopy[locale];
  const mcpSelectionHint = mcpCatalogLoaded ? mcpCopy.unavailableHint : mcpCopy.loadHint;
  const selectedTools = selectedMcpTools.map(key => {
    const entry = mcpCatalog.find(candidate => `${candidate.serverId}:${candidate.tool.name}` === key);
    const separator = key.indexOf(':');
    const toolName = separator >= 0 ? key.slice(separator + 1) : '';
    return {
      key,
      resolved: !!entry,
      label: entry
        ? `${normalizeDisplayText(entry.serverName)} · ${normalizeDisplayText(entry.tool.name)}`
        : normalizeDisplayText(toolName) || mcpCopy.tool,
    };
  });
  const hasUnresolvedTools = selectedTools.some(tool => !tool.resolved);
  const loadToolsButton = <button type="button" data-icon="refresh" onClick={refreshMcpTools}
    disabled={controlsLocked || loadingMcpTools} aria-describedby={mcpHelpId} className="app-button app-button--secondary app-button--sm">
    <StableLabel value={loadingMcpTools ? ct("loadingMcpTools") : ct("loadMcpTools")} labels={[ct("loadingMcpTools"), ct("loadMcpTools")]} />
  </button>;
  const normalizedMcpQuery = mcpQuery.trim().toLowerCase();
  const filteredMcpCatalog = normalizedMcpQuery
    ? mcpCatalog.filter((entry) =>
        `${entry.serverName} ${entry.tool.name} ${entry.tool.description ?? ''}`.toLowerCase().includes(normalizedMcpQuery))
    : mcpCatalog;
  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || controlsLocked || !onPasteImages || !event.clipboardData) return;
    const files: File[] = [];
    if (event.clipboardData.items) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind === 'file' && item.type.startsWith('image/')) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
    }
    if (files.length === 0 && event.clipboardData.files) {
      for (const file of Array.from(event.clipboardData.files)) {
        if (file.type.startsWith('image/')) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      onPasteImages(files);
    }
  };
  return (
    <div className="chat-composer">

      <div className="chat-pending-tool-slot">
        {pendingToolCall && <div className="chat-tool-approval app-card app-card--warning app-card--tight text-xs ui-color-warning-ink" role="alert">
          <div className="font-semibold">{ct("mcpApprovalRequired")}</div>
          <p className="mt-1"><span className="ui-color-ink">{normalizeDisplayText(pendingToolCall.serverName)}</span> · <code className="font-mono">{normalizeDisplayText(pendingToolCall.toolName)}</code></p>
          <pre role="region" aria-label={ct("mcpApprovalRequired")} tabIndex={0} className="chat-tool-arguments font-mono">{normalizeDisplayText(JSON.stringify(pendingToolCall.argumentsValue, null, 2))}</pre>
          <div className="chat-tool-approval-actions">
            <button type="button" onClick={onApproveTool} className="app-button app-button--primary app-button--sm">{ct("approveTool")}</button>
            <button type="button" data-icon="close" onClick={onRejectTool} className="app-button app-button--secondary app-button--sm">{ct("rejectTool")}</button>
          </div>
        </div>}
      </div>
      <PanelFeedback>
          {contextWarning && <FeedbackBanner tone="warning" aria-label={ct("contextWarningLabel")}>{contextWarning}</FeedbackBanner>}
      </PanelFeedback>
      {contextSources.length > 0 && <FeedbackBanner tone="info" className="mb-2"><span className="font-medium">{ct("contextSources")}</span><span className="mx-1.5 opacity-40">·</span>{normalizeDisplayText(contextSources.join(" · "))}</FeedbackBanner>}
      <div className={`chat-composer-actions${isDragOver ? " is-drag-over" : ""}`} ref={dropTargetRef}>
      {isDragOver && <div className="chat-drop-overlay" aria-hidden="true"><span>{ct("dropFilesHint")}</span></div>}
      {(attachments.length > 0 || documents.length > 0 || attachmentStatus === "reading" || attachmentStatus === "failed") && <div className="chat-composer-context" tabIndex={0} role="region" aria-label={ct("pendingAttachments")}>
      <div className="chat-attachment-status-slot">
        {attachmentStatus !== "idle" && <div className="text-xs ui-color-faint"  role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>
      {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={ct("pendingMedia")}>{attachments.map((image) => <div key={image.ref ?? image.dataUrl} className="flex items-start gap-1"><MediaPreview locale={locale} attachment={image} small /><button type="button" onClick={() => onRemoveAttachment(image.ref ?? image.dataUrl)} disabled={controlsLocked} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(image.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">{normalizeDisplayText(document.name)}</span><button type="button" onClick={() => onRemoveDocument(document.path)} disabled={controlsLocked} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(document.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      </div>}
        {selectedSkills.length > 0 && <div className="col-span-full flex flex-wrap gap-1.5" role="group" aria-label={selectedSkillsLabel}>{selectedSkills.map((skill) => <div key={skill.id} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">${normalizeDisplayText(skill.name)}</span><button type="button" onClick={() => onRemoveSkill?.(skill.id)} disabled={skillsLocked} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${removeSkillLabel}: ${normalizeDisplayText(skill.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
        {selectedMcpTools.length > 0 && <div className="chat-selected-tools flex flex-wrap gap-1.5" role="group" aria-label={ct("mcpTools")}>
          {selectedTools.map(({ key, resolved, label }) => (
            <div key={key} className="flex min-w-0 max-w-full items-center gap-1">
              <Badge tone={resolved ? 'neutral' : 'warning'} title={resolved ? undefined : normalizeDisplayText(key)}>
                {label}{!resolved && ` · ${mcpCatalogLoaded ? mcpCopy.unavailable : mcpCopy.notLoaded}`}
              </Badge>
              <button type="button" onClick={() => toggleMcpTool(key)} disabled={controlsLocked}
                className="app-icon-button app-icon-button--sm app-icon-button--danger"
                aria-label={`${mcpCopy.remove}: ${label}`} title={normalizeDisplayText(key)}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg>
              </button>
            </div>
          ))}
          {hasUnresolvedTools && loadToolsButton}
        </div>}
        <textarea ref={resolvedTextareaRef} value={input} onChange={(event) => setInput(event.target.value)}
          onPaste={handlePaste}
          {...imeHandlers}
          disabled={disabled || controlsLocked} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct(loadingModel ? "startingServer" : "offline") : ct(enterToSend ? "placeholder" : "placeholderNewline")} className="app-textarea min-w-0 flex-1" />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
        <button type="button" data-icon="add" onClick={onAddAttachment} disabled={disabled || controlsLocked || attachmentStatus === "reading" || (documents.length >= 4 && attachments.length >= 4)} title={ct("attachFile")} className="chat-attach-button app-button app-button--secondary app-button--sm shrink-0" aria-label={ct("attachFile")}><span className="chat-attach-label">{ct("attachFile")}</span></button>
      <div className="chat-tool-strip" ref={toolStripRef}>
      <details className="chat-mcp-tools" onToggle={(event) => { if (!event.currentTarget.open) setMcpQuery(""); }}>
        <summary className="chat-mcp-summary app-button app-button--secondary app-button--sm cursor-pointer" aria-disabled={controlsLocked}
          data-count={selectedMcpTools.length > 0 ? String(selectedMcpTools.length) : undefined}
          onClick={event => { if (controlsLocked) event.preventDefault(); }}>{ct("mcpTools")}</summary>
        <div className="chat-mcp-expanded border-t p-3 ui-border-color-border" >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            {!hasUnresolvedTools && loadToolsButton}
            <span className="text-xs ui-color-faint"><StableLabel value={`${ct("mcpToolsCount").replace("{count}", String(mcpDefinitions.length))} · ${ct("mcpApproval")}`} labels={[`${ct("mcpToolsCount").replace("{count}", "9999")} · ${ct("mcpApproval")}`]} /></span>
          </div>
          <button type="button" data-icon="close" className="chat-mcp-close app-button app-button--secondary app-button--sm shrink-0" onClick={event => { const details = event.currentTarget.closest("details"); if (details) { details.open = false; details.querySelector("summary")?.focus(); } }}>{ct("close")}</button>
        </div>
        <p id={mcpHelpId} className="mt-2 text-xs ui-color-faint">{hasUnresolvedTools ? mcpSelectionHint : ct("mcpOptional")}</p>
        {mcpCatalogLoaded && mcpCatalog.length === 0 && !loadingMcpTools && (
          <p className="mt-2 text-xs ui-color-faint" role="status">{ct("noMcpTools")}</p>
        )}
        {mcpCatalog.length > 0 && (
          <>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <div className="min-w-0 flex-1">
                <label htmlFor={mcpSearchId} className="block text-xs ui-color-muted">{ct("searchMcpTools")}</label>
                <input
                  id={mcpSearchId}
                  type="search"
                  className="app-input mt-1"
                  value={mcpQuery}
                  onChange={(event) => setMcpQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && mcpQuery.length > 0) {
                      event.preventDefault();
                      event.stopPropagation();
                      event.nativeEvent.stopPropagation();
                      setMcpQuery("");
                    }
                  }}
                />
              </div>
              {onSelectAllMcpTools && onClearMcpTools && (
                <div className="flex items-center gap-1.5">
                  <button type="button" onClick={onSelectAllMcpTools} disabled={controlsLocked || selectedMcpTools.length === mcpCatalog.length} className="app-button app-button--secondary app-button--sm">{ct("selectAll")}</button>
                  <button type="button" onClick={onClearMcpTools} disabled={controlsLocked || selectedMcpTools.length === 0} className="app-button app-button--ghost app-button--sm">{ct("clearAll")}</button>
                </div>
              )}
            </div>
            {filteredMcpCatalog.length === 0 ? (
              <p className="mt-2 text-xs ui-color-faint" role="status">{ct("noMcpToolMatches")}</p>
            ) : (
              <div className="chat-mcp-catalog-slot">
                <div className="flex flex-col gap-1.5">
                  {filteredMcpCatalog.map((entry, idx) => {
                    const key = `${entry.serverId}:${entry.tool.name}`;
                    const checked = selectedMcpTools.includes(key);
                    const descId = entry.tool.description ? `${mcpSearchId}-desc-${idx}` : undefined;
                    return (
                      <div key={key} className="chat-mcp-tool-item">
                        <label className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted">
                          <input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={controlsLocked} aria-describedby={descId} />
                          <span className="max-w-52 app-text-wrap" title={`${normalizeDisplayText(entry.serverName)}: ${normalizeDisplayText(entry.tool.name)}`}>{normalizeDisplayText(entry.serverName)} · {normalizeDisplayText(entry.tool.name)}</span>
                        </label>
                        {descId && entry.tool.description && <p id={descId} className="chat-mcp-tool-desc text-xs ui-color-faint">{normalizeDisplayText(entry.tool.description)}</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
        </div>
      </details>

      {skillPicker}
      </div>
          </div>
        <span className="chat-composer-status text-xs tabular-nums ui-color-faint" role="status" aria-label={ct("conversation")} aria-live="polite">{conversationStatus}</span>
        <button type="button" onClick={phase !== "idle" ? onStop : onSend} disabled={phase !== "idle" ? aborting : !canSend || pendingToolCall !== null || attachmentStatus === 'reading'} className={"chat-send-button app-button app-button--sm shrink-0 " + (phase !== "idle" ? "app-button--danger" : "app-button--primary")} data-icon={phase !== "idle" ? "stop" : "play"} title={phase !== "idle" ? ct("stop") : ct("send")} aria-label={phase !== "idle" ? ct("stop") : ct("send")}><span className="chat-send-label"><StableLabel value={phase !== "idle" ? aborting ? ct("stopping") : ct("stop") : ct("send")} labels={[ct("send"), ct("stop"), ct("stopping")]} /></span></button>
        </div>
      </div>

    </div>
  );
}
