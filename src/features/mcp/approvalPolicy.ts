export type McpApprovalPolicy = "always-ask" | "once" | "session" | "server-tool" | "deny";

const MCP_POLICY_KEY = "aiolm.mcp-approval-policy.v1";

export function loadMcpApprovalPolicy(): McpApprovalPolicy {
  try {
    const value = window.localStorage.getItem(MCP_POLICY_KEY);
    return value === "once" || value === "session" || value === "server-tool" || value === "deny" ? value : "always-ask";
  } catch {
    return "always-ask";
  }
}

export function saveMcpApprovalPolicy(policy: McpApprovalPolicy): void {
  try { window.localStorage.setItem(MCP_POLICY_KEY, policy); } catch { /* optional */ }
}

export function approvalKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`;
}

export function canAutoApprove(policy: McpApprovalPolicy | undefined, approved: Set<string>, key: string): boolean {
  return policy === "deny" ? false : policy === "session" || policy === "server-tool" ? approved.has(key) : false;
}
