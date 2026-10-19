import { useEffect, useMemo, useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import * as api from "../../shared/api/index";
import type { AppStore } from "../../shared/state/store";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, estimateMessageTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, trimChatHistory, type DocumentAttachment, type ImageAttachment } from "./chatUtils";
import { CHAT_WORKSPACE_CLEAR_EVENT, chatRetrySnapshot, isChatWorkspaceClearing, savedRetry, toolTurn, type ChatHistoryMessage, type ChatThread, type ChatWorkspaceClearDetail } from "./chatHistory";
import { matchRetryTools, retryTools } from "./chatRetryTools";
import { CHAT_REQUEST_FALLBACKS } from "../../shared/config/chatRequestFallbacks";
import type { ModelProfile } from "../model-settings/profileEditor";
import { appliedProfile, requestProfileFromApplication } from "../model-settings/profileEditor";
import { chatContextBudget } from './providerChatContext';
import type { AppPreferences } from "../../shared/config/preferences";
import { buildResponseMetrics } from "../../shared/lib/metrics";
import type { ChatMcpTool } from "./useChatMcpTools";
import type { FailedRequest, PendingToolCall, RequestMetricsAccumulator, StreamingDraft } from "./chatSendTypes";
import { createStreamDeltaHandler, resolveDetectedToolCall, retrieveDocumentContext, sameDocuments, sameImages, toChatMessage, type StreamAccumulator } from "./chatSendHelpers";
import { setSessionActivity } from "../../shared/state/sessionActivity";
import { notifyCompletion } from "../../shared/lib/notifications";
import { chatPersonalizationText, type ChatPersonalizationTextKey } from "../../shared/i18n/chatPersonalizationText";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { answerSkillToolCall, buildPersonalizedSystemPrompt, hasPersonalization, MAX_SKILL_READS_PER_RESPONSE, prepareTurnPersonalization, SKILL_TOOL_NAME, skillToolDefinition, type TurnPersonalization } from "./chatPersonalization";
import { canPrepareAttachment, prepareChatAttachments, type MediaPreprocessingOptions } from './mediaPreprocessing';
import { serializeMcpToolResult } from './mcpToolResult';

export type { PendingToolCall } from "./chatSendTypes";

type Msg = ChatHistoryMessage;

function withoutRetry(message: Msg): Msg {
  const next = { ...message };
  delete next.retry;
  return next;
}

const HISTORY_CONVERSION_CACHE_MAX_ENTRIES = 256;
const HISTORY_CONVERSION_CACHE_MAX_UNITS = 1_000_000;

interface HistoryConversionCacheEntry {
  message: api.ChatMessage;
}

interface HistoryConversionCache {
  values: WeakMap<Msg, Map<boolean, HistoryConversionCacheEntry>>;
  entries: number;
  payloadUnits: number;
}

function createHistoryConversionCache(): HistoryConversionCache {
  return { values: new WeakMap(), entries: 0, payloadUnits: 0 };
}

function contentPartPayloadUnits(part: api.ChatContentPart): number {
  const overhead = 16;
  switch (part.type) {
    case "text": return overhead + part.text.length;
    case "image_url": return overhead + part.image_url.url.length;
    case "video_url": return overhead + part.video_url.url.length;
    case "input_audio": return overhead + part.input_audio.data.length + part.input_audio.format.length;
    case "input_video": return overhead + (part.input_video.data?.length ?? 0) + (part.input_video.url?.length ?? 0);
    case "aiolm_media": return overhead + part.media.ref.length + part.media.kind.length;
  }
}

/** Counts visible request payload conservatively without serializing document/media text again. */
function chatMessagePayloadUnits(message: api.ChatMessage): number {
  const content = typeof message.content === "string"
    ? message.content.length
    : message.content.reduce((total, part) => total + contentPartPayloadUnits(part), 0);
  return 32 + message.role.length + content;
}

function convertHistoryMessage(
  cache: HistoryConversionCache,
  message: Msg,
  mediaBeforeText: boolean,
): api.ChatMessage {
  const byMode = cache.values.get(message);
  const cached = byMode?.get(mediaBeforeText);
  if (cached) return cached.message;

  // `msgs` is React-owned immutable state; request builders only read these results.
  const converted = toChatMessage(message, mediaBeforeText);
  const payloadUnits = chatMessagePayloadUnits(converted);
  if (cache.entries >= HISTORY_CONVERSION_CACHE_MAX_ENTRIES
    || cache.payloadUnits + payloadUnits > HISTORY_CONVERSION_CACHE_MAX_UNITS) return converted;

  const entries = byMode ?? new Map<boolean, HistoryConversionCacheEntry>();
  if (!byMode) cache.values.set(message, entries);
  entries.set(mediaBeforeText, { message: converted });
  cache.entries += 1;
  cache.payloadUnits += payloadUnits;
  return converted;
}

interface UseChatSendOptions {
  embeddingTarget?: { model: string; baseUrl: string; apiKey: string; namespace: string };
  engine?: api.EngineInfo;
  mediaPreprocessing?: MediaPreprocessingOptions;
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
  /** Skills picked in the composer for the next message. */
  selectedSkillIds?: string[];
  /** Clears the picker once a message carrying its selection is accepted. */
  onSkillsAccepted?: () => void;
  locale?: Locale;
}

// Streaming updates land in `streamingDraft` instead of `msgs` so the hot rAF path never
// clones the full message array; the draft is flushed into `msgs` once per stream
// (completion, tool call, or error), not once per animation frame, and any still-pending
// rAF is cancelled at each of those terminal transitions to avoid a redundant flush.
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
  const [pendingToolCall, setPendingToolCall] = useState<PendingToolCall | null>(null);
  const [toolCallInProgress, setToolCallInProgress] = useState(false);
  const [streamingDraft, setStreamingDraft] = useState<StreamingDraft | null>(null);
  const ctrlRef = useRef<AbortController | null>(null);
  const turnGeneration = useRef(0);
  const failedRef = useRef<FailedRequest | null>(null);
  const renderFrameRef = useRef<number | null>(null);
  const streamRef = useRef<StreamAccumulator>({ assistant: "", reasoning: "", toolCalls: [] });
  const metricsRef = useRef<RequestMetricsAccumulator>({ preparationStartedAt: 0 });
  const streamResponsesRef = useRef(true);
  const toolRoundsRef = useRef(0);
  const skillReadsRef = useRef(0);
  const historyConversionCacheRef = useRef<HistoryConversionCache | null>(null);
  if (historyConversionCacheRef.current === null) historyConversionCacheRef.current = createHistoryConversionCache();
  const turnRef = useRef<{
    config: api.AppConfig | null;
    engine?: api.EngineInfo;
    mediaPreprocessing?: MediaPreprocessingOptions;
    embeddingTarget?: UseChatSendOptions['embeddingTarget'];
    baseUrl: string;
    apiKey: string;
    model: string;
    sessionId: string;
    systemPrompt: string;
    mediaBeforeText: boolean;
    tools: api.ChatToolDefinition[];
    toolEntries: Map<string, ChatMcpTool>;
    /** Loaded once per new user turn; follow-ups and retries reuse it unchanged. */
    personalization: TurnPersonalization | null;
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
  // This session's failed turn wins; otherwise the snapshot saved with the
  // conversation's unfinished last reply survives a restart or thread switch.
  const lastMessage = msgs.at(-1);
  const supersededRef = useRef<Msg | null>(null);
  const savedForLast = useMemo(() => savedRetry(lastMessage), [lastMessage]);
  const saved = lastMessage === supersededRef.current ? null : savedForLast;
  // A turn that offered MCP tools, or already depends on one, is resent only
  // with those same tools, checked against the selection now; otherwise Retry
  // would silently drop them, even for a reply stopped before any tool call.
  const retryRequest = failedRef.current ?? (saved?.kind === "ready" ? saved.snapshot : null);
  const retryToolMatch = retryRequest && (retryRequest.tools !== undefined || toolTurn(lastMessage, retryRequest.history))
    ? matchRetryTools(retryRequest.tools ?? [], mcpDefinitions, mcpEntryByFunctionName) : null;
  const retryToolsMissing = retryToolMatch?.kind === "missing" ? retryToolMatch.missing : null;
  const canRetry = (!!failedRef.current || saved?.kind === "ready") && !retryToolsMissing;
  const retryUnavailable = !failedRef.current && saved?.kind === "unavailable" ? saved.reason : null;

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
    }, current.serverMetrics);
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
  }, [setPhase]);

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
      setError('The running model does not support one of the attached inputs.'); return;
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
        if (images.length && (turn.engine || turn.mediaPreprocessing)) {
          images = await prepareChatAttachments(images, turn.engine?.modalities ?? {
            text: true, image: !!turn.config?.mmproj, audio: false, video: false,
          }, turn.mediaPreprocessing ?? { videoFrames: false }, controller.signal);
          controller.signal.throwIfAborted();
        }
        // A retry resends the failed turn's own snapshot; only a new message rereads the files.
        turn.personalization = retry && failed ? failed.personalization ?? null : await prepareTurnPersonalization(text, skillIds, controller.signal, pt);
        controller.signal.throwIfAborted();
        if (turn.personalization?.catalog.length && !turn.toolEntries.has(SKILL_TOOL_NAME)) turn.tools = [...turn.tools, skillToolDefinition()];
      }

      const target = turn.embeddingTarget ?? (turn.engine?.provider && turn.engine.provider !== 'llama.cpp'
        ? { model: turn.engine.embedding_model ?? '', baseUrl: turn.baseUrl, apiKey: turn.apiKey, namespace: turn.engine.embedding_namespace ?? '' }
        : { model: turn.model, baseUrl: turn.baseUrl, apiKey: turn.apiKey, namespace: `llama.cpp:${turn.model}` });
      const { documentContext, retrievalSources, retrievalCitations, documentChunksTruncated } = await retrieveDocumentContext(pendingDocuments, text, target.model, target.apiKey, target.baseUrl, target.namespace, controller.signal);
      controller.signal.throwIfAborted();
      if (documentChunksTruncated) documentTruncationRef.current = true;
      setContextSources(retrievalSources);
      const requestContent = `${text}${documentContext ?? ""}`;
      const userMessage: api.ChatMessage = {
        role: "user",
        content: images.length ? buildMultimodalContent(requestContent, images, turn.mediaBeforeText) : requestContent,
      };
      const systemMessage: api.ChatMessage = { role: "system", content: buildPersonalizedSystemPrompt(turn.systemPrompt, turn.personalization) };
      const rawHistory = historyOverride ?? (retry && failed ? failed.history : [
        ...(systemMessage.content ? [systemMessage] : []),
        ...msgs.map(message => convertHistoryMessage(historyConversionCacheRef.current!, message, turn.mediaBeforeText)),
        userMessage,
      ]);
      const { contextSize, runtimeContext } = chatContextBudget(requestConfig);
      const maxContextTokens = Math.max(1, Math.floor(contextSize * 0.75));
      // Trimming would truncate the system message; local instructions are never cut silently.
      if (!historyOverride && !(retry && failed) && !runtimeContext && hasPersonalization(turn.personalization)) {
        const systemTokens = estimateMessageTokens(systemMessage);
        if (systemTokens > maxContextTokens - 32) throw new Error(pt("contextTooLarge", { tokens: systemTokens, budget: maxContextTokens }));
      }
      // When the runtime owns context sizing, the old manual number is not a valid limit.
      const bounded = toolFollowup || runtimeContext ? { messages: rawHistory, trimmed: false } : trimChatHistory(rawHistory, maxContextTokens);
      const promptTokens = estimateChatTokens(bounded.messages);
      const chatOptions = runtimeContext ? (requestConfig?.chat_options ?? {}) : capMaxTokens(requestConfig?.chat_options ?? {}, promptTokens, contextSize);
      const warnings = [
        documentTruncationRef.current ? `Only the first ${MAX_SEARCHABLE_DOCUMENT_CHUNKS} document chunks were searched; the rest of the attached document(s) were not included.` : null,
        bounded.trimmed ? "Older messages were omitted from this request to stay within the configured context window." : null,
        turn.personalization?.warnings.length ? pt("instructionWarnings", { warnings: turn.personalization.warnings.join(" ") }) : null,
      ].filter((warning): warning is string => warning !== null);
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
      const sampling = {
        provider: requestConfig?.active_provider,
        provider_options: requestConfig?.provider_options?.[requestConfig.active_provider ?? 'llama.cpp'],
        engine: turn.engine,
        max_tokens_limit: runtimeContext ? undefined : Math.max(1, Math.floor(contextSize - promptTokens - 64)),
        temperature: requestConfig?.temperature ?? CHAT_REQUEST_FALLBACKS.temperature,
        runtime_defaults: requestConfig?.runtime_defaults,
        top_p: requestConfig?.top_p ?? CHAT_REQUEST_FALLBACKS.top_p,
        top_k: requestConfig?.top_k ?? CHAT_REQUEST_FALLBACKS.top_k,
        reasoning: requestConfig?.reasoning ?? CHAT_REQUEST_FALLBACKS.reasoning,
        reasoning_effort: requestConfig?.reasoning_effort ?? CHAT_REQUEST_FALLBACKS.reasoning_effort,
        options: chatOptions,
        tools: turn.tools,
      };
      const streamResponses = preferences?.chat.streamResponses ?? true;
      streamResponsesRef.current = streamResponses;
      const handleDelta = createStreamDeltaHandler({ streamRef, metricsRef, streamResponses, setPhase: () => setPhase("streaming"), scheduleAssistantRender });
      const onDelta = (delta: api.ChatDelta) => { if (isCurrent()) handleDelta(delta); };
      metricsRef.current.requestStartedAt = performance.now();
      setStreamingDraft({ content: "", reasoning: "", metrics: snapshotMetrics(metricsRef.current.requestStartedAt) });
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
          if (current[current.length - 1]?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = { ...next[next.length - 1], content: toolCallAssistant, reasoning: toolCallReasoning, metrics: responseMetrics, finishReason: streamRef.current.finishReason };
          return next;
        });
        setStreamingDraft(null);
        if (toolCall.function.name === SKILL_TOOL_NAME && turn.personalization?.catalog.length && !turn.toolEntries.has(SKILL_TOOL_NAME)) {
          // Reading a listed SKILL.md is read-only, so it runs without the MCP approval step.
          skillReadsRef.current += 1;
          if (skillReadsRef.current > MAX_SKILL_READS_PER_RESPONSE) throw new Error(pt("skillReadLimit", { limit: MAX_SKILL_READS_PER_RESPONSE }));
          setPhase("thinking");
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
        if (toolRoundsRef.current > 4) throw new Error("MCP tool loop limit reached (4 calls per response).");
        setPendingToolCall(resolveDetectedToolCall(toolCall, turn.toolEntries));
        awaitingTool = true;
        setPhase("idle");
        return;
      }

      cancelScheduledRender();
      setMsgs((current) => {
        if (!isCurrent()) return current;
        if (current[current.length - 1]?.role !== "assistant") return current;
        const next = current.slice();
        next[next.length - 1] = {
          ...withoutRetry(next[next.length - 1]),
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
      const isAbort = controller.signal.aborted || (caught instanceof DOMException && caught.name === "AbortError");
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
          if (current[current.length - 1]?.role !== "assistant") return current;
          const next = current.slice();
          next[next.length - 1] = !produced && replacedReply
            ? replacedReply
            : { ...next[next.length - 1], content: partialAssistant, reasoning: partialReasoning, interrupted: isAbort, failed: !isAbort, metrics: responseMetrics };
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

  const approvePendingTool = async () => {
    const pending = pendingToolCall;
    const failed = failedRef.current;
    if (!pending || !failed || phase !== "idle" || ctrlRef.current) return;
    const generation = turnGeneration.current;
    setPendingToolCall(null);
    setToolCallInProgress(true);
    setError(null);
    setPhase("thinking");
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
      await send(false, followupHistory);
    } catch (caught) {
      if (generation !== turnGeneration.current) return;
      releaseActivity();
      turnRef.current = null;
      ctrlRef.current = null;
      setAborting(false);
      setPhase("idle");
      // Recorded from what the app saw, not from a finish reason the runtime may omit.
      const toolRound = controller.signal.aborted ? "cancelled" as const : "failed" as const;
      setMsgs((current) => generation === turnGeneration.current && current.at(-1)?.role === "assistant"
        ? [...current.slice(0, -1), { ...current.at(-1)!, toolRound }] : current);
      if (!controller.signal.aborted) setError(`MCP tool call failed: ${caught instanceof Error ? caught.message : String(caught)}`);
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
    setError("MCP tool call rejected by the user.");
    setPhase("idle");
  };

  const stop = () => {
    setAborting(true);
    ctrlRef.current?.abort();
  };

  return {
    error, setError, contextWarning, contextSources,
    aborting, pendingToolCall, toolCallInProgress, streamingDraft, failedRef, canRetry, retryUnavailable, retryToolsMissing,
    send, approvePendingTool, rejectPendingTool, stop, resetChatState,
  };
}
