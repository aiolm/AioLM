import StableLabel from "../../shared/ui/StableLabel";
import PanelFeedback from "../../shared/ui/PanelFeedback";
import type { KeyboardEvent } from "react";
import type * as api from "../../shared/api/types";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import type { ChatTextKey } from "../../shared/i18n/chatI18n";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { ChatMetrics, PendingToolCall } from "./useChatSend";

interface ChatComposerProps {
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
  onAddDocument: () => void;
  onAddImage: () => void;
  onStop: () => void;
  aborting: boolean;
  onSend: () => void;
  canSend: boolean;
  model: string;
  displayModel: string;
  msgsLength: number;
  metrics: ChatMetrics | null;
  ct: (key: ChatTextKey) => string;
}

export default function ChatComposer({
  contextWarning, contextSources, mcpCatalog, selectedMcpTools, toggleMcpTool, loadingMcpTools, refreshMcpTools,
  mcpDefinitions, pendingToolCall, onApproveTool, onRejectTool, attachments, onRemoveAttachment, attachmentStatus,
  documents, onRemoveDocument, input, setInput, onKeyDown, disabled, phase, onAddDocument, onAddImage, onStop,
  aborting, onSend, canSend, model, displayModel, msgsLength, metrics, ct,
}: ChatComposerProps) {
  const conversationStatus = phase === "streaming" ? ct("generating") : phase === "thinking" ? ct("waitingFirstToken") : msgsLength === 0 ? ct("emptyConversation") : `${ct("responseReady")} · ${msgsLength} ${ct("messages")}`;
  // Reserve only the status text's intrinsic width, including the pending reply,
  // so completion does not move the path while an empty chat stays compact.
  const statusLabels = msgsLength === 0 && phase === "idle" ? [ct("emptyConversation")] : [
    ct("generating"), ct("waitingFirstToken"),
    `${ct("responseReady")} · ${"9".repeat(String(msgsLength + 1).length)} ${ct("messages")}`,
  ];
  return (
    <>


      <details className="chat-mcp-tools mt-2.5 rounded-lg border ui-border-color-border ui-background-panel" >
        <summary className="cursor-pointer px-3 py-2.5 text-xs font-medium ui-color-ink" >{ct("loadMcpTools")}</summary>
        <div className="chat-mcp-expanded border-t p-3 ui-border-color-border" >
        <button type="button" className="chat-mcp-close app-button app-button--secondary app-button--sm absolute right-2 top-2" onClick={event => { const details = event.currentTarget.closest("details"); if (details) { details.open = false; details.querySelector("summary")?.focus(); } }}>{ct("close")}</button>
        <div className="flex flex-wrap items-center gap-2 pr-16">
          <button type="button" onClick={refreshMcpTools} disabled={disabled || phase !== "idle" || loadingMcpTools} className="app-button app-button--secondary app-button--sm"><StableLabel value={loadingMcpTools ? ct("loadingMcpTools") : ct("loadMcpTools")} labels={[ct("loadingMcpTools"), ct("loadMcpTools")]} /></button>
          <span className="text-xs ui-color-faint"><StableLabel value={`${mcpDefinitions.length} tools · ${ct("mcpApproval")}`} labels={[`9999 tools · ${ct("mcpApproval")}`]} /></span>
        </div>
        <p className="mt-2 text-xs ui-color-faint">{ct("mcpOptional")}</p>
        {mcpCatalog.length > 0 && (
          <div className="chat-mcp-catalog-slot">
            <div className="flex flex-wrap gap-x-3 gap-y-1.5">{mcpCatalog.map((entry) => { const key = `${entry.serverId}:${entry.tool.name}`; const checked = selectedMcpTools.includes(key); return <label key={key} className="flex max-w-full items-center gap-1.5 text-xs ui-color-muted" ><input type="checkbox" checked={checked} onChange={() => toggleMcpTool(key)} disabled={phase !== "idle"} className="ui-accent-color-accent-solid"  /><span className="max-w-52 app-text-wrap" title={`${entry.serverName}: ${entry.tool.name}`}>{entry.serverName} · {entry.tool.name}</span></label>; })}</div>
          </div>
        )}
        </div>
      </details>

      <div className="chat-pending-tool-slot">
        {pendingToolCall && <div className="rounded-lg border p-3.5 text-xs shadow-xl ui-border-color-warning-border ui-background-warning-bg ui-color-warning-ink"  role="alert"><div className="font-semibold">{ct("mcpApprovalRequired")}</div><p className="mt-1"><span className="ui-color-ink" >{pendingToolCall.serverName}</span> <span className="opacity-40">·</span> <code className="rounded px-1 py-0.5 font-mono text-xs ui-background-mono-bg ui-color-mono-ink" >{pendingToolCall.toolName}</code></p><pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-words rounded p-2.5 font-mono text-xs ui-background-rgb-0-0-0-18 ui-color-inherit" >{JSON.stringify(pendingToolCall.argumentsValue, null, 2)}</pre><div className="mt-3 flex gap-2"><button type="button" onClick={onApproveTool} className="app-button app-button--primary app-button--sm">{ct("approveTool")}</button><button type="button" onClick={onRejectTool} className="app-button app-button--secondary app-button--sm">{ct("rejectTool")}</button></div></div>}
      </div>



      <PanelFeedback>
          {contextWarning && <div className="flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-relaxed ui-border-color-warning-border ui-background-warning-bg ui-color-warning-ink"  role="status" aria-label={ct("contextWarningLabel")}><span className="mt-0.5 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--ui-warning)]" aria-hidden="true" />{contextWarning}</div>}
          {contextSources.length > 0 && <div className="rounded-md border px-3 py-2 text-xs ui-border-color-border ui-background-surface-muted ui-color-muted"  role="status"><span className="font-medium ui-color-ink" >{ct("contextSources")}</span><span className="mx-1.5 opacity-40">·</span>{contextSources.join(" · ")}</div>}
      </PanelFeedback>
      <div className="chat-composer-actions">
      {(attachments.length > 0 || documents.length > 0 || attachmentStatus === "reading" || attachmentStatus === "failed") && <div className="chat-composer-context" tabIndex={0} role="region" aria-label={ct("pendingDocuments")}>
      <div className="chat-attachment-status-slot">
        {attachmentStatus !== "idle" && <div className="text-xs ui-color-faint"  role="status" aria-live="polite">{attachmentStatus === "reading" ? ct("attachmentReading") : attachmentStatus === "ready" ? ct("attachmentReady") : ct("attachmentFailed")}</div>}
      </div>
      {attachments.length > 0 && <div className="mt-3 flex flex-wrap gap-2" role="group" aria-label={ct("pendingImages")}>{attachments.map((image) => <div key={image.dataUrl} className="relative"><img src={image.dataUrl} alt={image.name} width={64} height={64} className="h-16 w-16 rounded-lg border object-cover ui-border-color-border"  /><button type="button" onClick={() => onRemoveAttachment(image.dataUrl)} className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border text-white ui-background-danger-solid ui-border-color-surface"  aria-label={`${ct("removeAttachment")}: ${image.name}`}><svg width="8" height="8" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      {documents.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5" role="group" aria-label={ct("pendingDocuments")}>{documents.map((document) => <div key={document.path} className="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ui-border-color-border ui-background-surface-muted ui-color-muted" ><span className="max-w-48 app-text-wrap">{document.name}</span><button type="button" onClick={() => onRemoveDocument(document.path)} className="flex h-5 w-5 items-center justify-center rounded-full hover:bg-[var(--ui-panel)] ui-color-faint"  aria-label={`${ct("removeAttachment")}: ${document.name}`}><svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div>}
      </div>}
        <textarea value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onKeyDown} disabled={disabled || phase !== "idle"} rows={2} aria-label={ct("chatMessage")} placeholder={disabled ? ct("offline") : ct("placeholder")} className="app-textarea min-h-[52px] min-w-0 flex-1 resize-y p-3 text-sm leading-relaxed" />
        <button type="button" onClick={onAddDocument} disabled={disabled || phase !== "idle" || documents.length >= 4} title={ct("attachDocument")} className="app-button app-button--secondary app-button--sm shrink-0" aria-label={ct("attachDocument")}>{ct("attachDocument")}</button>
        <button type="button" onClick={onAddImage} disabled={disabled || phase !== "idle" || attachments.length >= 4} title={ct("attachImage")} className="app-button app-button--secondary app-button--sm shrink-0" aria-label={ct("attachImage")}>{ct("attachImage")}</button>
        <button type="button" onClick={phase !== "idle" ? onStop : onSend} disabled={phase !== "idle" ? aborting : !canSend} className={"app-button app-button--sm shrink-0 " + (phase !== "idle" ? "app-button--danger" : "app-button--primary")} aria-label={phase !== "idle" ? ct("stop") : ct("send")}><StableLabel value={phase !== "idle" ? aborting ? ct("stopping") : ct("stop") : ct("send")} labels={[ct("send"), ct("stop"), ct("stopping")]} /></button>
      </div>

      <div tabIndex={0} className="chat-composer-status text-xs ui-color-faint" >
        <span className="min-w-0 app-text-wrap tabular-nums" title={displayModel}>{model ? displayModel : ct("empty")}</span>
        <div className="chat-status-actions">
        <span className="shrink-0 tabular-nums" role="status" aria-live="polite"><StableLabel value={conversationStatus} labels={statusLabels} /></span>
        <details className="chat-metrics-disclosure">
        <summary>{ct("metricsLabel")}</summary>
      <div tabIndex={0} className="chat-composer-metrics text-xs tabular-nums ui-color-faint" role="status" aria-label={ct("metricsLabel")}>
        {metrics ? (
          <>
            {metrics.promptTokens !== undefined && <span>{ct("metricsPrompt")} {metrics.promptTokens}</span>}
            {metrics.completionTokens !== undefined && <span>{ct("metricsCompletion")} {metrics.completionTokens}</span>}
            {metrics.firstTokenMs !== undefined && <span>{ct("metricsFirstToken")} {Math.round(metrics.firstTokenMs)} ms</span>}
            {metrics.tokensPerSecond !== undefined && <span>{metrics.tokensPerSecond.toFixed(1)} {ct("metricsTps")}</span>}
          </>
        ) : ct("empty")}
      </div>
        </details>
        </div>
      </div>
    </>
  );
}
