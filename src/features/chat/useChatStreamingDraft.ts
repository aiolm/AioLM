import { useRef, useState } from "react";
import { buildResponseMetrics } from "../../shared/lib/metrics";
import type { RequestMetricsAccumulator } from "./chatSendTypes";
import type { StreamAccumulator } from "./chatSendHelpers";
import { createStreamingDraftStore } from "./streamingDraftStore";

/** Animation frames update only the draft subscriber, never the full panel. */
export function useChatStreamingDraft() {
  const [streamingDraftStore] = useState(createStreamingDraftStore);
  const setStreamingDraft = streamingDraftStore.setDraft;
  const renderFrameRef = useRef<number | null>(null);
  const streamRef = useRef<StreamAccumulator>({ assistant: "", reasoning: "", toolCalls: [] });
  const metricsRef = useRef<RequestMetricsAccumulator>({ preparationStartedAt: 0 });
  const streamResponsesRef = useRef(true);
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

  return { streamingDraftStore, setStreamingDraft, renderFrameRef, streamRef, metricsRef, streamResponsesRef, cancelScheduledRender, snapshotMetrics, scheduleAssistantRender };
}
