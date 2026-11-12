import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import { isIpcErrorKind } from "../../shared/api/ipcError";
import { useI18n } from "../../shared/i18n/i18n";
import { normalizeDisplayText } from "../../shared/lib/displayPaths";
import { finishTask, registerTask } from "../../shared/state/taskRegistry";
import { approvalKey, canAutoApprove, loadMcpApprovalPolicy, saveMcpApprovalPolicy, type McpApprovalPolicy } from "./approvalPolicy";
import { formatMcpCommand, validateMcpServerDraft } from "./mcpUtils";
import { newId, POLICY_LABELS, requestCallCancellation, toolExecutionFailed, type Approval, type DeleteConfirmation, type DraftNavigation, type McpController, type ServerDraft, type ToolCall } from "./mcpControllerSupport";

export function useMcpController(): McpController {
  const { t } = useI18n();
  const policyLabel = (policy: McpApprovalPolicy) => t(`ui.${POLICY_LABELS[policy]}`);

  const [servers, setServers] = useState<api.McpServer[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [commandEdited, setCommandEdited] = useState(false);
  const [argsText, setArgsText] = useState("");
  const [enabled, setEnabled] = useState(true);
  const draftBaseline = useRef<ServerDraft>({ name: "", command: "", argsText: "", enabled: true });
  const [pendingNavigation, setPendingNavigation] = useState<DraftNavigation | null>(null);
  const pendingNavigationRef = useRef<DraftNavigation | null>(null);
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
  const serverListGeneration = useRef(0);
  const [result, setResult] = useState<unknown>(null);
  const [pendingDelete, setPendingDelete] = useState<DeleteConfirmation | null>(null);
  const pendingDeleteRef = useRef<DeleteConfirmation | null>(null);
  const deleteDialogRevision = useRef(0);
  const removingIdsRef = useRef(new Set<string>());
  const [removingIds, setRemovingIds] = useState<Set<string>>(() => new Set());
  const removalView = useRef<{ selectedId: string | null } | null>(null);
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
    serverListGeneration.current += 1;
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

  useEffect(() => {
    const generation = ++serverListGeneration.current;
    void api.mcpListServers().then(next => {
      if (generation !== serverListGeneration.current) return;
      setServers(next);
      setError(null);
    }).catch(caught => {
      if (generation === serverListGeneration.current) setError(caught instanceof Error ? caught.message : String(caught));
    });
    return () => { serverListGeneration.current += 1; };
  }, []);

  const resetDraft = () => {
    void cancelActiveCall();
    selectionGeneration.current += 1;
    discoveryGeneration.current += 1;
    setToolLoading(false);
    setSelectedId(null);
    setName("");
    setCommand("");
    setCommandEdited(false);
    setArgsText("");
    setEnabled(true);
    draftBaseline.current = { name: "", command: "", argsText: "", enabled: true };
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
    setCommandEdited(false);
    setArgsText(server.args.join("\n"));
    setEnabled(server.enabled);
    draftBaseline.current = { name: server.name, command: server.command, argsText: server.args.join("\n"), enabled: server.enabled };
    setTools([]);
    setSelectedTool(null);
    setApproval(null);
    setResult(null);
    setError(null);
    setNotice(null);
  };

  const requestNavigation = (server: api.McpServer | null) => {
    if (server && server.id === selectedId) return;
    if (pendingNavigationRef.current) return;
    const baseline = draftBaseline.current;
    if (name !== baseline.name || command !== baseline.command || argsText !== baseline.argsText || enabled !== baseline.enabled) {
      const navigation = { server };
      pendingNavigationRef.current = navigation;
      setPendingNavigation(navigation);
      return;
    }
    if (server) selectServer(server);
    else resetDraft();
  };

  const keepEditing = () => {
    pendingNavigationRef.current = null;
    setPendingNavigation(null);
  };

  const discardDraft = () => {
    const navigation = pendingNavigationRef.current;
    if (!navigation) return;
    keepEditing();
    if (navigation.server) selectServer(navigation.server);
    else resetDraft();
  };

  const save = async () => {
    if (savingRef.current) return;
    const args = argsText.split("\n").map((arg) => arg.trim()).filter(Boolean);
    const validation = validateMcpServerDraft({ name, command, args, enabled });
    if (validation) { setError(validation); return; }
    const id = selectedId ?? newId();
    const server = { id, name: name.trim(), command: command.trim(), args, enabled };
    const savedDraft = { name, command, argsText, enabled };
    const previous = servers.find(candidate => candidate.id === id);
    const definitionChanged = !previous || previous.command !== server.command
      || previous.enabled !== enabled || JSON.stringify(previous.args) !== JSON.stringify(args);
    savingRef.current = true;
    serverListGeneration.current += 1;
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
      draftBaseline.current = savedDraft;
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
    serverListGeneration.current += 1;
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
      const cancelled = call.cancelRequested || isIpcErrorKind(caught, "cancelled");
      call.settled = true;
      finishTask(call.taskId, cancelled ? "cancelled" : "failed", cancelled ? undefined : message);
      if (activeCallRef.current !== call || generation !== selectionGeneration.current) return;
      if (cancelled) { setNotice(t("ui.taskCancelled")); setError(null); }
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

  const changeApprovalPolicy = (policy: McpApprovalPolicy) => {
    setApprovalPolicy(policy);
    saveMcpApprovalPolicy(policy);
    setApprovedCalls(new Set());
    setNotice(`${t("ui.approvalPolicy")}: ${policyLabel(policy)}`);
  };

  const selectedServer = servers.find((server) => server.id === selectedId);
  const displayMcpCommand = selectedServer
    ? formatMcpCommand(normalizeDisplayText(selectedServer.command), selectedServer.args.map(normalizeDisplayText))
    : "";

  const enabledCount = servers.filter((server) => server.enabled).length;
  const runningCall = approvalBusy ? activeCallRef.current : null;
  const resultFailed = result !== null && toolExecutionFailed(result);

  return {
    servers, selectedId, name, setName, command, setCommand, commandEdited, setCommandEdited,
    argsText, setArgsText, enabled, setEnabled, pendingNavigation, saving, approvalPolicy,
    tools, toolLoading, error, setError, notice, setNotice, selectedTool, setSelectedTool,
    argsJson, setArgsJson, approval, setApproval, approvalBusy, result, setResult,
    pendingDelete, removingIds, deleteButtonRefs, approvalSectionRef, reviewButtonRef,
    openDeleteDialog, closeDeleteDialog, requestNavigation, keepEditing, discardDraft,
    save, doRemove, discoverTools, prepareCall, approveCall, cancelActiveCall, changeApprovalPolicy,
    selectedServer, displayMcpCommand, enabledCount, runningCall, resultFailed,
  };
}
