import type { DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes.ts";
import type { ChatMessage as ChatRequestMessage } from "../../shared/api/types.ts";
import type { ChatHistoryMessage, ChatRetryTool, ChatRetrySnapshot, SavedChatRetry } from "../../shared/api/conversationTypes.ts";
import { validRetrySnapshot, validToolRound } from "./chatHistorySchema.ts";

/** Serialized size of the one request snapshot a conversation keeps for Retry. */
const RETRY_SNAPSHOT_LIMIT = 1024 * 1024;

/** Records what Retry needs for a turn, or why it cannot be resent exactly after this session. */
export function chatRetrySnapshot(
  request: { text: string; images: ImageAttachment[]; documents: DocumentAttachment[]; history: ChatRequestMessage[]; tools?: ChatRetryTool[] },
  usesLocalInstructions: boolean,
): ChatRetrySnapshot {
  if (usesLocalInstructions) return { version: 1, unavailable: "local-instructions" };
  const snapshot = { version: 1 as const, text: request.text, images: request.images, documents: request.documents, history: request.history, tools: request.tools ?? [] };
  return JSON.stringify(snapshot).length > RETRY_SNAPSHOT_LIMIT ? { version: 1, unavailable: "too-large" } : snapshot;
}

/** A reply that stopped, failed or still waits on a tool, so the turn it answers is not finished. */
export function unfinishedReply(message: ChatHistoryMessage | undefined): boolean {
  return message?.role === "assistant" && (!!message.interrupted || !!message.failed || message.finishReason === "tool_calls" || validToolRound(message.toolRound));
}

/** The reply asked for a tool, or its request already carries a tool call and result, so it depends on the tools it was offered. */
export function toolTurn(message: ChatHistoryMessage | undefined, history: ChatRequestMessage[]): boolean {
  return message?.finishReason === "tool_calls" || validToolRound(message?.toolRound)
    || history.some((item) => item.role === "tool" || !!item.tool_calls?.length);
}

/** How Retry can recover the conversation's unfinished last reply from what was saved; null when nothing is unfinished. */
export function savedRetry(message: ChatHistoryMessage | undefined): SavedChatRetry | null {
  if (!unfinishedReply(message)) return null;
  const snapshot = message?.retry;
  // Replies saved before snapshots existed, or by a format this version does not know.
  if (!validRetrySnapshot(snapshot)) return { kind: "unavailable", reason: "not-saved" };
  if ("unavailable" in snapshot) return { kind: "unavailable", reason: snapshot.unavailable };
  // An earlier version saved a tool turn without its tools; resending it would silently drop them.
  if (!snapshot.tools && toolTurn(message, snapshot.history)) return { kind: "unavailable", reason: "tools-not-saved" };
  return { kind: "ready", snapshot };
}
