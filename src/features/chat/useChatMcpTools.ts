import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import { buildMcpFunctionNames } from "../mcp/mcpUtils";

export interface ChatMcpTool {
  serverId: string;
  serverName: string;
  tool: api.McpTool;
}

/** The function definition a selected MCP tool is offered to the model as. */
export function mcpToolDefinition(entry: ChatMcpTool, name: string): api.ChatToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: entry.tool.description,
      parameters: entry.tool.input_schema && typeof entry.tool.input_schema === "object"
        ? entry.tool.input_schema
        : { type: "object", properties: {} },
    },
  };
}

export function useChatMcpTools() {
  const [mcpCatalog, setMcpCatalog] = useState<ChatMcpTool[]>([]);
  const [mcpCatalogLoaded, setMcpCatalogLoaded] = useState(false);
  const [selectedMcpTools, writeSelection] = useState<string[]>([]);
  const [loadingMcpTools, setLoadingMcpTools] = useState(false);
  const [mcpError, setMcpError] = useState<string | null>(null);
  const catalogLoaded = useRef(false);
  const selectionExplicit = useRef(false);
  /** Counts explicit selection writes (user or project); discovery's own pruning does not count. */
  const selectionRevision = useRef(0);
  const pendingRefresh = useRef(false);
  const generation = useRef(0);
  useEffect(() => () => { generation.current += 1; pendingRefresh.current = false; }, []);
  const setSelectedMcpTools = useCallback<Dispatch<SetStateAction<string[]>>>(next => {
    selectionExplicit.current = true;
    selectionRevision.current += 1;
    writeSelection(next);
  }, []);
  const mcpSelectionRevision = useCallback(() => selectionRevision.current, []);

  /** Resolves to the discovered catalog, or null when discovery failed or was superseded. */
  const refreshMcpTools = async (): Promise<ChatMcpTool[] | null> => {
    if (pendingRefresh.current) return null;
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
      if (generation.current !== ownGeneration) return null;
      setMcpCatalog(entries);
      const keys = entries.map((entry) => `${entry.serverId}:${entry.tool.name}`);
      const firstCatalog = !catalogLoaded.current;
      // Loading a catalog must not broaden a project's or the user's tool selection.
      writeSelection(current => firstCatalog && !selectionExplicit.current ? keys : current.filter(key => keys.includes(key)));
      catalogLoaded.current = true;
      setMcpCatalogLoaded(true);
      setMcpError(null);
      return entries;
    } catch (caught) {
      if (generation.current !== ownGeneration) return null;
      setMcpError(`MCP tool discovery failed: ${caught instanceof Error ? caught.message : String(caught)}`);
      return null;
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

  const { mcpEntryByFunctionName, mcpDefinitions } = useMemo(() => {
    const selectedKeys = new Set(selectedMcpTools);
    const selectedMcpEntries = mcpCatalog.filter((entry) => selectedKeys.has(`${entry.serverId}:${entry.tool.name}`));
    const generatedMcpNames = buildMcpFunctionNames(selectedMcpEntries.map((entry) => ({ serverId: entry.serverId, toolName: entry.tool.name })));
    return {
      mcpEntryByFunctionName: new Map(generatedMcpNames.map((name, index) => [name, selectedMcpEntries[index]])),
      mcpDefinitions: selectedMcpEntries.map((entry, index) => mcpToolDefinition(entry, generatedMcpNames[index])),
    } satisfies { mcpEntryByFunctionName: Map<string, ChatMcpTool>; mcpDefinitions: api.ChatToolDefinition[] };
  }, [mcpCatalog, selectedMcpTools]);

  return {
    mcpCatalog, mcpCatalogLoaded, selectedMcpTools, setSelectedMcpTools, mcpSelectionRevision, loadingMcpTools, mcpError,
    refreshMcpTools, toggleMcpTool, mcpEntryByFunctionName, mcpDefinitions,
  };
}
