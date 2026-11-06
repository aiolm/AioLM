import PanelFeedback from "../../shared/ui/PanelFeedback";
import StableLabel from "../../shared/ui/StableLabel";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { formatMcpCommand, validateMcpServerDraft } from "./mcpUtils";
import FeedbackBanner from "../../shared/ui/FeedbackBanner";
import StatusBadge from "../../shared/ui/StatusBadge";
import Badge from "../../shared/ui/Badge";
import Switch from "../../shared/ui/Switch";
import EmptyState from "../../shared/ui/EmptyState";
import { CustomSelect } from "../../shared/ui/CustomSelect";
import { useI18n } from "../../shared/i18n/i18n";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import { shouldConfirmDestructive } from "../../shared/config/preferences";
import { approvalKey, canAutoApprove, loadMcpApprovalPolicy, saveMcpApprovalPolicy, type McpApprovalPolicy } from "./approvalPolicy";
import { normalizeDisplayPath, normalizeDisplayPathLines, normalizeDisplayText } from "../../shared/lib/displayPaths";
import { finishTask, registerTask, updateTask } from "../../shared/state/taskRegistry";
import { LocalTaskCancelButton } from "../../shared/ui/TaskCancellation";
import "./mcp.css";


type Approval = { tool: api.McpTool; args: Record<string, unknown> };
type ToolCall = { id: string; taskId: string; label: string; cancelRequested: boolean; settled: boolean; cancelPending?: Promise<void> };
type DeleteConfirmation = { server: api.McpServer };

function toolExecutionFailed(response: unknown): boolean {
  return response !== null && typeof response === "object" && "isError" in response && response.isError === true;
}

function requestCallCancellation(call: ToolCall): Promise<void> {
  if (call.cancelPending) return call.cancelPending;
  call.cancelRequested = true;
  updateTask(call.taskId, { state: "cancelling" });
  call.cancelPending = api.mcpCancelToolCall(call.id).catch(caught => {
    call.cancelRequested = false;
    call.cancelPending = undefined;
    if (!call.settled) updateTask(call.taskId, { state: "running", detail: caught instanceof Error ? caught.message : String(caught) });
    throw caught;
  });
  return call.cancelPending;
}

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

const McpToolSchema = memo(function McpToolSchema({ tool }: { tool: api.McpTool }) {
  const { t } = useI18n();
  const display = useMemo(() => normalizeDisplayText(JSON.stringify(tool.input_schema, null, 2)), [tool.input_schema]);
  return <pre tabIndex={0} aria-label={t("ui.inputSchema")} className="mcp-code">{display}</pre>;
});

export default function McpPanel(_props: { store: AppStore }) {
  const { t } = useI18n();
  const policyLabel = (policy: McpApprovalPolicy) => t(`ui.${POLICY_LABELS[policy]}`);

  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
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
  const activeCallRef = useRef<ToolCall | null>(null);
  const selectionGeneration = useRef(0);
  const discoveryGeneration = useRef(0);
  const [result, setResult] = useState<unknown>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteConfirmation | null>(null);
  const pendingDeleteRef = useRef<DeleteConfirmation | null>(null);
  const deleteDialogRevision = useRef(0);
  const removingIdsRef = useRef(new Set<string>());
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const removalView = useRef<{ selectedId: string | null } | null>(null);
  const deleteDialogRef = useRef<HTMLDialogElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const approvalSectionRef = useRef<HTMLElement>(null);
  const reviewButtonRef = useRef<HTMLButtonElement>(null);

  // Deletion feedback belongs to the committed view that issued it. A later
  // edit or action can own feedback without changing the selected server.
  useLayoutEffect(() => {
    const view = { selectedId };
    removalView.current = view;
    return () => { if (removalView.current === view) removalView.current = null; };
  }, [selectedId, name, command, argsText, enabled, approvalPolicy, selectedTool, argsJson, approval, approvalBusy, tools, toolLoading, result, saving, notice, error]);

  const cancelCall = async (call: ToolCall) => {
    try { await requestCallCancellation(call); }
    catch (caught) { if (activeCallRef.current === call) setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  const cancelActiveCall = async () => {
    const call = activeCallRef.current;
    if (call) await cancelCall(call);
  };

  useEffect(() => () => {
    selectionGeneration.current += 1;
    discoveryGeneration.current += 1;
    const call = activeCallRef.current;
    activeCallRef.current = null;
    pendingDeleteRef.current = null;
    deleteDialogRevision.current += 1;
    if (call) void requestCallCancellation(call).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (approval || approvalBusy) {
      window.requestAnimationFrame(() => {
        const section = approvalSectionRef.current;
        section?.focus();
        section?.scrollIntoView({ block: "center" });
      });
    }
  }, [approval, approvalBusy]);

  useEffect(() => {
    const dialog = deleteDialogRef.current;
    if (!dialog) return;
    if (pendingDelete && !dialog.open) {
      dialog.showModal();
      window.requestAnimationFrame(() => { if (pendingDeleteRef.current === pendingDelete) cancelDeleteRef.current?.focus(); });
    } else if (!pendingDelete && dialog.open) {
      dialog.close();
    }
  }, [pendingDelete]);

  const openDeleteDialog = (server: api.McpServer) => {
    const confirmation = { server };
    deleteDialogRevision.current += 1;
    pendingDeleteRef.current = confirmation;
    setPendingDelete(confirmation);
  };

  const closeDeleteConfirmation = (confirmation: DeleteConfirmation | null, restoreFocus = true) => {
    if (!confirmation || pendingDeleteRef.current !== confirmation) return;
    pendingDeleteRef.current = null;
    const revision = ++deleteDialogRevision.current;
    const focusOwner = document.activeElement;
    setPendingDelete(null);
    if (restoreFocus) window.requestAnimationFrame(() => {
      if (deleteDialogRevision.current === revision && pendingDeleteRef.current === null && document.activeElement === focusOwner) deleteButtonRefs.current[confirmation.server.id]?.focus();
    });
  };
  const closeDeleteDialog = () => closeDeleteConfirmation(pendingDeleteRef.current);

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
    void cancelActiveCall();
    selectionGeneration.current += 1;
    discoveryGeneration.current += 1;
    setToolLoading(false);
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
    void cancelActiveCall();
    selectionGeneration.current += 1;
    discoveryGeneration.current += 1;
    setToolLoading(false);
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
    setNotice(null);
  };

  const save = async () => {
    if (savingRef.current) return;
    const args = argsText.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const validation = validateMcpServerDraft({ name, command, args, enabled });
    if (validation) { setError(validation); return; }
    const id = selectedId ?? newId();
    const server = { id, name: name.trim(), command: command.trim(), args, enabled };
    const previous = servers.find(candidate => candidate.id === id);
    const definitionChanged = !previous || previous.command !== server.command
      || previous.enabled !== enabled || JSON.stringify(previous.args) !== JSON.stringify(args);
    savingRef.current = true;
    setSaving(true);
    if (definitionChanged) {
      // Metadata and remembered approvals belong to the executable definition,
      // even when the saved server ID and tool names are unchanged.
      void cancelActiveCall();
      selectionGeneration.current += 1;
      discoveryGeneration.current += 1;
      setToolLoading(false);
      setTools([]);
      setSelectedTool(null);
      setApproval(null);
      setResult(null);
      setApprovedCalls(current => new Set([...current].filter(key => !key.startsWith(`${id}:`))));
    }
    const generation = selectionGeneration.current;
    setNotice(null);
    setError(null);
    try {
      const next = await api.mcpSaveServer(server);
      setServers(next);
      if (generation !== selectionGeneration.current) return;
      setSelectedId(id);
      setNotice(t("ui.mcpSaved"));
      setError(null);
    } catch (caught) {
      if (generation === selectionGeneration.current) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const doRemove = async (server: api.McpServer, confirmation: DeleteConfirmation | null = null) => {
    if (removingIdsRef.current.has(server.id)) return;
    removingIdsRef.current.add(server.id);
    setRemovingIds(new Set(removingIdsRef.current));
    const view = removalView.current;
    try {
      const next = await api.mcpRemoveServer(server.id);
      const current = removalView.current;
      if (!current) return;
      const removedCurrentTarget = current.selectedId === server.id;
      setServers(next);
      if (removedCurrentTarget) resetDraft();
      if (removedCurrentTarget || current === view) {
        setNotice(t("ui.mcpRemoved"));
        setError(null);
      }
      const confirmationNow = pendingDeleteRef.current;
      if (confirmationNow?.server.id === server.id && !next.some(candidate => candidate.id === server.id)) {
        closeDeleteConfirmation(confirmationNow, current === view);
      }
    } catch (caught) {
      if (view && removalView.current === view) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      removingIdsRef.current.delete(server.id);
      if (removalView.current) setRemovingIds(new Set(removingIdsRef.current));
      closeDeleteConfirmation(confirmation, view !== null && removalView.current === view);
    }
  };

  const discoverTools = async () => {
    if (!selectedId || savingRef.current) return;
    const generation = ++discoveryGeneration.current;
    setToolLoading(true);
    setError(null);
    setNotice(null);
    try {
      const discovered = await api.mcpListTools(selectedId);
      if (generation !== discoveryGeneration.current) return;
      setTools(discovered);
      setNotice(t("ui.mcpToolsLoaded"));
    } catch (caught) {
      if (generation !== discoveryGeneration.current) return;
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      if (generation === discoveryGeneration.current) setToolLoading(false);
    }
  };

  const prepareCall = () => {
    if (!selectedTool || savingRef.current) return;
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
    if (!selectedId || approvalBusyRef.current || savingRef.current) return;
    const serverId = selectedId;
    const key = approvalKey(serverId, pending.tool.name);
    const generation = selectionGeneration.current;
    const id = crypto.randomUUID();
    const call: ToolCall = { id, taskId: `mcp-tool-call-${id}`, label: `${servers.find(server => server.id === serverId)?.name ?? serverId} · ${pending.tool.name}`, cancelRequested: false, settled: false };
    activeCallRef.current = call;
    registerTask({ id: call.taskId, kind: "other", label: call.label, phase: t("ui.approveRunning"), interruptible: true, cancel: () => cancelCall(call) });
    approvalBusyRef.current = true;
    setApprovalBusy(true);
    setApproval(null);
    setResult(null);
    setNotice(null);
    setError(null);
    try {
      const response = await api.mcpCallTool(serverId, pending.tool.name, pending.args, id);
      call.settled = true;
      const toolError = toolExecutionFailed(response) ? t("ui.mcpToolFailed", { name: pending.tool.name }) : null;
      finishTask(call.taskId, call.cancelRequested ? "cancelled" : toolError ? "failed" : "completed", call.cancelRequested ? undefined : toolError ?? undefined);
      if (activeCallRef.current !== call || generation !== selectionGeneration.current) return;
      if (call.cancelRequested) { setNotice(t("ui.taskCancelled")); return; }
      setResult(response);
      if (approvalPolicy === "session" || approvalPolicy === "server-tool") {
        setApprovedCalls((current) => new Set(current).add(key));
      }
      if (toolError) { setError(toolError); return; }
      setNotice(autoApproved
        ? `${t("ui.mcpAutoApproved", { policy: policyLabel(approvalPolicy) })} ${t("ui.mcpToolCompleted", { name: pending.tool.name })}`
        : t("ui.mcpToolCompleted", { name: pending.tool.name }));
      setError(null);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      call.settled = true;
      finishTask(call.taskId, call.cancelRequested ? "cancelled" : "failed", call.cancelRequested ? undefined : message);
      if (activeCallRef.current !== call || generation !== selectionGeneration.current) return;
      if (call.cancelRequested) { setNotice(t("ui.taskCancelled")); setError(null); }
      else setError(message);
    } finally {
      if (activeCallRef.current === call) {
        activeCallRef.current = null;
        approvalBusyRef.current = false;
        setApprovalBusy(false);
      }
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

  const enabledCount = servers.filter((server) => server.enabled).length;
  const runningCall = approvalBusy ? activeCallRef.current : null;
  const resultFailed = result !== null && toolExecutionFailed(result);

  return (
    <div className="app-page-scroll mcp-page">
      <header className="app-page-header"><div><h1 className="app-page-title">{t("section.mcp")}</h1><p className="app-page-description">{t("ui.mcpIntro")}</p></div></header>
      <FeedbackBanner tone="warning" className="mcp-security-note">{t("ui.mcpWarning")}</FeedbackBanner>
      <PanelFeedback>
        {error && <FeedbackBanner tone="error" title={t("panel.mcpActionFailed")} onDismiss={() => setError(null)}>{error}</FeedbackBanner>}
        {notice && <FeedbackBanner tone="success" title={t("panel.done")} onDismiss={() => setNotice(null)}>{notice}</FeedbackBanner>}
      </PanelFeedback>

      <div className="app-master-detail mcp-workspace">
        <aside className="mcp-servers" aria-labelledby="mcp-servers-title">
          <div className="mcp-servers__header">
            <div className="min-w-0">
              <h2 id="mcp-servers-title" className="mcp-heading">{t("panel.configuredServers")}</h2>
              <p className="mcp-hint">{t("ui.mcpConfigured", { count: servers.length })} · {t("ui.mcpEnabledCount", { count: enabledCount })}</p>
            </div>
            <button type="button" data-icon="add" onClick={resetDraft} className="app-button app-button--secondary app-button--sm">{t("panel.newItem")}</button>
          </div>
          {servers.length === 0
            ? <EmptyState title={t("panel.noMcpServers")} description={t("ui.mcpEmptyHint")} />
            : <ul className="mcp-server-list" aria-label={t("panel.ariaConfiguredServers")}>
              {servers.map((server) => <li key={server.id} className={`app-list-row mcp-server-row ${server.id === selectedId ? "is-selected" : ""}`}>
                <button type="button" onClick={() => selectServer(server)} aria-current={server.id === selectedId ? "true" : undefined} className="app-list-row__action mcp-server-row__select">
                  <span className="mcp-server-row__name">{normalizeDisplayText(server.name)}</span>
                  <StatusBadge label={server.enabled ? t("ui.enabled") : t("ui.disabled")} tone={server.enabled ? "success" : "neutral"} />
                </button>
                <button type="button" ref={(element) => { deleteButtonRefs.current[server.id] = element; }} onClick={() => { if (shouldConfirmDestructive()) openDeleteDialog(server); else void doRemove(server); }} aria-label={t("ui.removeNamed", { name: normalizeDisplayText(server.name) })} className="app-icon-button app-icon-button--danger"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5" /></svg></button>
              </li>)}
            </ul>}
        </aside>

        <div className="mcp-detail">
          <section className="app-card mcp-section" aria-labelledby="mcp-definition-title">
            <div className="mcp-section__header">
              <div><h2 id="mcp-definition-title" className="app-section-title">{t("ui.serverDefinition")}</h2><p className="app-section-hint">{t("ui.serverDefinitionHint")}</p></div>
              <div className="mcp-enabled"><Switch id="mcp-server-enabled" checked={enabled} onChange={setEnabled} /><label htmlFor="mcp-server-enabled">{t("ui.enabled")}</label></div>
            </div>
            <div className="grid gap-3 app-form-grid">
              <label className="mcp-field">{t("ui.fieldName")}<input value={normalizeDisplayText(name)} onChange={(event) => setName(event.target.value)} placeholder={t("ui.fieldNamePlaceholder")} className="app-input" /></label>
              <label className="mcp-field">{t("ui.fieldCommand")}<input spellCheck={false} autoCorrect="off" autoCapitalize="off" value={normalizeDisplayPath(command)} onChange={(event) => setCommand(event.target.value)} placeholder="npx or C:\\Tools\\server.exe" className="app-input font-mono" /></label>
            </div>
            <label className="mcp-field">{t("ui.fieldArgs")}<textarea spellCheck={false} autoCorrect="off" autoCapitalize="off" value={normalizeDisplayPathLines(argsText)} onChange={(event) => setArgsText(event.target.value)} rows={4} placeholder={"-y\n@modelcontextprotocol/server-filesystem\nC:\\Documents"} className="app-textarea app-mono" /></label>
            <div className="mcp-actions">
              {selectedServer && <code className="mcp-command-preview" title={displayMcpCommand}>{displayMcpCommand}</code>}
              <button type="button" onClick={() => void save()} disabled={saving} aria-busy={saving} className="app-button app-button--primary">{t("ui.saveServer")}</button>
            </div>
          </section>

          <div className="app-card mcp-policy">
            <label htmlFor="mcp-approval-policy">{t("ui.approvalPolicy")}</label>
            <CustomSelect id="mcp-approval-policy" value={approvalPolicy} options={[{ value: "always-ask", label: t("ui.policyAlwaysAsk") }, { value: "once", label: t("ui.policyOnce") }, { value: "session", label: t("ui.policySession") }, { value: "server-tool", label: t("ui.policyServerTool") }, { value: "deny", label: t("ui.policyDeny") }]} onChange={(val) => { const nextPolicy = val as McpApprovalPolicy; setApprovalPolicy(nextPolicy); saveMcpApprovalPolicy(nextPolicy); setApprovedCalls(new Set()); setNotice(`${t("ui.approvalPolicy")}: ${policyLabel(nextPolicy)}`); }} />
          </div>

          {selectedServer && <section className="app-card mcp-section" aria-labelledby="mcp-tools-title">
            <div className="mcp-section__header">
              <div><h2 id="mcp-tools-title" className="app-section-title">{t("ui.toolsTitle")}{tools.length > 0 && <Badge>{tools.length}</Badge>}</h2><p className="app-section-hint">{t("ui.toolsHint")}</p></div>
              <button type="button" data-icon="probe" onClick={() => void discoverTools()} disabled={saving || toolLoading || !selectedServer.enabled} className="app-button app-button--secondary"><StableLabel value={toolLoading ? t("ui.discovering") : t("ui.discoverTools")} labels={[t("ui.discovering"), t("ui.discoverTools")]} /></button>
            </div>
            {tools.length === 0
              ? <p className="mcp-hint">{t("ui.discoverToolsHint")}</p>
              : <ul className="mcp-tool-list">{tools.map((tool) => <li key={tool.name} className={`app-list-row mcp-tool ${selectedTool?.name === tool.name ? "is-selected" : ""}`}>
                <div className="mcp-tool__head">
                  <div className="min-w-0"><code className="mcp-tool__name">{normalizeDisplayText(tool.name)}</code><p className="mcp-hint">{normalizeDisplayText(tool.description || t("ui.noToolDescription"))}</p></div>
                  <button type="button" disabled={saving} onClick={() => { setSelectedTool(tool); setArgsJson("{}\n"); setApproval(null); setResult(null); }} aria-label={`${t("ui.prepareCall")}: ${normalizeDisplayText(tool.name)}`} className="app-button app-button--secondary app-button--sm">{t("ui.prepareCall")}</button>
                </div>
                {selectedTool?.name === tool.name && <div className="mcp-call">
                  <label className="mcp-field">{t("ui.jsonArguments")}<textarea spellCheck={false} autoCorrect="off" autoCapitalize="off" value={normalizeDisplayText(argsJson)} onChange={(event) => setArgsJson(event.target.value)} rows={4} className="app-textarea app-mono" /></label>
                  <details className="mcp-schema"><summary>{t("ui.inputSchema")}</summary><McpToolSchema tool={tool} /></details>
                  <div><button ref={reviewButtonRef} type="button" onClick={prepareCall} disabled={saving} className="app-button app-button--primary">{t("ui.reviewToolCall")}</button></div>
                </div>}
              </li>)}</ul>}
          </section>}

          {approval && selectedServer && <section ref={approvalSectionRef} tabIndex={-1} className="app-card app-card--warning mcp-section mcp-focus-target" role="alert" aria-labelledby="mcp-approval-title">
            <div><h2 id="mcp-approval-title" className="app-section-title">{t("ui.approveTitle")}</h2><p className="app-section-hint">{t("ui.approveBody", { tool: normalizeDisplayText(approval.tool.name), server: normalizeDisplayText(selectedServer.name) })}</p></div>
            <pre tabIndex={0} aria-label={t("ui.approveTitle")} className="mcp-code">{normalizeDisplayText(JSON.stringify(approval.args, null, 2))}</pre>
            <div className="mcp-button-row">
              <button type="button" disabled={saving || approvalBusy} onClick={() => void approveCall()} className="app-button app-button--primary"><StableLabel value={approvalBusy ? t("ui.approveRunning") : t("ui.approveRun")} labels={[t("ui.approveRunning"), t("ui.approveRun")]} /></button>
              <button type="button" disabled={approvalBusy} onClick={() => { setApproval(null); reviewButtonRef.current?.focus(); }} className="app-button app-button--secondary">{t("panel.cancel")}</button>
            </div>
          </section>}

          {runningCall && <section ref={approvalSectionRef} tabIndex={-1} className="app-card mcp-running mcp-focus-target" role="status">
            <span className="mcp-running__label">{t("ui.approveRunning")}: {normalizeDisplayText(runningCall.label)}</span>
            <LocalTaskCancelButton taskId={runningCall.taskId} onClick={() => void cancelActiveCall()}>{t("panel.cancel")}</LocalTaskCancelButton>
          </section>}

          {result !== null && <section className={resultFailed ? "app-card mcp-section" : "app-card app-card--success mcp-section"}>
            <h2 id="mcp-result-title" className={`app-section-title ${resultFailed ? "text-error" : "text-success"}`}>{t("ui.toolResult")}</h2>
            <pre tabIndex={0} aria-label={t("ui.toolResult")} className="mcp-code mcp-code--tall">{normalizeDisplayText(typeof result === "string" ? result : JSON.stringify(result, null, 2))}</pre>
          </section>}
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
            {t("ui.deleteServerBody", { name: normalizeDisplayText(pendingDelete?.server.name ?? "") })}
          </p>
          <div className="app-confirm-dialog__actions">
            <button type="button" ref={cancelDeleteRef} className="app-button app-button--secondary" onClick={closeDeleteDialog}>{t("panel.cancel")}</button>
            <button type="button" className="app-button app-button--danger" disabled={pendingDelete !== null && removingIds.has(pendingDelete.server.id)} aria-busy={pendingDelete !== null && removingIds.has(pendingDelete.server.id)} onClick={() => pendingDelete && void doRemove(pendingDelete.server, pendingDelete)}>{t("ui.deleteServer")}</button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
