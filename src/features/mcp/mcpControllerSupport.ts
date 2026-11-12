import type { Dispatch, RefObject, SetStateAction } from "react";
import * as api from "../../shared/api/index";
import type { UiTextKey } from "../../shared/i18n/uiI18n";
import { updateTask } from "../../shared/state/taskRegistry";
import type { McpApprovalPolicy } from "./approvalPolicy";

export type Approval = { tool: api.McpTool; args: Record<string, unknown> };
export type ToolCall = { id: string; taskId: string; label: string; cancelRequested: boolean; settled: boolean; cancelPending?: Promise<void> };
export type DeleteConfirmation = { server: api.McpServer };
export type ServerDraft = Pick<api.McpServer, "name" | "command" | "enabled"> & { argsText: string };
export type DraftNavigation = { server: api.McpServer | null };

export interface McpController {
  servers: api.McpServer[];
  selectedId: string | null;
  name: string;
  setName: Dispatch<SetStateAction<string>>;
  command: string;
  setCommand: Dispatch<SetStateAction<string>>;
  commandEdited: boolean;
  setCommandEdited: Dispatch<SetStateAction<boolean>>;
  argsText: string;
  setArgsText: Dispatch<SetStateAction<string>>;
  enabled: boolean;
  setEnabled: Dispatch<SetStateAction<boolean>>;
  pendingNavigation: DraftNavigation | null;
  saving: boolean;
  approvalPolicy: McpApprovalPolicy;
  tools: api.McpTool[];
  toolLoading: boolean;
  error: string | null;
  setError: Dispatch<SetStateAction<string | null>>;
  notice: string | null;
  setNotice: Dispatch<SetStateAction<string | null>>;
  selectedTool: api.McpTool | null;
  setSelectedTool: Dispatch<SetStateAction<api.McpTool | null>>;
  argsJson: string;
  setArgsJson: Dispatch<SetStateAction<string>>;
  approval: Approval | null;
  setApproval: Dispatch<SetStateAction<Approval | null>>;
  approvalBusy: boolean;
  result: unknown;
  setResult: Dispatch<SetStateAction<unknown>>;
  pendingDelete: DeleteConfirmation | null;
  removingIds: Set<string>;
  deleteButtonRefs: RefObject<Record<string, HTMLButtonElement | null>>;
  approvalSectionRef: RefObject<HTMLElement | null>;
  reviewButtonRef: RefObject<HTMLButtonElement | null>;
  openDeleteDialog: (server: api.McpServer) => void;
  closeDeleteDialog: () => void;
  requestNavigation: (server: api.McpServer | null) => void;
  keepEditing: () => void;
  discardDraft: () => void;
  save: () => Promise<void>;
  doRemove: (server: api.McpServer, confirmation?: DeleteConfirmation | null) => Promise<void>;
  discoverTools: () => Promise<void>;
  prepareCall: () => void;
  approveCall: () => Promise<void>;
  cancelActiveCall: () => Promise<void>;
  changeApprovalPolicy: (policy: McpApprovalPolicy) => void;
  selectedServer: api.McpServer | undefined;
  displayMcpCommand: string;
  enabledCount: number;
  runningCall: ToolCall | null;
  resultFailed: boolean;
}

export function toolExecutionFailed(response: unknown): boolean {
  return response !== null && typeof response === "object" && "isError" in response && response.isError === true;
}

export function requestCallCancellation(call: ToolCall): Promise<void> {
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

export function newId() {
  return `mcp-${Date.now().toString(36)}`;
}

export const POLICY_LABELS: Record<McpApprovalPolicy, UiTextKey> = {
  "always-ask": "policyAlwaysAsk",
  once: "policyOnce",
  session: "policySession",
  "server-tool": "policyServerTool",
  deny: "policyDeny",
};
