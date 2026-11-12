import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import { MAX_PROJECT_DOCUMENTS, MAX_PROJECT_TOOLS, type ProjectDocument } from "./projectStore";

interface ProjectResourcesOptions {
  selectedTools: string[];
  setSelectedTools: Dispatch<SetStateAction<string[]>>;
  setDocuments: Dispatch<SetStateAction<ProjectDocument[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
}

export function useProjectResources({ selectedTools, setSelectedTools, setDocuments, setError }: ProjectResourcesOptions) {
  const [mcpCatalog, setMcpCatalog] = useState<{ serverId: string; serverName: string; toolName: string; key: string }[]>([]);
  const [mcpLoading, setMcpLoading] = useState(false);
  const { selectedToolKeys, staleTools } = useMemo(() => {
    const catalogKeys = new Set(mcpCatalog.map((entry) => entry.key));
    const selectedToolKeys = new Set(selectedTools);
    return { selectedToolKeys, staleTools: selectedTools.filter((key) => !catalogKeys.has(key)) };
  }, [mcpCatalog, selectedTools]);

  const loadMcpCatalog = async (silent: boolean) => {
    if (mcpLoading) return;
    setMcpLoading(true);
    try {
      const servers = await api.mcpListServers();
      const entries: { serverId: string; serverName: string; toolName: string; key: string }[] = [];
      for (const server of servers.filter((item) => item.enabled)) {
        const tools = await api.mcpListTools(server.id);
        for (const tool of tools) entries.push({ serverId: server.id, serverName: server.name, toolName: tool.name, key: `${server.id}:${tool.name}` });
      }
      setMcpCatalog(entries);
      if (!silent) setError(null);
    } catch (caught) {
      if (!silent) setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setMcpLoading(false);
    }
  };
  const loadMcpCatalogRef = useRef(loadMcpCatalog); loadMcpCatalogRef.current = loadMcpCatalog;

  useEffect(() => {
    // Load once; explicit refreshes use the latest catalog loader.
    void loadMcpCatalogRef.current(true);
  }, []);

  const toggleTool = (key: string) => {
    setSelectedTools((current) => current.includes(key)
      ? current.filter((item) => item !== key)
      : [...current, key].slice(0, MAX_PROJECT_TOOLS));
  };

  const addDocument = async () => {
    try {
      const path = await api.pickDocument();
      if (!path) return;
      const name = path.split(/[\\/]/).pop() || path;
      setDocuments((current) => {
        if (current.some((document) => document.path === path)) return current;
        if (current.length >= MAX_PROJECT_DOCUMENTS) return current;
        return [...current, { name, path }];
      });
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const removeDocument = (path: string) => {
    setDocuments((current) => current.filter((document) => document.path !== path));
  };

  return { mcpCatalog, mcpLoading, selectedToolKeys, staleTools, loadMcpCatalog, toggleTool, addDocument, removeDocument };
}
