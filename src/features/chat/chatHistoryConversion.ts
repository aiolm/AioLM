import type * as api from "../../shared/api/types";
import type { ChatHistoryMessage as Msg } from "../../shared/api/conversationTypes";
import { toChatMessage } from "./chatSendHelpers";

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
export { createHistoryConversionCache, convertHistoryMessage };
export type { HistoryConversionCache };
