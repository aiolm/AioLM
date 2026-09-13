import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { formatMcpCommand, validateMcpServerDraft } from "./mcpUtils";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import StatusBadge from "../../shared/ui/StatusBadge";
import EmptyState from "../../shared/ui/EmptyState";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { useI18n } from "../../shared/i18n/i18n";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { approvalKey, canAutoApprove, loadMcpApprovalPolicy, saveMcpApprovalPolicy, type McpApprovalPolicy } from "./approvalPolicy";
import { normalizeDisplayPath, normalizeDisplayPathLines, normalizeDisplayText } from "../../shared/lib/displayPaths";


type Approval = { tool: api.McpTool; args: Record<string, unknown> };

function newId() {
  return `mcp-${Date.now().toString(36)}`;
}

const POLICY_LABELS: Record<McpApprovalPolicy, UiTextKey> = {
  "always-ask": "policyAlwaysAsk",
  once: "policyOnce",
  session: "policySession",
  "server-tool": "policyServerTool",
  deny: "policyDeny",
};

export default function McpPanel(_props: { store: AppStore }) {
  const { t } = useI18n();
  const policyLabel = (policy: McpApprovalPolicy) => t(`ui.${POLICY_LABELS[policy]}`);

  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [approvalPolicy, setApprovalPolicy] = useState<McpApprovalPolicy>(() => loadMcpApprovalPolicy());
  const [approvedCalls, setApprovedCalls] = useState<Set<string>>(() => new Set());
  const [tools, setTools] = useState<api.McpTool[]>([]);
  const [toolLoading, setToolLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [selectedTool, setSelectedTool] = useState<api.McpTool | null>(null);
  const [argsJson, setArgsJson] = useState("{}\n");
  const [approval, setApproval] = useState<Approval | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const approvalBusyRef = useRef(false);
  const [result, setResult] = useState<unknown>(null);
  const [pendingDelete, setPendingDelete] = useState<api.McpServer | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const approvalSectionRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (approval) {
      window.requestAnimationFrame(() => approvalSectionRef.current?.focus());
    }
  }, [approval]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (pendingDelete && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => cancelDeleteRef.current?.focus());
    } else if (!pendingDelete && dialog.open) {
      dialog.close();
    }
  }, [pendingDelete]);

  const closeDeleteDialog = () => {
    const serverId = pendingDelete?.id;
    setPendingDelete(null);
    if (serverId) window.requestAnimationFrame(() => deleteButtonRefs.current[serverId]?.focus());
  };

  const loadServers = async () => {
    try {
      setServers(await api.mcpListServers());
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  useEffect(() => { void loadServers(); }, []);

  const resetDraft = () => {
    setSelectedId(null);
    setName("");
    setCommand("");
    setArgsText("");
    setEnabled(true);
    setApprovalPolicy(loadMcpApprovalPolicy());
    setApprovedCalls(new Set());
    setTools([]);
    setSelectedTool(null);
    setApproval(null);
    setResult(null);
    setNotice(null);
    setError(null);
  };

  const selectServer = (server: api.McpServer) => {
    setSelectedId(server.id);
    setName(server.name);
    setCommand(server.command);
    setArgsText(server.args.join("\n"));
    setEnabled(server.enabled);
    setTools([]);
    setSelectedTool(null);
    setApproval(null);
    setResult(null);
    setError(null);
  };

  const save = async () => {
    const args = argsText.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const validation = validateMcpServerDraft({ name, command, args, enabled });
    if (validation) { setError(validation); return; }
    const id = selectedId ?? newId();
    try {
      const next = await api.mcpSaveServer({ id, name: name.trim(), command: command.trim(), args, enabled });
      setServers(next);
      setSelectedId(id);
      setNotice(t("ui.mcpSaved"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const doRemove = async (server: api.McpServer) => {
    try {
      setServers(await api.mcpRemoveServer(server.id));
      if (selectedId === server.id) resetDraft();
      setNotice(t("ui.mcpRemoved"));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setPendingDelete(null);
      window.requestAnimationFrame(() => deleteButtonRefs.current[server.id]?.focus());
    }
  };

  const discoverTools = async () => {
    if (!selectedId) return;
    setToolLoading(true);
    setError(null);
    setNotice(null);
    try {
      setTools(await api.mcpListTools(selectedId));
      setNotice(t("ui.mcpToolsLoaded"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setToolLoading(false);
    }
  };

  const prepareCall = () => {
    if (!selectedTool) return;
    let parsedArgs: Record<string, unknown>;
    try {
      const parsed = JSON.parse(argsJson) as unknown;
      if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") throw new Error(t("ui.mcpArgsObject"));
      parsedArgs = parsed as Record<string, unknown>;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("ui.mcpArgsInvalid"));
      return;
    }
    setError(null);
    setResult(null);
    if (approvalPolicy === "deny") {
      setError(t("ui.mcpBlockedByPolicy"));
      return;
    }
    const pending = { tool: selectedTool, args: parsedArgs };
    // A "session"/"server-tool" policy only skips the prompt once this exact
    // server+tool pair has been approved by hand at least once.
    if (selectedId && canAutoApprove(approvalPolicy, approvedCalls, approvalKey(selectedId, selectedTool.name))) {
      void runToolCall(pending, true);
      return;
    }
    setApproval(pending);
  };

  const runToolCall = async (pending: Approval, autoApproved: boolean) => {
    if (!selectedId || approvalBusyRef.current) return;
    const serverId = selectedId;
    const key = approvalKey(serverId, pending.tool.name);
    approvalBusyRef.current = true;
    setApprovalBusy(true);
    setApproval(null);
    try {
      setResult(await api.mcpCallTool(serverId, pending.tool.name, pending.args));
      if (approvalPolicy === "session" || approvalPolicy === "server-tool") {
        setApprovedCalls((current) => new Set(current).add(key));
      }
      setNotice(autoApproved
        ? `${t("ui.mcpAutoApproved", { policy: policyLabel(approvalPolicy) })} ${t("ui.mcpToolCompleted", { name: pending.tool.name })}`
        : t("ui.mcpToolCompleted", { name: pending.tool.name }));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      approvalBusyRef.current = false;
      setApprovalBusy(false);
    }
  };

  const approveCall = async () => {
    if (!approval) return;
    await runToolCall(approval, false);
  };

  const selectedServer = servers.find((server) => server.id === selectedId);
  const displayMcpCommand = selectedServer
    ? formatMcpCommand(normalizeDisplayText(selectedServer.command), selectedServer.args.map(normalizeDisplayText))
    : "";

  return (
    <div className="app-page-scroll relative flex h-full min-h-0 flex-col overflow-auto p-4">
      <div className="mb-4"><h2 className="text-xl font-semibold tracking-tight text-ink">{t("section.mcp")}</h2><p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted">{t("ui.mcpIntro")}</p></div>
      <div className="mb-4 rounded-lg border border-warning-line bg-warning-soft/30 px-3.5 py-2.5 text-xs leading-relaxed text-warning">{t("ui.mcpWarning")}</div>
      <div className="mb-4 grid gap-3 app-summary-grid" role="group" aria-label={t("panel.ariaConfiguredServers")}>
        <div className="flex flex-col justify-center rounded-lg border border-line bg-surface/50 p-3.5"><div className="text-xs uppercase tracking-wide text-muted">{t("ui.mcpServersCount")}</div><div className="mt-1 text-sm font-medium text-ink">{t("ui.mcpConfigured", { count: servers.length })}</div></div>
        <div className="flex flex-col justify-center rounded-lg border border-line bg-surface/50 p-3.5"><div className="text-xs uppercase tracking-wide text-muted">{t("ui.enabled")}</div><div className="mt-1"><StatusBadge label={t("ui.mcpEnabledCount", { count: servers.filter((server) => server.enabled).length })} tone={servers.some((server) => server.enabled) ? "success" : "neutral"} /></div></div>
        <div className="flex flex-col justify-center rounded-lg border border-line bg-surface/50 p-3.5"><div className="text-xs uppercase tracking-wide text-muted">{t("ui.mcpApproval")}</div><div className="mt-1 text-sm font-medium text-warning">{policyLabel(approvalPolicy)}</div></div>
      </div>
      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("panel.mcpActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>

      <div className="grid min-h-0 gap-4 app-master-detail">
        <aside className="rounded-xl border border-line bg-surface/50 p-3"><div className="flex items-center justify-between gap-2"><h3 className="app-section-title">{t("panel.configuredServers")}</h3><button type="button" onClick={resetDraft} className="app-button app-button--secondary app-button--sm">{t("panel.newItem")}</button></div><div className="mt-3 space-y-1.5">{servers.length === 0 && <EmptyState title={t("panel.noMcpServers")} description={t("ui.mcpEmptyHint")} />}{servers.map((server) => <div key={server.id} className={`app-list-row flex items-center justify-between gap-1 px-1 py-1 ${server.id === selectedId ? "is-selected" : ""}`}><button type="button" onClick={() => selectServer(server)} aria-current={server.id === selectedId ? "true" : undefined} className="min-w-0 flex-1 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"><span className="block app-text-wrap text-xs font-medium text-ink">{normalizeDisplayText(server.name)}</span><span className={`mt-0.5 block text-xs ${server.enabled ? "text-success" : "text-faint"}`}>{server.enabled ? t("ui.enabled") : t("ui.disabled")}</span></button><button type="button" ref={(element) => { deleteButtonRefs.current[server.id] = element; }} onClick={() => { if (shouldConfirmDestructive()) setPendingDelete(server); else void doRemove(server); }} aria-label={t("ui.removeNamed", { name: normalizeDisplayText(server.name) })} className="app-icon-button app-icon-button--danger mr-1"><svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M3 3 9 9M9 3 3 9" /></svg></button></div>)}</div></aside>

        <div className="min-w-0 space-y-4"><section className="rounded-xl border border-line bg-surface/50 p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.serverDefinition")}</h3><p className="app-section-hint">{t("ui.serverDefinitionHint")}</p></div><label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} className="accent-fuchsia-500" /> {t("ui.enabled")}</label></div><div className="mt-3.5 grid gap-3 app-form-grid"><label className="text-xs text-muted">{t("ui.fieldName")}<input value={normalizeDisplayText(name)} onChange={(event) => setName(event.target.value)} placeholder={t("ui.fieldNamePlaceholder")} className="app-input mt-1" /></label><label className="text-xs text-muted">{t("ui.fieldCommand")}<input value={normalizeDisplayPath(command)} onChange={(event) => setCommand(event.target.value)} placeholder="npx or C:\\Tools\\server.exe" className="app-input mt-1 font-mono" /></label></div><label className="mt-3.5 block text-xs text-muted">{t("ui.fieldArgs")}<textarea value={normalizeDisplayPathLines(argsText)} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="app-textarea mt-1 app-mono" /></label><div className="mt-4 flex flex-wrap items-center gap-2.5"><div className="flex items-center gap-2 text-xs text-muted"><span>{t("ui.approvalPolicy")}</span><CustomSelect ariaLabel={t("ui.approvalPolicy")} value={approvalPolicy} options={[{ value: "always-ask", label: t("ui.policyAlwaysAsk") }, { value: "once", label: t("ui.policyOnce") }, { value: "session", label: t("ui.policySession") }, { value: "server-tool", label: t("ui.policyServerTool") }, { value: "deny", label: t("ui.policyDeny") }]} onChange={(val) => { const nextPolicy = val as McpApprovalPolicy; setApprovalPolicy(nextPolicy); saveMcpApprovalPolicy(nextPolicy); setApprovedCalls(new Set()); setNotice(`${t("ui.approvalPolicy")}: ${policyLabel(nextPolicy)}`); }} size="sm" triggerClassName="w-[140px]" /></div><button type="button" onClick={() => void save()} className="app-button app-button--primary app-button--sm">{t("ui.saveServer")}</button>{selectedServer && <><code className="max-w-full app-text-wrap rounded bg-canvas px-2.5 py-1.5 font-mono text-xs text-muted" title={displayMcpCommand}>{displayMcpCommand}</code><button type="button" onClick={() => void discoverTools()} disabled={toolLoading || !selectedServer.enabled} className="app-button app-button--secondary app-button--sm"><StableLabel value={toolLoading ? t("ui.discovering") : t("ui.discoverTools")} labels={[t("ui.discovering"), t("ui.discoverTools")]} /></button></>}</div></section>

          {selectedServer && <section className="rounded-xl border border-line bg-surface/50 p-4"><div className="flex items-start justify-between gap-3"><div><h3 className="app-section-title">{t("ui.toolsTitle")} {tools.length > 0 && <span className="text-accent">· {tools.length}</span>}</h3><p className="app-section-hint">{t("ui.toolsHint")}</p></div><span className="rounded bg-warning-soft px-2.5 py-1 text-xs text-warning">{t("ui.approvalRequiredBadge")}</span></div>{tools.length === 0 && <p className="mt-4 text-sm text-faint">{t("ui.discoverToolsHint")}</p>}<div className="mt-3.5 space-y-2.5">{tools.map((tool) => <div key={tool.name} className={`app-list-row p-3.5 ${selectedTool?.name === tool.name ? "is-selected" : "border-line bg-canvas/50"}`}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><code className="font-mono text-xs text-accent">{normalizeDisplayText(tool.name)}</code><p className="mt-1 text-xs leading-relaxed text-muted">{normalizeDisplayText(tool.description || t("ui.noToolDescription"))}</p></div><button type="button" onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} aria-label={`${t("ui.prepareCall")}: ${normalizeDisplayText(tool.name)}`} className="app-button app-button--secondary app-button--sm">{t("ui.prepareCall")}</button></div>{selectedTool?.name === tool.name && <div className="mt-3.5 border-t border-line pt-3.5"><label className="block text-xs text-muted">{t("ui.jsonArguments")}<textarea value={normalizeDisplayText(argsJson)} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="app-textarea mt-1 app-mono" /></label><details className="mt-2.5"><summary className="cursor-pointer text-xs text-faint">{t("ui.inputSchema")}</summary><pre tabIndex={0} aria-label={t("ui.inputSchema")} className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-canvas p-2 font-mono text-xs text-faint">{normalizeDisplayText(JSON.stringify(tool.input_schema, null, 2))}</pre></details><button type="button" onClick={prepareCall} className="app-button app-button--primary app-button--sm mt-3.5">{t("ui.reviewToolCall")}</button></div>}</div>)}</div></section>}

          {approval && selectedServer && <section ref={approvalSectionRef} tabIndex={-1} className="rounded-xl border border-warning-line bg-warning-soft/30 p-4 focus:outline-none" role="alert"><h3 className="app-section-title text-warning">{t("ui.approveTitle")}</h3><p className="app-section-hint text-warning/80">{t("ui.approveBody", { tool: normalizeDisplayText(approval.tool.name), server: normalizeDisplayText(selectedServer.name) })}</p><pre tabIndex={0} aria-label={t("ui.approveTitle")} className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas p-3 font-mono text-xs text-ink">{normalizeDisplayText(JSON.stringify(approval.args, null, 2))}</pre><div className="mt-3.5 flex gap-2"><button type="button" disabled={approvalBusy} onClick={() => void approveCall()} className="app-button app-button--primary app-button--sm"><StableLabel value={approvalBusy ? t("ui.approveRunning") : t("ui.approveRun")} labels={[t("ui.approveRunning"), t("ui.approveRun")]} /></button><button type="button" disabled={approvalBusy} onClick={() => setApproval(null)} className="app-button app-button--secondary app-button--sm">{t("panel.cancel")}</button></div></section>}
          {result !== null && <section className="rounded-xl border app-border-success bg-success-soft/20 p-4"><h3 className="app-section-title text-success">{t("ui.toolResult")}</h3><pre tabIndex={0} aria-label={t("ui.toolResult")} className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-canvas p-3 font-mono text-xs text-ink">{normalizeDisplayText(typeof result === "string" ? result : JSON.stringify(result, null, 2))}</pre></section>}
        </div>
      </div>

      <dialog
        ref={deleteDialogRef}
        className="app-confirm-dialog"
        aria-labelledby="mcp-delete-title"
        aria-describedby="mcp-delete-description"
        onCancel={(event) => { event.preventDefault(); closeDeleteDialog(); }}
      >
        <div className="app-confirm-dialog__panel">
          <div className="app-confirm-dialog__eyebrow">{t("ui.destructiveAction")}</div>
          <h2 id="mcp-delete-title">{t("ui.deleteServerTitle")}</h2>
          <p id="mcp-delete-description">
            {t("ui.deleteServerBody", { name: normalizeDisplayText(pendingDelete?.name ?? "") })}
          </p>
          <div className="app-confirm-dialog__actions">
            <button type="button" ref={cancelDeleteRef} className="app-button app-button--secondary" onClick={closeDeleteDialog}>{t("panel.cancel")}</button>
            <button type="button" className="app-button app-button--danger" onClick={() => pendingDelete && void doRemove(pendingDelete)}>{t("ui.deleteServer")}</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
