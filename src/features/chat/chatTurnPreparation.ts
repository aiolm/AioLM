import type { ChatMessage } from "../../shared/api/types";
import type { ChatHistoryMessage } from "../../shared/api/conversationTypes";
import type { DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes";
import type { Locale } from "../../shared/i18n/i18nCatalog";
import { translate } from "../../shared/i18n/i18nUnified";
import { chatPersonalizationText } from "../../shared/i18n/chatPersonalizationText";
import { CHAT_REQUEST_FALLBACKS } from "../../shared/config/chatRequestFallbacks";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, estimateMessageTokens, MAX_SEARCHABLE_DOCUMENT_CHUNKS, trimChatHistory } from "./chatUtils";
import { buildPersonalizedSystemPrompt, hasPersonalization, prepareTurnPersonalization, SKILL_TOOL_NAME, skillToolDefinition } from "./chatPersonalization";
import { prepareChatAttachments } from "./mediaPreprocessing";
import { retrieveDocumentContext } from "./chatSendHelpers";
import { convertHistoryMessage, type HistoryConversionCache } from "./chatHistoryConversion";
import { chatContextBudget } from "./providerChatContext";
import type { ChatTurnSnapshot } from "./chatSendOptions";
import type { FailedRequest } from "./chatSendTypes";

export async function prepareTurnMedia(turn: ChatTurnSnapshot, images: ImageAttachment[], signal: AbortSignal) {
  if (images.length && (turn.engine || turn.mediaPreprocessing)) {
    images = await prepareChatAttachments(images, turn.engine?.modalities ?? {
      text: true, image: !!turn.config?.mmproj, audio: false, video: false,
    }, turn.mediaPreprocessing ?? { videoFrames: false }, signal);
    signal.throwIfAborted();
  }
  return images;
}

/** Retry uses the accepted turn's frozen instructions, never rereading local files. */
export async function prepareTurnSkills(turn: ChatTurnSnapshot, text: string, skillIds: string[], retry: boolean, failed: FailedRequest | null, signal: AbortSignal, locale: Locale) {
  turn.personalization = retry && failed ? failed.personalization ?? null : await prepareTurnPersonalization(text, skillIds, signal,
    (key, vars) => chatPersonalizationText(locale, key, vars));
  signal.throwIfAborted();
  // Explicitly selected/named skills stay inline on runtimes without tool calls.
  if (turn.personalization?.catalog.length && turn.engine?.tools_auto === false) turn.personalization = { ...turn.personalization, catalog: [] };
  if (turn.personalization?.catalog.length && !turn.toolEntries.has(SKILL_TOOL_NAME)) turn.tools = [...turn.tools, skillToolDefinition()];
}

export function retrieveTurnDocuments(turn: ChatTurnSnapshot, documents: DocumentAttachment[], text: string, signal: AbortSignal) {
  const target = turn.embeddingTarget ?? (turn.engine?.provider && turn.engine.provider !== 'llama.cpp'
    ? { model: turn.engine.embedding_model ?? '', baseUrl: turn.baseUrl, apiKey: turn.apiKey, namespace: turn.engine.embedding_namespace ?? '' }
    : { model: turn.model, baseUrl: turn.baseUrl, apiKey: turn.apiKey, namespace: `llama.cpp:${turn.model}` });
  return retrieveDocumentContext(documents, text, target.model, target.apiKey, target.baseUrl, target.namespace, signal);
}

export function buildTurnRequest({ turn, text, images, documentContext, suppliedHistory, msgs, cache, toolFollowup, documentChunksTruncated, locale }: {
  turn: ChatTurnSnapshot;
  text: string;
  images: ImageAttachment[];
  documentContext: string | null;
  suppliedHistory: ChatMessage[] | undefined;
  msgs: ChatHistoryMessage[];
  cache: HistoryConversionCache;
  toolFollowup: boolean;
  documentChunksTruncated: boolean;
  locale: Locale;
}) {
  const requestConfig = turn.config;
  const requestContent = `${text}${documentContext ?? ""}`;
  const userMessage: ChatMessage = {
    role: "user",
    content: images.length ? buildMultimodalContent(requestContent, images, turn.mediaBeforeText) : requestContent,
  };
  // Supplied history already carries this turn's frozen system prompt.
  const systemMessage: ChatMessage | undefined = suppliedHistory === undefined
    ? { role: "system", content: buildPersonalizedSystemPrompt(turn.systemPrompt, turn.personalization) }
    : undefined;
  const rawHistory = suppliedHistory ?? [
    ...(systemMessage?.content ? [systemMessage] : []),
    ...msgs.map(message => convertHistoryMessage(cache, message, turn.mediaBeforeText)), userMessage,
  ];
  const { contextSize, runtimeContext } = chatContextBudget(requestConfig);
  const maxContextTokens = Math.max(1, Math.floor(contextSize * 0.75));
  if (systemMessage && !runtimeContext && hasPersonalization(turn.personalization)) {
    const systemTokens = estimateMessageTokens(systemMessage);
    if (systemTokens > maxContextTokens - 32) throw new Error(chatPersonalizationText(locale, "contextTooLarge", { tokens: systemTokens, budget: maxContextTokens }));
  }
  // Runtime context sizing supersedes the old manual token limit.
  const bounded = toolFollowup || runtimeContext ? { messages: rawHistory, trimmed: false } : trimChatHistory(rawHistory, maxContextTokens);
  const promptTokens = estimateChatTokens(bounded.messages);
  const chatOptions = runtimeContext ? (requestConfig?.chat_options ?? {}) : capMaxTokens(requestConfig?.chat_options ?? {}, promptTokens, contextSize);
  const warnings = [
    documentChunksTruncated ? translate(locale, "chat.documentChunksLimited", { count: MAX_SEARCHABLE_DOCUMENT_CHUNKS }) : null,
    bounded.trimmed ? translate(locale, "chat.historyTrimmed") : null,
    turn.personalization?.warnings.length ? chatPersonalizationText(locale, "instructionWarnings", { warnings: turn.personalization.warnings.join(" ") }) : null,
  ].filter((warning): warning is string => warning !== null);
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
  return { bounded, runtimeContext, maxContextTokens, warnings, sampling };
}
