import { useMemo, useRef } from "react";
import type { ChatToolDefinition } from "../../shared/api/types";
import type { ChatHistoryMessage as Msg } from "../../shared/api/conversationTypes";
import type { FailedRequest } from "./chatSendTypes";
import type { ChatMcpTool } from "./useChatMcpTools";
import { savedRetry, toolTurn } from "./chatRetrySnapshot";
import { matchRetryTools } from "./chatRetryTools";

export function useChatRetryState(msgs: Msg[], mcpDefinitions: ChatToolDefinition[], mcpEntryByFunctionName: Map<string, ChatMcpTool>) {
  const failedRef = useRef<FailedRequest | null>(null);
  // This session's failed turn wins; otherwise the snapshot saved with the
  // conversation's unfinished last reply survives a restart or thread switch.
  const lastMessage = msgs.at(-1);
  const supersededRef = useRef<Msg | null>(null);
  const savedForLast = useMemo(() => savedRetry(lastMessage), [lastMessage]);
  const saved = lastMessage === supersededRef.current ? null : savedForLast;
  // A turn that offered MCP tools, or already depends on one, is resent only
  // with those same tools, checked against the selection now; otherwise Retry
  // would silently drop them, even for a reply stopped before any tool call.
  const retryRequest = failedRef.current ?? (saved?.kind === "ready" ? saved.snapshot : null);
  const retryToolMatch = retryRequest && (retryRequest.tools !== undefined || toolTurn(lastMessage, retryRequest.history))
    ? matchRetryTools(retryRequest.tools ?? [], mcpDefinitions, mcpEntryByFunctionName) : null;
  const retryToolsMissing = retryToolMatch?.kind === "missing" ? retryToolMatch.missing : null;
  const canRetry = (!!failedRef.current || saved?.kind === "ready") && !retryToolsMissing;
  const retryUnavailable = !failedRef.current && saved?.kind === "unavailable" ? saved.reason : null;

  return { failedRef, lastMessage, supersededRef, saved, retryToolMatch, retryToolsMissing, canRetry, retryUnavailable };
}
