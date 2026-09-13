import { useEffect, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, trimChatHistory, type DocumentAttachment, type ImageAttachment } from "./chatUtils";
import type { ChatHistoryMessage, ChatThread } from "./chatHistory";
import { QWEN38_DEFAULTS } from "../../shared/config/qwenDefaults";
import type { ModelProfile } from "../profiles/modelProfiles";
import { appliedProfile, requestProfileFromApplication } from "../model-settings/profileEditor";
import { usesRuntimeDefault } from "../../shared/config/tuningDefaults";
import type { AppPreferences } from "../../shared/config/preferences";
import { buildResponseMetrics } from "../../shared/lib/metrics";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { FailedRequest, PendingToolCall, RequestMetricsAccumulator, StreamingDraft } from "./chatSendTypes";
import { createStreamDeltaHandler, resolveDetectedToolCall, retrieveDocumentContext, sameDocuments, sameImages, toChatMessage } from "./chatSendHelpers";
import { setSessionActivity } from "../../shared/state/sessionActivity";

export type { PendingToolCall } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

interface UseChatSendOptions {
  store: AppStore;
  effectiveConfig?: api.AppConfig | null;
  modelProfile?: ModelProfile | null;
  sessionId?: string;
  preferences?: AppPreferences;
  baseUrl: string | null;
  apiKey: string;
  model: string;
  activeThread: ChatThread | undefined;
  msgs: Msg[];
  setMsgs: Dispatch<SetStateAction<Msg[]>>;
  input: string;
  setInput: (value: string) => void;
  attachments: ImageAttachment[];
  documents: DocumentAttachment[];
  setAttachments: Dispatch<SetStateAction<ImageAttachment[]>>;
  setDocuments: Dispatch<SetStateAction<DocumentAttachment[]>>;
  mcpEntryByFunctionName: Map<string, ChatMcpTool>;
  mcpDefinitions: api.ChatToolDefinition[];
  atBottomRef: MutableRefObject<boolean>;
  phase: "idle" | "thinking" | "streaming";
  setPhase: Dispatch<SetStateAction<"idle" | "thinking" | "streaming">>;
}

// Streaming updates land in `streamingDraft` instead of `msgs` so the hot rAF path never
// clones the full message array; the draft is flushed into `msgs` once per stream
// (completion, tool call, or error), not once per animation frame, and any still-pending
// rAF is cancelled at each of those terminal transitions to avoid a redundant flush.
export function useChatSend({
  store, effectiveConfig, modelProfile, sessionId = "default", preferences, baseUrl, apiKey, model, activeThread, msgs, setMsgs,
  input, setInput, attachments, documents, setAttachments, setDocuments,
  mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
}: UseChatSendOptions) {
  const [error, setError] = useState<string | null>(null);
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const [contextSources, setContextSources] = useState<string[]>([]);
  const [aborting, setAborting] = useState(false);
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const [streamingDraft, setStreamingDraft] = useState<StreamingDraft | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const failedRef = useRef<FailedRequest | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const streamRef = useRef<{ assistant: string; reasoning: string; toolCalls: api.ChatToolCall[] }>({ assistant: "", reasoning: "", toolCalls: [] });
  const metricsRef = useRef<RequestMetricsAccumulator>({ preparationStartedAt: 0 });
  const streamResponsesRef = useRef(true);
  const toolRoundsRef = useRef(0);
  const turnRef = useRef<{
    config: api.AppConfig | null;
    baseUrl: string;
    apiKey: string;
    model: string;
    sessionId: string;
    systemPrompt: string;
    tools: api.ChatToolDefinition[];
    toolEntries: Map<string, ChatMcpTool>;
  } | null>(null);
  const activityRef = useRef<{ sessionId: string; started: boolean } | null>(null);
  const releaseActivity = () => {
    const activity = activityRef.current;
    activityRef.current = null;
    if (!activity) return;
    setSessionActivity(activity.sessionId, false);
    if (activity.started) void api.serverActivity("end", activity.sessionId).catch(() => undefined);
  };
  // MCP follow-up sends carry no documents of their own, so this tracks whether the
  // turn's original message hit the search limit and keeps that warning visible
  // across follow-up rounds until a new user message (or thread switch) resets it.
  const documentTruncationRef = useRef(false);

  useEffect(() => () => {
    ctrlRef.current?.abort();
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
    const activity = activityRef.current;
    activityRef.current = null;
    if (activity) {
      setSessionActivity(activity.sessionId, false);
      if (activity.started) void api.serverActivity("end", activity.sessionId).catch(() => undefined);
    }
  }, []);

  const cancelScheduledRender = () => {
    if (renderFrameRef.current !== null) {
      window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
    }
  };

  const snapshotMetrics = (now = performance.now()) => {
    const current = metricsRef.current;
    if (current.requestStartedAt === undefined) return undefined;
    return buildResponseMetrics(current.usage, current.timings, {
      preparationMs: current.requestStartedAt - current.preparationStartedAt,
      firstTokenMs: current.firstTokenAt === undefined ? undefined : current.firstTokenAt - current.requestStartedAt,
      requestMs: now - current.requestStartedAt,
    });
  };

  const scheduleAssistantRender = () => {
    if (renderFrameRef.current !== null) return;
    renderFrameRef.current = window.requestAnimationFrame(() => {
      renderFrameRef.current = null;
      const { assistant, reasoning } = streamRef.current;
      setStreamingDraft({
        content: streamResponsesRef.current ? assistant : "",
        reasoning: streamResponsesRef.current ? reasoning : "",
        metrics: snapshotMetrics(),
      });
    });
  };

  const resetChatState = () => {
    cancelScheduledRender();
    setStreamingDraft(null);
    setError(null);
    documentTruncationRef.current = false;
    setContextWarning(null);
    setContextSources([]);
  };

  const send = async (retry = false, historyOverride?: api.ChatMessage[], canSend = true) => {
    if (ctrlRef.current || (!historyOverride && (!baseUrl || pendingToolCall))) return;
    const toolFollowup = !!historyOverride;
    const failed = failedRef.current;
    const text = toolFollowup ? "" : (retry ? failed?.text ?? "" : input).trim();
    const images = toolFollowup ? [] : (retry ? failed?.images ?? [] : attachments);
    const pendingDocuments = toolFollowup ? [] : (retry ? failed?.documents ?? [] : documents);
    if (!toolFollowup && !text && images.length === 0 && pendingDocuments.length === 0) return;
    if (!toolFollowup && !canSend && !retry) return;
    if (!toolFollowup) {
      toolRoundsRef.current = 0;
      documentTruncationRef.current = false;
      const config = structuredClone(effectiveConfig ?? store.cfg);
      const profile = modelProfile !== undefined ? modelProfile : config ? requestProfileFromApplication(appliedProfile(config, sessionId)) : null;
      turnRef.current = {
        config,
        baseUrl: baseUrl!, apiKey, model, sessionId,
        systemPrompt: activeThread?.systemPrompt.trim() || profile?.system_prompt.trim() || "You are a helpful assistant.",
        tools: structuredClone(mcpDefinitions),
        toolEntries: new Map(mcpEntryByFunctionName),
      };
    }
    const turn = turnRef.current;
    if (!turn) return;
    const requestConfig = turn.config;

    const controller = new AbortController();
    ctrlRef.current = controller;
    // Preparation can await server wake-up and document embeddings. Lock the
    // composer immediately and let Stop cancel before generation starts.
    setPhase("thinking");
    setError(null);
    streamRef.current = { assistant: "", reasoning: "", toolCalls: [] };
    cancelScheduledRender();
    setStreamingDraft(null);
    metricsRef.current = { preparationStartedAt: performance.now() };
    let awaitingTool = false;
    let assistantAppended = false;
    try {
      if (!activityRef.current) {
        const activity = { sessionId: turn.sessionId, started: false };
        activityRef.current = activity;
        setSessionActivity(turn.sessionId, true);
        await api.serverActivity("start", turn.sessionId);
        activity.started = true;
        // An unmount can release the frontend lock while native wake-up is pending.
        if (activityRef.current !== activity) void api.serverActivity("end", turn.sessionId).catch(() => undefined);
      }
      controller.signal.throwIfAborted();

      const { documentContext, retrievalSources, retrievalCitations, documentChunksTruncated } = await retrieveDocumentContext(pendingDocuments, text, turn.model, turn.apiKey, turn.baseUrl);
      controller.signal.throwIfAborted();
      if (documentChunksTruncated) documentTruncationRef.current = true;
      setContextSources(retrievalSources);
      const requestContent = `${text}${documentContext ?? ""}`;
      const userMessage: api.ChatMessage = {
        role: "user",
        content: images.length ? buildMultimodalContent(requestContent, images) : requestContent,
      };
      const rawHistory = historyOverride ?? (retry && failed ? failed.history : [
        { role: "system" as const, content: turn.systemPrompt },
        ...msgs.map(toChatMessage),
        userMessage,
      ]);
      const contextSize = Math.max(512, requestConfig?.ctx_size ?? 4096);
      const runtimeContext = requestConfig ? usesRuntimeDefault(requestConfig, "ctx_size") : false;
      const maxContextTokens = Math.max(256, Math.floor(contextSize * 0.75));
      // When the runtime owns context sizing, the old manual number is not a valid limit.
      const bounded = toolFollowup || runtimeContext ? { messages: rawHistory, trimmed: false } : trimChatHistory(rawHistory, maxContextTokens);
      const promptTokens = estimateChatTokens(bounded.messages);
      const chatOptions = runtimeContext ? (requestConfig?.chat_options ?? {}) : capMaxTokens(requestConfig?.chat_options ?? {}, promptTokens, contextSize);
      const warnings = [
        documentTruncationRef.current ? `Only the first ${MAX_SEARCHABLE_DOCUMENT_CHUNKS} document chunks were searched; the rest of the attached document(s) were not included.` : null,
        bounded.trimmed ? "Older messages were omitted from this request to stay within the configured context window." : null,
      ].filter((warning): warning is string => warning !== null);
      setContextWarning(warnings.length > 0 ? warnings.join(" ") : null);
      failedRef.current = { text, images, documents: pendingDocuments, history: bounded.messages };
      if (!toolFollowup) setInput("");
      if (!retry && !toolFollowup) setAttachments([]);
      if (!retry && !toolFollowup) setDocuments([]);
      atBottomRef.current = true;
      setMsgs((current) => {
        const last = current[current.length - 1];
        const replaceAssistant = (retry || toolFollowup) && last?.role === "assistant";
        const withoutDanglingAssistant = replaceAssistant ? current.slice(0, -1) : current;
        if (toolFollowup) return [...withoutDanglingAssistant, { role: "assistant" as const, content: "", reasoning: "" }];
        const previous = withoutDanglingAssistant[withoutDanglingAssistant.length - 1];
        const hasUserBubble = previous?.role === "user" && previous.content === text && sameImages(previous.images, images) && sameDocuments(previous.documents, pendingDocuments);
        return [...withoutDanglingAssistant, ...(hasUserBubble ? [] : [{ role: "user" as const, content: text, images, documents: pendingDocuments }]), { role: "assistant" as const, content: "", reasoning: "" }];
      });
      assistantAppended = true;
      const sampling = {
        temperature: requestConfig?.temperature ?? QWEN38_DEFAULTS.temperature,
        runtime_defaults: requestConfig?.runtime_defaults,
        top_p: requestConfig?.top_p ?? QWEN38_DEFAULTS.top_p,
        top_k: requestConfig?.top_k ?? QWEN38_DEFAULTS.top_k,
        reasoning: requestConfig?.reasoning ?? QWEN38_DEFAULTS.reasoning,
        reasoning_effort: requestConfig?.reasoning_effort ?? QWEN38_DEFAULTS.reasoning_effort,
        options: chatOptions,
        tools: turn.tools,
      };
      const streamResponses = preferences?.chat.streamResponses ?? true;
      streamResponsesRef.current = streamResponses;
      const onDelta = createStreamDeltaHandler({ streamRef, metricsRef, streamResponses, setPhase: () => setPhase("streaming"), scheduleAssistantRender });
      metricsRef.current.requestStartedAt = performance.now();
      setStreamingDraft({ content: "", reasoning: "", metrics: snapshotMetrics(metricsRef.current.requestStartedAt) });
      const full = await api.chatStream(turn.baseUrl, turn.apiKey, turn.model, bounded.messages, sampling, onDelta, controller.signal);
      const responseMetrics = snapshotMetrics();

      const toolCall = streamRef.current.toolCalls[0];
      if (toolCall) {
        const { assistant: toolCallAssistant, reasoning: toolCallReasoning } = streamRef.current;
        cancelScheduledRender();
        setMsgs((current) => {
          if (current[current.length - 1]?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = { ...next[next.length - 1], content: toolCallAssistant, reasoning: toolCallReasoning, metrics: responseMetrics };
          return next;
        });
        setStreamingDraft(null);
        toolRoundsRef.current += 1;
        if (toolRoundsRef.current > 4) throw new Error("MCP tool loop limit reached (4 calls per response).");
        setPendingToolCall(resolveDetectedToolCall(toolCall, turn.toolEntries));
        awaitingTool = true;
        setPhase("idle");
        return;
      }

      cancelScheduledRender();
      setMsgs((current) => {
        if (current[current.length - 1]?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = {
          ...next[next.length - 1],
          content: full,
          reasoning: streamRef.current.reasoning,
          citations: retrievalCitations.length ? retrievalCitations : undefined,
          metrics: responseMetrics,
        };
        return next;
      });
      setStreamingDraft(null);
      failedRef.current = null;
      toolRoundsRef.current = 0;
      setPhase("idle");
    } catch (caught) {
      const isAbort = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
      cancelScheduledRender();
      const responseMetrics = snapshotMetrics();
      if (assistantAppended) {
        const partialAssistant = streamRef.current.assistant;
        const partialReasoning = streamRef.current.reasoning;
        if (partialAssistant || partialReasoning) {
          failedRef.current = { ...(failedRef.current ?? { text, images, documents: pendingDocuments, history: [] }), partialAssistant, partialReasoning };
          setMsgs((current) => {
            if (current[current.length - 1]?.role !== "assistant") return current;
            const next = current.slice();
            next[next.length - 1] = { ...next[next.length - 1], content: partialAssistant, reasoning: partialReasoning, interrupted: isAbort, failed: !isAbort, metrics: responseMetrics };
            return next;
          });
          setStreamingDraft(null);
        } else {
          setMsgs((current) => (current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current));
          setStreamingDraft(null);
        }
      }
      if (isAbort) {
        if (!streamRef.current.assistant && !streamRef.current.reasoning) failedRef.current = null;
        toolRoundsRef.current = 0;
        setPhase("idle");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("idle");
      }
    } finally {
      if (!awaitingTool) {
        releaseActivity();
        turnRef.current = null;
      }
      ctrlRef.current = null;
      setAborting(false);
      void store.refreshStatus();
    }
  };

  const approvePendingTool = async () => {
    const pending = pendingToolCall;
    const failed = failedRef.current;
    if (!pending || !failed || phase !== "idle" || ctrlRef.current) return;
    setPendingToolCall(null);
    setError(null);
    setPhase("thinking");
    const controller = new AbortController();
    ctrlRef.current = controller;
    try {
      const result = await api.mcpCallTool(pending.serverId, pending.toolName, pending.argumentsValue);
      controller.signal.throwIfAborted();
      const serializedResult = JSON.stringify(result);
      if (serializedResult.length > 256_000) throw new Error("MCP tool result exceeds the 256 KiB chat safety limit.");
      const followupHistory: api.ChatMessage[] = [
        ...failed.history,
        { role: "assistant", content: "", tool_calls: [pending.call] },
        { role: "tool", tool_call_id: pending.call.id, name: pending.call.function.name, content: serializedResult },
      ];
      ctrlRef.current = null;
      await send(false, followupHistory);
    } catch (caught) {
      releaseActivity();
      turnRef.current = null;
      ctrlRef.current = null;
      setAborting(false);
      setPhase("idle");
      if (!controller.signal.aborted) setError(`MCP tool call failed: ${caught instanceof Error ? caught.message : String(caught)}`);
    }
  };

  const rejectPendingTool = () => {
    releaseActivity();
    turnRef.current = null;
    setPendingToolCall(null);
    failedRef.current = null;
    toolRoundsRef.current = 0;
    setMsgs((current) => current[current.length - 1]?.role === "assistant" ? current.slice(0, -1) : current);
    setError("MCP tool call rejected by the user.");
    setPhase("idle");
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  return {
    error, setError, contextWarning, contextSources,
    aborting, pendingToolCall, streamingDraft, failedRef,
    send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  };
}
