import { useEffect, useRef, useState } from "react";
import * as api from "../../shared/api/index";
import { isIpcErrorKind } from "../../shared/api/ipcError";
import { estimateChatTokens } from "./chatUtils";
import { CHAT_WORKSPACE_CLEAR_EVENT, isChatWorkspaceClearing } from "./chatHistory";
import { chatRetrySnapshot } from "./chatRetrySnapshot";
import type { ChatHistoryMessage, ChatWorkspaceClearDetail } from "../../shared/api/conversationTypes";
import { retryTools } from "./chatRetryTools";
import { appliedProfile, requestProfileFromApplication } from "../model-settings/profileEditor";
import type { FailedRequest } from "./chatSendTypes";
import { createStreamDeltaHandler, resolveDetectedToolCall, sameDocuments, sameImages } from "./chatSendHelpers";
import { setSessionActivity } from "../../shared/state/sessionActivity";
import { notifyCompletion } from "../../shared/lib/notifications";
import { chatPersonalizationText, type ChatPersonalizationTextKey } from "../../shared/i18n/chatPersonalizationText";
import { translate } from "../../shared/i18n/i18nUnified";
import { answerSkillToolCall, hasPersonalization, MAX_SKILL_READS_PER_RESPONSE, SKILL_TOOL_NAME } from "./chatPersonalization";
import { canPrepareAttachment } from './mediaPreprocessing';
import { useChatToolApproval } from "./useChatToolApproval";
import { useChatStreamingDraft } from "./useChatStreamingDraft";
import { createHistoryConversionCache, type HistoryConversionCache } from "./chatHistoryConversion";
import { buildTurnRequest, prepareTurnMedia, prepareTurnSkills, retrieveTurnDocuments } from "./chatTurnPreparation";
import type { ChatTurnSnapshot, UseChatSendOptions } from "./chatSendOptions";
import { useChatRetryState } from "./useChatRetryState";

export type { PendingToolCall } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

function withoutRetry(message: Msg): Msg {
  const next = { ...message };
  delete next.retry;
  return next;
}

// Streaming updates publish to the draft store, subscribed to by the in-flight
// bubble alone. The draft flushes into `msgs` once per stream (completion, tool
// call, or error), with pending animation frames cancelled at each transition.
export function useChatSend({
  store, effectiveConfig, modelProfile, engine, embeddingTarget, mediaPreprocessing, sessionId = "default", preferences, baseUrl, apiKey, model, activeThread, msgs, setMsgs,
  input, setInput, attachments, documents, setAttachments, setDocuments,
  mcpEntryByFunctionName, mcpDefinitions, atBottomRef, phase, setPhase,
  selectedSkillIds = [], onSkillsAccepted, locale = "en",
}: UseChatSendOptions) {
  const pt = (key: ChatPersonalizationTextKey, vars?: Record<string, string | number>) => chatPersonalizationText(locale, key, vars);
  const [error, setError] = useState<string | null>(null);
  const [contextWarning, setContextWarning] = useState<string | null>(null);
  const [contextSources, setContextSources] = useState<string[]>([]);
  const [aborting, setAborting] = useState(false);
  const { streamingDraftStore, setStreamingDraft, renderFrameRef, streamRef, metricsRef, streamResponsesRef,
    cancelScheduledRender, snapshotMetrics, scheduleAssistantRender } = useChatStreamingDraft();
  const ctrlRef = useRef<AbortController | null>(null);
  const turnGeneration = useRef(0);
  const { failedRef, lastMessage, supersededRef, saved, retryToolMatch, retryToolsMissing, canRetry, retryUnavailable } = useChatRetryState(msgs, mcpDefinitions, mcpEntryByFunctionName);
  const toolRoundsRef = useRef(0);
  const skillReadsRef = useRef(0);
  const historyConversionCacheRef = useRef<HistoryConversionCache | null>(null);
  if (historyConversionCacheRef.current === null) historyConversionCacheRef.current = createHistoryConversionCache();
  const turnRef = useRef<ChatTurnSnapshot | null>(null);
  const activityRef = useRef<{ sessionId: string; started: boolean } | null>(null);
  const releaseActivity = () => {
    const activity = activityRef.current;
    activityRef.current = null;
    if (!activity) return;
    setSessionActivity(activity.sessionId, false);
    if (activity.started) void api.serverActivity("end", activity.sessionId).catch(() => undefined);
  };
  const { pendingToolCall, setPendingToolCall, toolCallInProgress, setToolCallInProgress, approvePendingTool, rejectPendingTool } = useChatToolApproval({
    phase, ctrlRef, turnGeneration, failedRef, turnRef, toolRoundsRef, skillReadsRef,
    releaseActivity, setAborting, setPhase, setMsgs, setError, locale,
    sendFollowup: history => send(false, history),
  });
  // MCP follow-up sends carry no documents of their own, so this tracks whether the
  // turn's original message hit the search limit and keeps that warning visible
  // across follow-up rounds until a new user message (or thread switch) resets it.
  const documentTruncationRef = useRef(false);

  useEffect(() => () => {
    turnGeneration.current += 1;
    ctrlRef.current?.abort();
    if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
    const activity = activityRef.current;
    activityRef.current = null;
    if (activity) {
      setSessionActivity(activity.sessionId, false);
      if (activity.started) void api.serverActivity("end", activity.sessionId).catch(() => undefined);
    }
  }, [renderFrameRef]);


  const resetChatState = () => {
    cancelScheduledRender();
    setStreamingDraft(null);
    setToolCallInProgress(false);
    failedRef.current = null;
    supersededRef.current = null;
    setError(null);
    documentTruncationRef.current = false;
    setContextWarning(null);
    setContextSources([]);
  };

  useEffect(() => {
    historyConversionCacheRef.current = createHistoryConversionCache();
  }, [activeThread?.id, sessionId]);

  useEffect(() => {
    const onClear = (event: Event) => {
      if ((event as CustomEvent<ChatWorkspaceClearDetail>).detail.state !== "clearing") return;
      // Delete invalidates the whole turn, including approval and late async
      // completions. Ordinary Stop still preserves its partial answer.
      turnGeneration.current += 1;
      ctrlRef.current?.abort();
      ctrlRef.current = null;
      if (renderFrameRef.current !== null) window.cancelAnimationFrame(renderFrameRef.current);
      renderFrameRef.current = null;
      const activity = activityRef.current;
      activityRef.current = null;
      if (activity) {
        setSessionActivity(activity.sessionId, false);
        if (activity.started) void api.serverActivity("end", activity.sessionId).catch(() => undefined);
      }
      turnRef.current = null;
      historyConversionCacheRef.current = createHistoryConversionCache();
      failedRef.current = null;
      supersededRef.current = null;
      streamRef.current = { assistant: "", reasoning: "", toolCalls: [] };
      metricsRef.current = { preparationStartedAt: 0 };
      toolRoundsRef.current = 0;
      skillReadsRef.current = 0;
      documentTruncationRef.current = false;
      setPendingToolCall(null);
      setToolCallInProgress(false);
      setStreamingDraft(null);
      setAborting(false);
      setError(null);
      setContextWarning(null);
      setContextSources([]);
      setPhase("idle");
    };
    window.addEventListener(CHAT_WORKSPACE_CLEAR_EVENT, onClear);
    return () => window.removeEventListener(CHAT_WORKSPACE_CLEAR_EVENT, onClear);
  }, [failedRef, metricsRef, renderFrameRef, setPendingToolCall, setPhase, setStreamingDraft, setToolCallInProgress, streamRef, supersededRef]);

  const send = async (retry = false, historyOverride?: api.ChatMessage[], canSend = true) => {
    if (isChatWorkspaceClearing() || ctrlRef.current || (!historyOverride && (!baseUrl || pendingToolCall))) return;
    const generation = turnGeneration.current;
    const isCurrent = () => generation === turnGeneration.current;
    const toolFollowup = !!historyOverride;
    const retryToolsReady = retry && !toolFollowup ? retryToolMatch : null;
    // Nothing is consumed: the unfinished reply and its snapshot stay for when the tools are back.
    if (retryToolsReady?.kind === "missing") return;
    const restored = retry && !failedRef.current && saved?.kind === "ready" ? saved.snapshot : null;
    const failed: FailedRequest | null = failedRef.current ?? (restored && structuredClone({
      text: restored.text, images: restored.images, documents: restored.documents, history: restored.history, personalization: null, tools: restored.tools,
    }));
    const text = toolFollowup ? "" : (retry ? failed?.text ?? "" : input).trim();
    let images = toolFollowup ? [] : (retry ? failed?.images ?? [] : attachments);
    if (!toolFollowup && engine && images.some(image => !canPrepareAttachment(image, engine.modalities, mediaPreprocessing ?? { videoFrames: false }))) {
      setError(translate(locale, "chat.unsupportedAttachment")); return;
    }
    const pendingDocuments = toolFollowup ? [] : (retry ? failed?.documents ?? [] : documents);
    if (!toolFollowup && !text && images.length === 0 && pendingDocuments.length === 0) return;
    if (!toolFollowup && !canSend && !retry) return;
    if (!toolFollowup) {
      // A new message supersedes an earlier failure; if it fails during preparation, Retry must not resend the old one.
      if (!retry) failedRef.current = null;
      // The same goes for a snapshot saved with an earlier unfinished reply, in
      // this session only: until the new request is issued nothing replaces it,
      // so the saved copy stays for a later restart or conversation switch.
      if (!retry) supersededRef.current = lastMessage ?? null;
      toolRoundsRef.current = 0;
      skillReadsRef.current = 0;
      documentTruncationRef.current = false;
      const config = structuredClone(effectiveConfig ?? store.cfg);
      const profile = modelProfile !== undefined ? modelProfile : config ? requestProfileFromApplication(appliedProfile(config, sessionId)) : null;
      turnRef.current = {
        config,
        engine: engine ? structuredClone(engine) : undefined,
        mediaPreprocessing: mediaPreprocessing ? structuredClone(mediaPreprocessing) : undefined,
        embeddingTarget: embeddingTarget ? structuredClone(embeddingTarget) : undefined,
        baseUrl: baseUrl!, apiKey, model, sessionId,
        systemPrompt: activeThread?.systemPrompt.trim() || profile?.system_prompt.trim() || (activeThread?.useDefaultSystemPrompt === false ? "" : "You are a helpful assistant."),
        mediaBeforeText: activeThread?.mediaBeforeText === true,
        tools: structuredClone(retryToolsReady?.kind === "ready" ? retryToolsReady.tools : mcpDefinitions),
        toolEntries: new Map(retryToolsReady?.kind === "ready" ? retryToolsReady.entries : mcpEntryByFunctionName),
        personalization: null,
      };
    }
    const turn = turnRef.current;
    if (!turn) return;

    const controller = new AbortController();
    ctrlRef.current = controller;
    // Preparation can await server wake-up and document embeddings. Lock the
    // composer immediately and let Stop cancel before generation starts.
    setPhase("preparing");
    setError(null);
    streamRef.current = { assistant: "", reasoning: "", toolCalls: [] };
    cancelScheduledRender();
    setStreamingDraft(null);
    metricsRef.current = { preparationStartedAt: performance.now() };
    let awaitingTool = false;
    let assistantAppended = false;
    let replacedReply: Msg | undefined;
    let skillFollowup: api.ChatMessage[] | null = null;
    const skillIds = selectedSkillIds.slice();
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

      if (!toolFollowup) {
        images = await prepareTurnMedia(turn, images, controller.signal);
        await prepareTurnSkills(turn, text, skillIds, retry, failed, controller.signal, locale);
      }
      const { documentContext, retrievalSources, retrievalCitations, documentChunksTruncated } = await retrieveTurnDocuments(turn, pendingDocuments, text, controller.signal);
      controller.signal.throwIfAborted();
      if (documentChunksTruncated) documentTruncationRef.current = true;
      setContextSources(retrievalSources);
      const { bounded, runtimeContext, maxContextTokens, warnings, sampling } = buildTurnRequest({
        turn, text, images, documentContext,
        suppliedHistory: historyOverride ?? (retry && failed ? failed.history : undefined),
        msgs, cache: historyConversionCacheRef.current!, toolFollowup,
        documentChunksTruncated: documentTruncationRef.current, locale,
      });
      setContextWarning(warnings.length > 0 ? warnings.join(" ") : null);
      // A tool follow-up carries no user input of its own: keep the original request so Retry can still resend it.
      failedRef.current = toolFollowup && failed
        ? { text: failed.text, images: failed.images, documents: failed.documents, history: bounded.messages, personalization: turn.personalization, tools: failed.tools }
        : { text, images, documents: pendingDocuments, history: bounded.messages, personalization: turn.personalization, tools: retryTools(turn.tools, turn.toolEntries) };
      // Saved with the reply so Retry survives a restart or thread switch.
      const retrySnapshot = chatRetrySnapshot(failedRef.current, hasPersonalization(turn.personalization));
      if (!retry && !toolFollowup) setInput("");
      if (!retry && !toolFollowup) onSkillsAccepted?.();
      if (!retry && !toolFollowup) setAttachments([]);
      if (!retry && !toolFollowup) setDocuments([]);
      atBottomRef.current = true;
      setMsgs((current) => {
        if (!isCurrent()) return current;
        const last = current[current.length - 1];
        const replaceAssistant = (retry || toolFollowup) && last?.role === "assistant";
        const withoutDanglingAssistant = replaceAssistant ? current.slice(0, -1) : current;
        if (replaceAssistant && retry) replacedReply = last;
        if (toolFollowup) return [...withoutDanglingAssistant, { role: "assistant" as const, content: "", reasoning: "", model: turn.model, retry: retrySnapshot }];
        const previous = withoutDanglingAssistant[withoutDanglingAssistant.length - 1];
        // A saved snapshot always follows its own user bubble, whose stored copy may be shortened.
        const hasUserBubble = previous?.role === "user" && (!!restored
          || (previous.content === text && sameImages(previous.images, images) && sameDocuments(previous.documents, pendingDocuments)));
        return [...withoutDanglingAssistant, ...(hasUserBubble ? [] : [{ role: "user" as const, content: text, images, documents: pendingDocuments }]), { role: "assistant" as const, content: "", reasoning: "", model: turn.model, retry: retrySnapshot }];
      });
      assistantAppended = true;
      const streamResponses = preferences?.chat.streamResponses ?? true;
      streamResponsesRef.current = streamResponses;
      const handleDelta = createStreamDeltaHandler({ streamRef, metricsRef, streamResponses, setPhase, scheduleAssistantRender });
      const onDelta = (delta: api.ChatDelta) => {
        if (isCurrent() && !controller.signal.aborted && ctrlRef.current === controller) handleDelta(delta);
      };
      metricsRef.current.requestStartedAt = performance.now();
      setStreamingDraft({ content: "", reasoning: "", metrics: snapshotMetrics(metricsRef.current.requestStartedAt) });
      setPhase("prefill");
      const full = await api.chatStream(turn.baseUrl, turn.apiKey, turn.model, bounded.messages, sampling, onDelta, controller.signal);
      if (!isCurrent()) return;
      const responseMetrics = snapshotMetrics();

      const toolCall = streamRef.current.toolCalls[0];
      // A token limit may cut off a tool name or arguments even when the
      // partial JSON parses. Keep that response instead of offering execution.
      if (toolCall && streamRef.current.finishReason !== 'length') {
        const { assistant: toolCallAssistant, reasoning: toolCallReasoning } = streamRef.current;
        cancelScheduledRender();
        setMsgs((current) => {
          if (!isCurrent()) return current;
          const last = current[current.length - 1];
          if (last?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = { ...last, content: toolCallAssistant, reasoning: toolCallReasoning, metrics: responseMetrics, finishReason: streamRef.current.finishReason };
          return next;
        });
        setStreamingDraft(null);
        if (toolCall.function.name === SKILL_TOOL_NAME && turn.personalization?.catalog.length && !turn.toolEntries.has(SKILL_TOOL_NAME)) {
          // Reading a listed SKILL.md is read-only, so it runs without the MCP approval step.
          skillReadsRef.current += 1;
          if (skillReadsRef.current > MAX_SKILL_READS_PER_RESPONSE) throw new Error(pt("skillReadLimit", { limit: MAX_SKILL_READS_PER_RESPONSE }));
          setPhase("preparing");
          const answer = await answerSkillToolCall(toolCall, turn.personalization);
          controller.signal.throwIfAborted();
          const followup: api.ChatMessage[] = [
            ...bounded.messages,
            { role: "assistant", content: "", tool_calls: [toolCall] },
            { role: "tool", tool_call_id: toolCall.id, name: SKILL_TOOL_NAME, content: answer.content },
          ];
          const followupTokens = estimateChatTokens(followup);
          if (!runtimeContext && followupTokens > maxContextTokens) throw new Error(pt("skillTooLarge", { name: answer.skill?.name ?? SKILL_TOOL_NAME, tokens: followupTokens, budget: maxContextTokens }));
          skillFollowup = followup;
          awaitingTool = true;
          return;
        }
        toolRoundsRef.current += 1;
        if (toolRoundsRef.current > 4) throw new Error(translate(locale, "chat.mcpLoopLimit"));
        setPendingToolCall(resolveDetectedToolCall(toolCall, turn.toolEntries));
        awaitingTool = true;
        setPhase("idle");
        return;
      }

      cancelScheduledRender();
      setMsgs((current) => {
        if (!isCurrent()) return current;
        const last = current[current.length - 1];
        if (last?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = {
          ...withoutRetry(last),
          content: full,
          reasoning: streamRef.current.reasoning,
          citations: retrievalCitations.length ? retrievalCitations : undefined,
          metrics: responseMetrics,
          finishReason: streamRef.current.finishReason,
        };
        return next;
      });
      setStreamingDraft(null);
      failedRef.current = null;
      toolRoundsRef.current = 0;
      skillReadsRef.current = 0;
      setPhase("idle");
      // Only the turn's final answer is announced - after any MCP follow-up,
      // never for a tool request, a token limit, an error, a stop or an unmount.
      if (!controller.signal.aborted && streamRef.current.finishReason !== 'length') void notifyCompletion("chat");
    } catch (caught) {
      if (!isCurrent()) return;
      const isAbort = controller.signal.aborted || isIpcErrorKind(caught, "cancelled") || (caught instanceof DOMException && caught.name === "AbortError");
      cancelScheduledRender();
      const responseMetrics = snapshotMetrics();
      if (assistantAppended) {
        const partialAssistant = streamRef.current.assistant;
        const partialReasoning = streamRef.current.reasoning;
        const produced = !!(partialAssistant || partialReasoning);
        if (produced) failedRef.current = { ...(failedRef.current ?? { text, images, documents: pendingDocuments, history: [] }), partialAssistant, partialReasoning };
        // The request was issued, so its reply stays (even empty) with the exact
        // snapshot for Retry. A retry that produced nothing restores the earlier
        // reply as it was, including the measurements of the response it shows.
        setMsgs((current) => {
          if (!isCurrent()) return current;
          const last = current[current.length - 1];
          if (last?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = !produced && replacedReply
            ? replacedReply
            : { ...last, content: partialAssistant, reasoning: partialReasoning, interrupted: isAbort, failed: !isAbort, metrics: responseMetrics };
          return next;
        });
        setStreamingDraft(null);
      }
      if (isAbort) {
        toolRoundsRef.current = 0;
        skillReadsRef.current = 0;
        setPhase("idle");
      } else {
        setError(caught instanceof Error ? caught.message : String(caught));
        setPhase("idle");
      }
    } finally {
      if (isCurrent()) {
        if (!awaitingTool) {
          releaseActivity();
          turnRef.current = null;
        }
        ctrlRef.current = null;
        setAborting(false);
        void store.refreshStatus();
        // The read skill joins this turn's history and generation continues on the same snapshot.
        if (skillFollowup) await send(false, skillFollowup);
      }
    }
  };


  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  return {
    error, setError, contextWarning, contextSources,
    aborting, pendingToolCall, toolCallInProgress, streamingDraftStore, failedRef, canRetry, retryUnavailable, retryToolsMissing,
    send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  };
}
