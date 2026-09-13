import type * as api from "../../shared/api/types";
import type { DocumentAttachment, ImageAttachment } from "./chatUtils";
import type { StreamTimings, StreamUsage } from "../../shared/api/sse";
import type { ResponseMetrics } from "../../shared/lib/metrics";

export interface FailedRequest {
  text: string;
  images: ImageAttachment[];
  documents: DocumentAttachment[];
  history: api.ChatMessage[];
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
