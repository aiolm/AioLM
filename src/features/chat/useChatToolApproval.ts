import { useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import { isIpcErrorKind } from "../../shared/api/ipcError";
import type { ChatHistoryMessage } from "../../shared/api/conversationTypes";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { translate } from "../../shared/i18n/i18nUnified";
import type { ChatTurnSnapshot } from "./chatSendOptions";
import type { ChatPhase, FailedRequest, PendingToolCall } from "./chatSendTypes";
import { serializeMcpToolResult } from "./mcpToolResult";

export function useChatToolApproval({ phase, ctrlRef, turnGeneration, failedRef, turnRef, toolRoundsRef, skillReadsRef, releaseActivity, setAborting, setPhase, setMsgs, setError, sendFollowup, locale }: {
  phase: ChatPhase;
  ctrlRef: MutableRefObject<AbortController | null>;
  turnGeneration: MutableRefObject<number>;
  failedRef: MutableRefObject<FailedRequest | null>;
  turnRef: MutableRefObject<ChatTurnSnapshot | null>;
  toolRoundsRef: MutableRefObject<number>;
  skillReadsRef: MutableRefObject<number>;
  releaseActivity: () => void;
  setAborting: Dispatch<SetStateAction<boolean>>;
  setPhase: Dispatch<SetStateAction<ChatPhase>>;
  setMsgs: Dispatch<SetStateAction<ChatHistoryMessage[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  sendFollowup: (history: api.ChatMessage[]) => Promise<void>;
  locale: Locale;
}) {
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const [toolCallInProgress, setToolCallInProgress] = useState(false);
  const approvePendingTool = async () => {
    const pending = pendingToolCall;
    const failed = failedRef.current;
    if (!pending || !failed || phase !== "idle" || ctrlRef.current) return;
    const generation = turnGeneration.current;
    setPendingToolCall(null);
    setToolCallInProgress(true);
    setError(null);
    setPhase("preparing");
    const controller = new AbortController();
    ctrlRef.current = controller;
    // Stop (or leaving the chat) cancels the native call too: its approval
    // prompt, the tool RPC and the MCP server it started.
    const callId = crypto.randomUUID();
    const cancelCall = () => { void api.mcpCancelToolCall(callId).catch(() => undefined); };
    controller.signal.addEventListener("abort", cancelCall, { once: true });
    try {
      let result: unknown;
      try {
        result = await api.mcpCallTool(pending.serverId, pending.toolName, pending.argumentsValue, callId);
      } finally {
        controller.signal.removeEventListener("abort", cancelCall);
        if (generation === turnGeneration.current) setToolCallInProgress(false);
      }
      controller.signal.throwIfAborted();
      if (generation !== turnGeneration.current) return;
      const serializedResult = serializeMcpToolResult(result);
      const followupHistory: api.ChatMessage[] = [
        ...failed.history,
        { role: "assistant", content: "", tool_calls: [pending.call] },
        { role: "tool", tool_call_id: pending.call.id, name: pending.call.function.name, content: serializedResult },
      ];
      ctrlRef.current = null;
      await sendFollowup(followupHistory);
    } catch (caught) {
      if (generation !== turnGeneration.current) return;
      releaseActivity();
      turnRef.current = null;
      ctrlRef.current = null;
      setAborting(false);
      setPhase("idle");
      // Recorded from what the app saw, not from a finish reason the runtime may omit.
      const cancelled = controller.signal.aborted || isIpcErrorKind(caught, "cancelled");
      const toolRound = cancelled ? "cancelled" as const : "failed" as const;
      setMsgs((current) => generation === turnGeneration.current && current.at(-1)?.role === "assistant"
        ? [...current.slice(0, -1), { ...current.at(-1)!, toolRound }] : current);
      if (!cancelled) setError(translate(locale, "chat.mcpCallFailed", { error: caught instanceof Error ? caught.message : String(caught) }));
    }
  };

  const rejectPendingTool = () => {
    releaseActivity();
    turnRef.current = null;
    setPendingToolCall(null);
    failedRef.current = null;
    toolRoundsRef.current = 0;
    skillReadsRef.current = 0;
    setMsgs((current) => current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current);
    setError(translate(locale, "chat.mcpCallRejected"));
    setPhase("idle");
  };
  return { pendingToolCall, setPendingToolCall, toolCallInProgress, setToolCallInProgress, approvePendingTool, rejectPendingTool };
}
