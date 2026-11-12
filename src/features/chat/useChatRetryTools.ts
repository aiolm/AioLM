import { useRef, type Dispatch, type SetStateAction } from 'react';
import type { ChatHistoryMessage, ChatRetryTool } from '../../shared/api/conversationTypes';
import { diagnoseRetryTools, restorableRetryTools } from './chatRetryTools';
import type { ChatMcpTool } from './useChatMcpTools';

interface ChatRetryToolsOptions {
  retryToolsMissing: ChatRetryTool[] | null;
  mcpCatalog: ChatMcpTool[];
  selectedMcpTools: string[];
  mcpCatalogLoaded: boolean;
  threadId: string;
  reply: ChatHistoryMessage | undefined;
  viewingLiveThread: boolean;
  requireIdle: () => boolean;
  setSelectedMcpTools: Dispatch<SetStateAction<string[]>>;
  mcpSelectionRevision: () => number;
  refreshMcpTools: () => Promise<ChatMcpTool[] | null>;
}

export function useChatRetryTools({ retryToolsMissing, mcpCatalog, selectedMcpTools, mcpCatalogLoaded, threadId, reply, viewingLiveThread, requireIdle, setSelectedMcpTools, mcpSelectionRevision, refreshMcpTools }: ChatRetryToolsOptions) {
  const retryTools = retryToolsMissing ? diagnoseRetryTools(retryToolsMissing, mcpCatalog, selectedMcpTools, mcpCatalogLoaded) : null;
  // The conversation and unfinished reply a pending restore must still belong to.
  const retryScope = useRef({ threadId, reply });
  retryScope.current = { threadId, reply };
  // Discovers the MCP tools again and selects only the reply's tools found unchanged,
  // keeping the user's other choices; any call the retry makes is approved again.
  const restoreRetryTools = async () => {
    const missing = retryToolsMissing;
    if (!viewingLiveThread || !missing || !requireIdle()) return;
    const scope = retryScope.current;
    // This is an explicit choice, so a first discovery must not select every listed tool.
    setSelectedMcpTools(current => current);
    const revision = mcpSelectionRevision();
    const catalog = await refreshMcpTools();
    // Leaving the chat, another conversation or message, or a newer selection by
    // the user or a project wins: this restore must not land in that context.
    if (!catalog || retryScope.current.threadId !== scope.threadId || retryScope.current.reply !== scope.reply
      || mcpSelectionRevision() !== revision) return;
    const keys = restorableRetryTools(missing, catalog);
    if (keys.length) setSelectedMcpTools(current => [...current, ...keys.filter(key => !current.includes(key))]);
  };

  return { retryTools, restoreRetryTools };
}
