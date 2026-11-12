import type { ChatCitation, DocumentAttachment, ImageAttachment } from './mediaTypes.ts';
import type { ChatMessage as ChatRequestMessage, ChatToolDefinition } from './types.ts';
import type { ResponseMetrics } from '../lib/metrics.ts';

export interface ChatHistoryMessage {
  role: "user" | "assistant";
  content: string;
  /** Model used for this response, captured when its request starts. */
  model?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  reasoning?: string;
  interrupted?: boolean;
  failed?: boolean;
  /** Runtime-reported termination; absent in older conversations. */
  finishReason?: string;
  /** An MCP call this reply requested was stopped or failed before its result was used. */
  toolRound?: "cancelled" | "failed";
  citations?: ChatCitation[];
  metrics?: ResponseMetrics;
  /** Only on an unfinished last reply: what Retry resends after a restart or conversation switch. */
  retry?: ChatRetrySnapshot;
}

export type ChatRetryUnavailableReason = "not-saved" | "local-instructions" | "too-large" | "tools-not-saved";

/**
 * An MCP tool a turn offered the model: which server and tool it came from and
 * the exact definition sent. It identifies the tool for Retry and grants
 * nothing, so the tool must be discovered again and every call approved again.
 */
export interface ChatRetryTool {
  serverId: string;
  serverName: string;
  toolName: string;
  definition: ChatToolDefinition;
}

/**
 * The request an unfinished reply was generated from, exactly as first
 * prepared, so Retry never rebuilds a different prompt. Local instructions
 * and skills are never written into saved conversations, so a turn that used
 * them records only why it cannot be resent once this session forgets it.
 * Auth and approvals are not part of it: a retry always uses the live session
 * and asks again before running any tool. `tools` names the MCP tools the
 * request offered; snapshots saved before it existed have none.
 */
export type ChatRetrySnapshot =
  | { version: 1; text: string; images: ImageAttachment[]; documents: DocumentAttachment[]; history: ChatRequestMessage[]; tools?: ChatRetryTool[] }
  | { version: 1; unavailable: Exclude<ChatRetryUnavailableReason, "not-saved" | "tools-not-saved"> };

export type SavedChatRetry =
  | { kind: "ready"; snapshot: Extract<ChatRetrySnapshot, { history: ChatRequestMessage[] }> }
  | { kind: "unavailable"; reason: ChatRetryUnavailableReason };

export interface ChatThread {
  id: string;
  title: string;
  systemPrompt: string;
  /** Legacy conversations keep the automatic prompt unless explicitly disabled. */
  useDefaultSystemPrompt?: boolean;
  /** Explicit model compatibility choice; legacy conversations keep text first. */
  mediaBeforeText?: boolean;
  /** Project defaults already applied; later turns keep conversation overrides. */
  projectBinding?: { id: string; updatedAt: number };
  createdAt: number;
  updatedAt: number;
  messages: ChatHistoryMessage[];
}

export interface ChatWorkspace {
  activeThreadId: string;
  threads: ChatThread[];
}

export interface ChatStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  /** Optional so test doubles only need the read/write pair. */
  removeItem?: (key: string) => void;
}

export type ChatPersistenceResult = "native" | "indexeddb" | "local" | "unavailable";
export type ChatWorkspaceClearDetail = { state: "clearing" | "failed" } | { state: "cleared"; workspace: ChatWorkspace };
