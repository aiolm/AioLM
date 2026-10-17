/* global TextDecoder */
import { SseParser } from '../src/shared/api/sse.ts';

/** A reasoning token is generation output, but never a final answer. */
export async function readRuntimeAdapterStream(response, { controller, cancel = false }) {
  let content = '', reasoningChars = 0, usage, finishReason, abortRequested = false;
  const parser = new SseParser(delta => {
    content += delta.content ?? '';
    reasoningChars += delta.reasoning?.length ?? 0;
    if (delta.usage) usage = delta.usage;
    if (delta.finish_reason != null) finishReason = delta.finish_reason;
  });
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      parser.push(decoder.decode(chunk, { stream: true }));
      if (cancel && (content || reasoningChars)) {
        if (parser.isFinished() || finishReason !== undefined) throw new Error('Stream completed before cancellation could be exercised');
        abortRequested = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!abortRequested || error?.name !== 'AbortError') throw error;
  }
  if (abortRequested) return {
    content, reasoningChars, usage,
    streamAbortedAfterOutput: true,
    streamAbortedAfterContent: content.length > 0,
    cancelledOn: content ? 'content' : 'reasoning',
  };
  parser.push(decoder.decode());
  parser.finish();
  if (cancel) throw new Error('Stream ended before cancellation could be exercised');
  return { content, reasoningChars, usage };
}
