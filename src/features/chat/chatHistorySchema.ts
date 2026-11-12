import type { ChatCitation, DocumentAttachment, ImageAttachment } from "../../shared/api/mediaTypes.ts";
import type { ChatContentPart, ChatMessage as ChatRequestMessage } from "../../shared/api/types.ts";
import type { ChatHistoryMessage, ChatRetryTool, ChatRetrySnapshot, ChatThread, ChatWorkspace } from "../../shared/api/conversationTypes.ts";
import { sanitizeResponseMetrics } from "../../shared/lib/metrics.ts";
import { copyMediaPreparation, validMediaPreparation } from './mediaPreparationHistory.ts';

const LOCAL_IMAGE_LIMIT = 512 * 1024;
const LOCAL_DOCUMENT_LIMIT = 64 * 1024;
const PERSISTED_TEXT_LIMIT = 16 * 1024;
const PERSISTED_REASONING_LIMIT = 16 * 1024;
const PERSISTED_MESSAGES_LIMIT = 100;
const PERSISTED_THREADS_LIMIT = 100;
const PERSISTED_RAW_LIMIT = 4 * 1024 * 1024;

function validImage(value: unknown): value is ImageAttachment {
  if (value === null || typeof value !== "object") return false;
  const image = value as Partial<ImageAttachment>;
  return typeof image.name === "string" && typeof image.dataUrl === "string"
    && (image.kind === undefined || ['image', 'audio', 'video'].includes(image.kind))
    && (image.ref === undefined || /^[a-f0-9]{64}\.(?:png|jpe?g|webp|wav|mp3|flac|mp4|webm)$/.test(image.ref))
    && (image.preparation === undefined || validMediaPreparation(image.preparation, image));
}

function validDocument(value: unknown): value is DocumentAttachment {
  if (value === null || typeof value !== "object") return false;
  const document = value as Partial<DocumentAttachment>;
  return typeof document.name === "string"
    && typeof document.path === "string"
    && typeof document.text === "string";
}

function validCitation(value: unknown): value is ChatCitation {
  if (value === null || typeof value !== "object") return false;
  const citation = value as Partial<ChatCitation>;
  return typeof citation.name === "string"
    && typeof citation.path === "string"
    && typeof citation.offset === "number"
    && Number.isInteger(citation.offset)
    && citation.offset >= 0
    && (citation.score === undefined || (typeof citation.score === "number" && Number.isFinite(citation.score)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const optionalString = (value: unknown) => value === undefined || typeof value === "string";

function validContentPart(value: unknown): value is ChatContentPart {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case "text": return typeof value.text === "string";
    case "image_url": return isRecord(value.image_url) && typeof value.image_url.url === "string";
    case "video_url": return isRecord(value.video_url) && typeof value.video_url.url === "string";
    case "input_audio": return isRecord(value.input_audio) && typeof value.input_audio.data === "string" && typeof value.input_audio.format === "string";
    case "input_video": return isRecord(value.input_video) && optionalString(value.input_video.data) && optionalString(value.input_video.url);
    case "aiolm_media": return isRecord(value.media) && typeof value.media.ref === "string" && ["image", "audio", "video"].includes(value.media.kind as string);
    default: return false;
  }
}

function validRequestMessage(value: unknown): value is ChatRequestMessage {
  if (!isRecord(value) || !["system", "user", "assistant", "tool"].includes(value.role as string)) return false;
  return (typeof value.content === "string" || (Array.isArray(value.content) && value.content.every(validContentPart)))
    && optionalString(value.tool_call_id) && optionalString(value.name)
    && (value.tool_calls === undefined || (Array.isArray(value.tool_calls) && value.tool_calls.every((call) => isRecord(call)
      && typeof call.id === "string" && call.type === "function" && isRecord(call.function)
      && typeof call.function.name === "string" && typeof call.function.arguments === "string")));
}

function validRetryTool(value: unknown): value is ChatRetryTool {
  if (!isRecord(value) || !isRecord(value.definition)) return false;
  const definition = value.definition.function;
  return typeof value.serverId === "string" && typeof value.serverName === "string" && typeof value.toolName === "string"
    && value.definition.type === "function" && isRecord(definition) && typeof definition.name === "string"
    && optionalString(definition.description) && isRecord(definition.parameters);
}

export function validRetrySnapshot(value: unknown): value is ChatRetrySnapshot {
  if (!isRecord(value) || value.version !== 1) return false;
  if ("unavailable" in value) return value.unavailable === "local-instructions" || value.unavailable === "too-large";
  return typeof value.text === "string"
    && Array.isArray(value.images) && value.images.every(validImage)
    && Array.isArray(value.documents) && value.documents.every(validDocument)
    && Array.isArray(value.history) && value.history.length > 0 && value.history.every(validRequestMessage)
    && (value.tools === undefined || (Array.isArray(value.tools) && value.tools.every(validRetryTool)));
}

export function validToolRound(value: unknown): value is "cancelled" | "failed" {
  return value === "cancelled" || value === "failed";
}

function validMessage(value: unknown): value is ChatHistoryMessage {
  if (value === null || typeof value !== "object") return false;
  const message = value as Partial<ChatHistoryMessage>;
  return (message.role === "user" || message.role === "assistant")
    && typeof message.content === "string"
    && (message.images === undefined || (Array.isArray(message.images) && message.images.every(validImage)))
    && (message.documents === undefined || (Array.isArray(message.documents) && message.documents.every(validDocument)))
    && (message.reasoning === undefined || typeof message.reasoning === "string")
    && (message.interrupted === undefined || typeof message.interrupted === "boolean")
    && (message.failed === undefined || typeof message.failed === "boolean")
    && (message.citations === undefined || (Array.isArray(message.citations) && message.citations.every(validCitation)));
}

export function normalizeThread(value: unknown): ChatThread | null {
  if (value === null || typeof value !== "object") return null;
  const thread = value as Partial<ChatThread>;
  if (typeof thread.id !== "string" || !thread.id || typeof thread.title !== "string") return null;
  if (!Array.isArray(thread.messages) || !thread.messages.every(validMessage)) return null;
  return {
    id: thread.id,
    title: thread.title.trim() || "New conversation",
    systemPrompt: typeof thread.systemPrompt === "string" ? thread.systemPrompt : "You are a helpful assistant.",
    ...(thread.useDefaultSystemPrompt === false ? { useDefaultSystemPrompt: false } : {}),
    ...(thread.mediaBeforeText === true ? { mediaBeforeText: true } : {}),
    ...(thread.projectBinding && typeof thread.projectBinding.id === 'string'
      && thread.projectBinding.id.length > 0 && thread.projectBinding.id.length <= 256
      && typeof thread.projectBinding.updatedAt === 'number' && Number.isFinite(thread.projectBinding.updatedAt)
      ? { projectBinding: { id: thread.projectBinding.id, updatedAt: thread.projectBinding.updatedAt } } : {}),
    createdAt: typeof thread.createdAt === "number" ? thread.createdAt : Date.now(),
    updatedAt: typeof thread.updatedAt === "number" ? thread.updatedAt : Date.now(),
    messages: thread.messages,
  };
}

export function normalizeWorkspace(value: unknown): ChatWorkspace | null {
  if (value === null || typeof value !== "object") return null;
  const parsed = value as Partial<ChatWorkspace>;
  const threads = Array.isArray(parsed.threads)
    ? parsed.threads.map(normalizeThread).filter((thread): thread is ChatThread => thread !== null)
    : [];
  const first = threads[0];
  if (!first) return null;
  const activeThreadId = typeof parsed.activeThreadId === "string" && threads.some((thread) => thread.id === parsed.activeThreadId)
    ? parsed.activeThreadId
    : first.id;
  return { activeThreadId, threads };
}

export function parseWorkspace(raw: string | null): ChatWorkspace | null {
  if (!raw || raw.length > PERSISTED_RAW_LIMIT) return null;
  try {
    return normalizeWorkspace(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function safeThread(thread: ChatThread, nativeRuntime: boolean): ChatThread {
  return {
    ...thread,
    systemPrompt: thread.systemPrompt.slice(0, PERSISTED_TEXT_LIMIT),
    messages: thread.messages.slice(-PERSISTED_MESSAGES_LIMIT).map((message, index, kept) => {
      const safeMessage: ChatHistoryMessage = {
        role: message.role,
        content: message.content.slice(0, PERSISTED_TEXT_LIMIT),
      };
      if (message.role === "assistant" && typeof message.model === "string" && message.model.trim()) {
        safeMessage.model = message.model.trim().slice(0, 4096);
      }
      if (message.reasoning !== undefined) safeMessage.reasoning = message.reasoning.slice(0, PERSISTED_REASONING_LIMIT);
      if (message.interrupted) safeMessage.interrupted = true;
      if (message.failed) safeMessage.failed = true;
      if (message.role === 'assistant' && typeof message.finishReason === 'string' && message.finishReason) {
        safeMessage.finishReason = message.finishReason.slice(0, 128);
      }
      if (message.role === 'assistant' && validToolRound(message.toolRound)) safeMessage.toolRound = message.toolRound;
      if (message.images !== undefined) {
        safeMessage.images = message.images.slice(0, 4).map((image) => ({
          name: image.name,
          ...(image.ref ? { ref: image.ref, kind: image.kind ?? 'image', mime: image.mime, sizeBytes: image.sizeBytes } : {}),
          ...(image.preparation && validMediaPreparation(image.preparation, image) ? { preparation: copyMediaPreparation(image.preparation) } : {}),
          dataUrl: image.ref ? '' : image.dataUrl.length <= (nativeRuntime ? 64 * 1024 * 1024 : LOCAL_IMAGE_LIMIT) ? image.dataUrl : "",
        }));
      }
      if (message.documents !== undefined) {
        safeMessage.documents = message.documents.slice(0, 4).map((document) => ({
          ...document,
          text: document.text.slice(0, LOCAL_DOCUMENT_LIMIT),
        }));
      }
      if (message.citations !== undefined) safeMessage.citations = message.citations.slice(0, 64);
      const metrics = sanitizeResponseMetrics(message.metrics);
      if (metrics) safeMessage.metrics = metrics;
      // Only the last reply can be retried; an earlier snapshot is superseded.
      if (message.role === "assistant" && index === kept.length - 1 && validRetrySnapshot(message.retry)) safeMessage.retry = message.retry;
      return safeMessage;
    }),
  };
}

function localSafeWorkspace(workspace: ChatWorkspace, nativeRuntime: boolean): ChatWorkspace {
  const active = workspace.threads.find((thread) => thread.id === workspace.activeThreadId);
  const orderedThreads = active
    ? [active, ...workspace.threads.filter((thread) => thread.id !== active.id)]
    : workspace.threads;
  return {
    ...workspace,
    threads: orderedThreads.slice(0, PERSISTED_THREADS_LIMIT).map((thread) => safeThread(thread, nativeRuntime)),
  };
}

export function persistedWorkspace(workspace: ChatWorkspace, nativeRuntime: boolean): ChatWorkspace {
  const safe = localSafeWorkspace(workspace, nativeRuntime);
  const threads = safe.threads.filter((thread) => thread.messages.length > 0 || thread.id === safe.activeThreadId);
  return {
    ...safe,
    threads: threads.length ? threads : safe.threads.slice(0, 1),
    activeThreadId: threads.some((thread) => thread.id === safe.activeThreadId)
      ? safe.activeThreadId
      : threads[0]?.id ?? safe.activeThreadId,
  };
}
