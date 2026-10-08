import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import { buildMcpFunctionNames } from "../mcp/mcpUtils";

export interface ChatMcpTool {
  serverId: string;
  serverName: string;
  tool: api.McpTool;
}

export function useChatMcpTools() {
  const [mcpCatalog, setMcpCatalog] = useState<ChatMcpTool[]>([]);
  const [selectedMcpTools, writeSelection] = useState<string[]>([]);
  const [loadingMcpTools, setLoadingMcpTools] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const catalogLoaded = useRef(false);
  const selectionExplicit = useRef(false);
  const pendingRefresh = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; pendingRefresh.current = false; }, []);
  const setSelectedMcpTools = useCallback<Dispatch<SetStateAction<string[]>>>(next => {
    selectionExplicit.current = true;
    writeSelection(next);
  }, []);

  const refreshMcpTools = async () => {
    if (pendingRefresh.current) return;
    pendingRefresh.current = true;
    const ownGeneration = generation.current;
    setLoadingMcpTools(true);
    try {
      const servers = await api.mcpListServers();
      const entries: ChatMcpTool[] = [];
      for (const server of servers.filter((item) => item.enabled)) {
        const tools = await api.mcpListTools(server.id);
        entries.push(...tools.map((tool) => ({ serverId: server.id, serverName: server.name, tool })));
      }
      if (generation.current !== ownGeneration) return;
      setMcpCatalog(entries);
      const keys = entries.map((entry) => `${entry.serverId}:${entry.tool.name}`);
      const firstCatalog = !catalogLoaded.current;
      // Loading a catalog must not broaden a project's or the user's tool selection.
      writeSelection(current => firstCatalog && !selectionExplicit.current ? keys : current.filter(key => keys.includes(key)));
      catalogLoaded.current = true;
      setMcpError(null);
    } catch (caught) {
      if (generation.current !== ownGeneration) return;
      setMcpError(`MCP tool discovery failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    } finally {
      if (generation.current === ownGeneration) {
        pendingRefresh.current = false;
        setLoadingMcpTools(false);
      }
    }
  };

  const toggleMcpTool = (key: string) => {
    setSelectedMcpTools((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  };

  const selectedMcpEntries = mcpCatalog.filter((entry) => selectedMcpTools.includes(`${entry.serverId}:${entry.tool.name}`));
  const generatedMcpNames = buildMcpFunctionNames(selectedMcpEntries.map((entry) => ({ serverId: entry.serverId, toolName: entry.tool.name })));
  const mcpEntryByFunctionName = new Map(generatedMcpNames.map((name, index) => [name, selectedMcpEntries[index]]));
  const mcpDefinitions: api.ChatToolDefinition[] = selectedMcpEntries.map((entry, index) => ({
    type: "function",
    function: {
      name: generatedMcpNames[index],
      description: entry.tool.description,
      parameters: entry.tool.input_schema && typeof entry.tool.input_schema === "object"
        ? entry.tool.input_schema
        : { type: "object", properties: {} },
    },
  }));

  return {
    mcpCatalog, selectedMcpTools, setSelectedMcpTools, loadingMcpTools, mcpError,
    refreshMcpTools, toggleMcpTool, mcpEntryByFunctionName, mcpDefinitions,
  };
}
