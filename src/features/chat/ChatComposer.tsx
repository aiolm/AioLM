import MediaPreview from './MediaPreview';
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import StableLabel from "../../shared/ui/StableLabel";
import PanelFeedback from "../../shared/ui/PanelFeedback";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { ChatSkill } from "../../shared/api/personalization";
import type * as api from "../../shared/api/types";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import type { Locale } from '../../shared/i18n/i18nCatalog';
import type { ChatMcpTool } from "./useChatMcpTools";
import type { PendingToolCall } from "./useChatSend";
import { createChatImeGuard } from './chatImeGuard';

interface ChatComposerProps {
  locale?: Locale;
  contextWarning: string | null;
  contextSources: string[];
  mcpCatalog: ChatMcpTool[];
  selectedMcpTools: string[];
  toggleMcpTool: (key: string) => void;
  loadingMcpTools: boolean;
  refreshMcpTools: () => void;
  mcpDefinitions: api.ChatToolDefinition[];
  pendingToolCall: PendingToolCall | null;
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
  phase: "idle" | "thinking" | "streaming";
  onAddAttachment: () => void;
  onStop: () => void;
  aborting: boolean;
  onSend: () => void;
  canSend: boolean;
  msgsLength: number;
  ct: (key: ChatTextKey) => string;
  skillPicker?: ReactNode;
  selectedSkills?: ChatSkill[];
  onRemoveSkill?: (id: string) => void;
  skillsLocked?: boolean;
  selectedSkillsLabel?: string;
  removeSkillLabel?: string;
}

export default function ChatComposer({
  contextWarning, contextSources, mcpCatalog, selectedMcpTools, toggleMcpTool, loadingMcpTools, refreshMcpTools,
  mcpDefinitions, pendingToolCall, onApproveTool, onRejectTool, attachments, onRemoveAttachment, attachmentStatus,
  documents, onRemoveDocument, input, setInput, onKeyDown, disabled, phase, onAddAttachment, onStop,
  aborting, onSend, canSend, msgsLength, ct, locale = 'en',
  skillPicker, selectedSkills = [], onRemoveSkill, skillsLocked = false, selectedSkillsLabel, removeSkillLabel,
}: ChatComposerProps) {
  const toolStripRef = useRef<HTMLDivElement>(null);
  const imeGuard = useRef(createChatImeGuard(input));
  useEffect(() => { if (!input) imeGuard.current.reset(input); }, [input]);
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
  const conversationStatus = phase === "streaming" ? ct("generating") : phase === "thinking" ? ct("waitingFirstToken") : msgsLength === 0 ? ct("emptyConversation") : `${ct("responseReady")} · ${msgsLength} ${ct("messages")}`;
  return (
    <>
      <div className="chat-tool-strip" ref={toolStripRef}>
      <details className="chat-mcp-tools app-card app-card--flush">
        <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium ui-color-ink" >{ct("mcpTools")}</summary>
        <div className="chat-mcp-expanded border-t p-3 ui-border-color-border" >
        <button type="button" data-icon="close" className="chat-mcp-close app-button app-button--secondary app-button--sm absolute right-2 top-2" onClick={event => { const details = event.currentTarget.closest("details"); if (details) { details.open = false; details.querySelector("summary")?.focus(); } }}>{ct("close")}</button>
        <div className="flex flex-wrap items-center gap-2 pr-16">
          <button type="button" data-icon="refresh" onClick={refreshMcpTools} disabled={disabled || controlsLocked || loadingMcpTools} className="app-button app-button--secondary app-button--sm"><StableLabel value={loadingMcpTools ? ct("loadingMcpTools") : ct("loadMcpTools")} labels={[ct("loadingMcpTools"), ct("loadMcpTools")]} /></button>
          <span className="text-xs ui-color-faint"><StableLabel value={`${mcpDefinitions.length} tools · ${ct("mcpApproval")}`} labels={[`9999 tools · ${ct("mcpApproval")}`]} /></span>
        </div>
        <p className="mt-2 text-xs ui-color-faint">{ct("mcpOptional")}</p>
        {mcpCatalog.length > 0 && (
          <div className="chat-mcp-catalog-slot">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted" ><input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={controlsLocked} /><span className="max-w-52 app-text-wrap" title={`${normalizeDisplayText(entry.serverName)}: ${normalizeDisplayText(entry.tool.name)}`}>{normalizeDisplayText(entry.serverName)} · {normalizeDisplayText(entry.tool.name)}</span></label>; })}</div>
          </div>
        )}
        </div>
      </details>

      {skillPicker}
      </div>

      <div className="chat-pending-tool-slot">
        {pendingToolCall && <div className="app-card app-card--warning app-card--tight app-card--raised text-xs ui-color-warning-ink" role="alert"><div className="font-semibold">{ct("mcpApprovalRequired")}</div><p className="mt-1"><span className="ui-color-ink" >{normalizeDisplayText(pendingToolCall.serverName)}</span> <span className="opacity-40">·</span> <code className="rounded px-1 py-0.5 font-mono text-xs ui-background-mono-bg ui-color-mono-ink" >{normalizeDisplayText(pendingToolCall.toolName)}</code></p><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2.5 font-mono text-xs ui-background-rgb-0-0-0-18 ui-color-inherit" >{normalizeDisplayText(JSON.stringify(pendingToolCall.argumentsValue, null, 2))}</pre><div className="mt-3 flex gap-2"><button type="button" onClick={onApproveTool} className="app-button app-button--primary app-button--sm">{ct("approveTool")}</button><button type="button" data-icon="close" onClick={onRejectTool} className="app-button app-button--secondary app-button--sm">{ct("rejectTool")}</button></div></div>}
      </div>



      <PanelFeedback>
          {contextWarning && <FeedbackBanner tone="warning" aria-label={ct("contextWarningLabel")}>{contextWarning}</FeedbackBanner>}
      </PanelFeedback>
      {contextSources.length > 0 && <FeedbackBanner tone="info" className="mb-2"><span className="font-medium">{ct("contextSources")}</span><span className="mx-1.5 opacity-40">·</span>{normalizeDisplayText(contextSources.join(" · "))}</FeedbackBanner>}
      <div className="chat-composer-actions">
      {(attachments.length > 0 || documents.length > 0 || attachmentStatus === "reading" || attachmentStatus === "failed") && <div className="chat-composer-context" tabIndex={0} role="region" aria-label={ct("pendingAttachments")}>
      <div className="chat-attachment-status-slot">
        {attachmentStatus !== "idle" && <div className="text-xs ui-color-faint"  role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>
      {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={ct("pendingMedia")}>{attachments.map((image) => <div key={image.ref ?? image.dataUrl} className="flex items-start gap-1"><MediaPreview locale={locale} attachment={image} small /><button type="button" onClick={() => onRemoveAttachment(image.ref ?? image.dataUrl)} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(image.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">{normalizeDisplayText(document.name)}</span><button type="button" onClick={() => onRemoveDocument(document.path)} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${ct("removeAttachment")}: ${normalizeDisplayText(document.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      </div>}
        {selectedSkills.length > 0 && <div className="col-span-full flex flex-wrap gap-1.5" role="group" aria-label={selectedSkillsLabel}>{selectedSkills.map((skill) => <div key={skill.id} className="app-list-row flex items-center gap-1.5 px-2.5 py-1 text-xs ui-color-muted"><span className="max-w-48 app-text-wrap">${normalizeDisplayText(skill.name)}</span><button type="button" onClick={() => onRemoveSkill?.(skill.id)} disabled={skillsLocked} className="app-icon-button app-icon-button--sm app-icon-button--danger" aria-label={`${removeSkillLabel}: ${normalizeDisplayText(skill.name)}`}><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)}
          onInput={event => imeGuard.current.input(event.nativeEvent as InputEvent, event.currentTarget.value)}
          onCompositionStart={() => imeGuard.current.compositionStart()} onCompositionEnd={() => imeGuard.current.compositionEnd()}
          onPointerDown={() => imeGuard.current.reset(input)} onMouseDown={() => imeGuard.current.reset(input)}
          onBlur={() => imeGuard.current.reset(input)} onFocus={() => imeGuard.current.reset(input)}
          onKeyUp={event => imeGuard.current.keyUp(event.nativeEvent)}
          onKeyDown={event => {
            const decision = imeGuard.current.keyDown(event.nativeEvent);
            if (decision.preventDefault) event.preventDefault();
            if (!decision.skipSend) onKeyDown(event);
          }}
          disabled={disabled || controlsLocked} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct("offline") : ct("placeholder")} className="app-textarea min-w-0 flex-1" />
        <button type="button" data-icon="add" onClick={onAddAttachment} disabled={disabled || controlsLocked || attachmentStatus === "reading" || (documents.length >= 4 && attachments.length >= 4)} title={ct("attachFile")} className="app-button app-button--secondary app-button--sm shrink-0" aria-label={ct("attachFile")}>{ct("attachFile")}</button>
        <span className="chat-composer-status text-xs tabular-nums ui-color-faint" role="status" aria-live="polite">{conversationStatus}</span>
        <button type="button" onClick={phase !== "idle" ? onStop : onSend} disabled={phase !== "idle" ? aborting : !canSend || pendingToolCall !== null || attachmentStatus === 'reading'} className={"app-button app-button--sm shrink-0 " + (phase !== "idle" ? "app-button--danger" : "app-button--primary")} aria-label={phase !== "idle" ? ct("stop") : ct("send")}><StableLabel value={phase !== "idle" ? aborting ? ct("stopping") : ct("stop") : ct("send")} labels={[ct("send"), ct("stop"), ct("stopping")]} /></button>
      </div>

    </>
  );
}
