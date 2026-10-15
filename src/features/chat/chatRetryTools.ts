import type * as api from "../../shared/api/types";
import type { ChatRetryTool } from "./chatHistory";
import { mcpToolDefinition, type ChatMcpTool } from "./useChatMcpTools";

/** Key order differs between the browser and the data folder's JSON; content does not. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
    : item);
}

const retryToolKey = (tool: ChatRetryTool) => `${tool.serverId}:${tool.toolName}`;

/** Whether a discovered tool is still the one the saved turn offered, under the name it had then. */
function sameTool(entry: ChatMcpTool, tool: ChatRetryTool): boolean {
  return entry.serverId === tool.serverId && entry.tool.name === tool.toolName
    && canonicalJson(mcpToolDefinition(entry, tool.definition.function.name)) === canonicalJson(tool.definition);
}

/** The MCP tools a turn offered, recorded for its Retry; the skill reader is not one of them. */
export function retryTools(definitions: api.ChatToolDefinition[], entries: Map<string, ChatMcpTool>): ChatRetryTool[] {
  return definitions.flatMap((definition) => {
    const entry = entries.get(definition.function.name);
    return entry ? [{ serverId: entry.serverId, serverName: entry.serverName, toolName: entry.tool.name, definition: structuredClone(definition) }] : [];
  });
}

export type RetryToolMatch =
  | { kind: "ready"; tools: api.ChatToolDefinition[]; entries: Map<string, ChatMcpTool> }
  | { kind: "missing"; missing: ChatRetryTool[] };

/**
 * Matches a tool turn's saved tools against the tools selected now. Ready only
 * when every one is selected with an unchanged definition; the retry then
 * offers exactly those, never other selected tools.
 */
export function matchRetryTools(saved: ChatRetryTool[], definitions: api.ChatToolDefinition[], entries: Map<string, ChatMcpTool>): RetryToolMatch {
  const tools: api.ChatToolDefinition[] = [];
  const matched = new Map<string, ChatMcpTool>();
  const missing: ChatRetryTool[] = [];
  for (const tool of saved) {
    const definition = definitions.find((item) => {
      const entry = entries.get(item.function.name);
      return !!entry && item.function.name === tool.definition.function.name && sameTool(entry, tool);
    });
    if (definition) {
      tools.push(definition);
      matched.set(definition.function.name, entries.get(definition.function.name)!);
    } else missing.push(tool);
  }
  return missing.length ? { kind: "missing", missing } : { kind: "ready", tools, entries: matched };
}

export type RetryToolsState = "load" | "select" | "removed" | "changed";

/** Why a tool turn's tools are not offered now, judged from the last discovery. */
export function diagnoseRetryTools(missing: ChatRetryTool[], catalog: ChatMcpTool[], selected: string[], catalogLoaded: boolean): { state: RetryToolsState; tools: ChatRetryTool[] } {
  if (!catalogLoaded) return { state: "load", tools: missing };
  const listed = (tool: ChatRetryTool) => catalog.find((entry) => entry.serverId === tool.serverId && entry.tool.name === tool.toolName);
  const removed = missing.filter((tool) => !listed(tool));
  if (removed.length) return { state: "removed", tools: removed };
  // Selected yet unmatched, or listed with a different description or schema.
  const changed = missing.filter((tool) => selected.includes(retryToolKey(tool)) || !sameTool(listed(tool)!, tool));
  if (changed.length) return { state: "changed", tools: changed };
  return { state: "select", tools: missing };
}

/** Selection keys of the saved tools a fresh discovery offers unchanged. */
export function restorableRetryTools(missing: ChatRetryTool[], catalog: ChatMcpTool[]): string[] {
  return missing.filter((tool) => catalog.some((entry) => sameTool(entry, tool))).map(retryToolKey);
}
