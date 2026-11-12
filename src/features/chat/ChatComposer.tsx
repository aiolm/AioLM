import MediaPreview from './MediaPreview';
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import StableLabel from "../../shared/ui/StableLabel";
import PanelFeedback from "../../shared/ui/PanelFeedback";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import Badge from "../../shared/ui/Badge";
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode, type Ref } from "react";
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
  locale?: Locale;
  contextWarning: string | null;
  contextSources: string[];
  mcpCatalog: ChatMcpTool[];
  mcpCatalogLoaded?: boolean;
  selectedMcpTools: string[];
  toggleMcpTool: (key: string) => void;
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
  dropTargetRef,
  contextWarning, contextSources, mcpCatalog, mcpCatalogLoaded = false, selectedMcpTools, toggleMcpTool, loadingMcpTools, refreshMcpTools,
  mcpDefinitions, pendingToolCall, toolCallInProgress, onApproveTool, onRejectTool, attachments, onRemoveAttachment, attachmentStatus,
  documents, onRemoveDocument, input, setInput, onKeyDown, disabled, enterToSend = true, phase, onAddAttachment, onStop,
  aborting, onSend, canSend, msgsLength, responseState, responseFinishReason, responseWithoutOutput = false, ct, locale = 'en', loadingModel = false,
  skillPicker, selectedSkills = [], onRemoveSkill, skillsLocked = false, selectedSkillsLabel, removeSkillLabel,
}: ChatComposerProps) {
  const toolStripRef = useRef<HTMLDivElement>(null);
  const mcpHelpId = useId();
  const imeHandlers = useImeEnterGuard(input, onKeyDown);
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
    strip.addEventListener('toggle', closeOtherPickers, true);
    return () => strip.removeEventListener('toggle', closeOtherPickers, true);
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
      <div className="chat-composer-actions" ref={dropTargetRef}>
      {(attachments.length > 0 || documents.length > 0 || attachmentStatus === "reading" || attachmentStatus === "failed") && <div className="chat-composer-context" tabIndex={0} role="region" aria-label={ct("pendingAttachments")}>
      <div className="chat-attachment-status-slot">
        {attachmentStatus !== "idle" && <div className="text-xs ui-color-faint"  role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>
      {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={ct("pendingMedia")}>{attachments.map((image) => <div key={image.ref ?? image.dataUrl} className="flex items-start gap-1"><MediaPreview locale={locale} attachment={image} small /><button type="button" onClick={() => onRemoveAttachment(image.ref ?? image.dataUrl)} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(image.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">{normalizeDisplayText(document.name)}</span><button type="button" onClick={() => onRemoveDocument(document.path)} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(document.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      </div>}
        {selectedSkills.length > 0 && <div className="col-span-full flex flex-wrap gap-1.5" role="group" aria-label={selectedSkillsLabel}>{selectedSkills.map((skill) => <div key={skill.id} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">${normalizeDisplayText(skill.name)}</span><button type="button" onClick={() => onRemoveSkill?.(skill.id)} disabled={skillsLocked} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${removeSkillLabel}: ${normalizeDisplayText(skill.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
        {selectedMcpTools.length > 0 && <div className="chat-selected-tools flex flex-wrap gap-1.5" role="group" aria-label={ct("mcpTools")}>
          {selectedTools.map(({ key, resolved, label }) => (
            <div key={key} className="flex items-center gap-1">
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
        <textarea value={input} onChange={(event) => setInput(event.target.value)}
          {...imeHandlers}
          disabled={disabled || controlsLocked} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct(loadingModel ? "startingServer" : "offline") : ct(enterToSend ? "placeholder" : "placeholderNewline")} className="app-textarea min-w-0 flex-1" />
        <div className="chat-composer-toolbar">
          <div className="chat-composer-tools">
        <button type="button" data-icon="add" onClick={onAddAttachment} disabled={disabled || controlsLocked || attachmentStatus === "reading" || (documents.length >= 4 && attachments.length >= 4)} title={ct("attachFile")} className="chat-attach-button app-button app-button--secondary app-button--sm shrink-0" aria-label={ct("attachFile")}><span className="chat-attach-label">{ct("attachFile")}</span></button>
      <div className="chat-tool-strip" ref={toolStripRef}>
      <details className="chat-mcp-tools">
        <summary className="app-button app-button--secondary app-button--sm cursor-pointer" aria-disabled={controlsLocked}
          onClick={event => { if (controlsLocked) event.preventDefault(); }}>{ct("mcpTools")}</summary>
        <div className="chat-mcp-expanded border-t p-3 ui-border-color-border" >
        <button type="button" data-icon="close" className="chat-mcp-close app-button app-button--secondary app-button--sm absolute right-2 top-2" onClick={event => { const details = event.currentTarget.closest("details"); if (details) { details.open = false; details.querySelector("summary")?.focus(); } }}>{ct("close")}</button>
        <div className="flex flex-wrap items-center gap-2 pr-16">
          {!hasUnresolvedTools && loadToolsButton}
          <span className="text-xs ui-color-faint"><StableLabel value={`${ct("mcpToolsCount").replace("{count}", String(mcpDefinitions.length))} · ${ct("mcpApproval")}`} labels={[`${ct("mcpToolsCount").replace("{count}", "9999")} · ${ct("mcpApproval")}`]} /></span>
        </div>
        <p id={mcpHelpId} className="mt-2 text-xs ui-color-faint">{hasUnresolvedTools ? mcpSelectionHint : ct("mcpOptional")}</p>
        {mcpCatalog.length > 0 && (
          <div className="chat-mcp-catalog-slot">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted" ><input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={controlsLocked} /><span className="max-w-52 app-text-wrap" title={`${normalizeDisplayText(entry.serverName)}: ${normalizeDisplayText(entry.tool.name)}`}>{normalizeDisplayText(entry.serverName)} · {normalizeDisplayText(entry.tool.name)}</span></label>; })}</div>
          </div>
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
