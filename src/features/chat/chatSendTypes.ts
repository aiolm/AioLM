import type * as api from "../../shared/api/types";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import type { StreamTimings, StreamUsage } from "../../shared/api/sse";
import type { ResponseMetrics } from "../../shared/lib/metrics";
import type { TurnPersonalization } from "./chatPersonalization";

export interface FailedRequest {
  text: string;
  images: ImageAttachment[];
  documents: DocumentAttachment[];
  history: api.ChatMessage[];
  /** The turn's local instructions and skills, reused as-is by a retry. */
  personalization?: TurnPersonalization | null;
  partialAssistant?: string;
  partialReasoning?: string;
}

export interface RequestMetricsAccumulator {
  preparationStartedAt: number;
  requestStartedAt?: number;
  firstTokenAt?: number;
  usage?: StreamUsage;
  timings?: StreamTimings;
}

export interface StreamingDraft {
  content: string;
  reasoning: string;
  metrics?: ResponseMetrics;
}

export interface PendingToolCall {
  serverId: string;
  serverName: string;
  toolName: string;
  call: api.ChatToolCall;
  argumentsValue: Record<string, unknown>;
}
