/* global TextDecoder, AbortController, setTimeout, clearTimeout */
import { SseParser } from '../src/shared/api/sse.ts';

/**
 * @typedef {import('../src/shared/api/sse.ts').StreamUsage} StreamUsage
 * @typedef {{content: string, reasoningChars: number, usage?: StreamUsage, streamAbortedAfterOutput?: boolean, streamAbortedAfterContent?: boolean, cancelledOn?: string}} AdapterStreamResult
 */

/** A reasoning token is generation output, but never a final answer. */
/**
 * @param {{body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | null}} response
 * @param {{controller: AbortController, cancel?: boolean}} options
 * @returns {Promise<AdapterStreamResult>}
 */
export async function readRuntimeAdapterStream(response, { controller, cancel = false }) {
  let content = '', reasoningChars = 0, abortRequested = false;
  /** @type {StreamUsage | undefined} */
  let usage;
  /** @type {string | undefined} */
  let finishReason;
  const parser = new SseParser(delta => {
    content += delta.content ?? '';
    reasoningChars += delta.reasoning?.length ?? 0;
    if (delta.usage) usage = delta.usage;
    if (delta.finish_reason != null) finishReason = delta.finish_reason;
  });
  const decoder = new TextDecoder();
  try {
    // Fetch bodies and the test fixture both expose the async iterator at runtime.
    for await (const chunk of /** @type {AsyncIterable<Uint8Array>} */ (response.body)) {
      parser.push(decoder.decode(chunk, { stream: true }));
      if (cancel && (content || reasoningChars)) {
        if (parser.isFinished() || finishReason !== undefined) throw new Error('Stream completed before cancellation could be exercised');
        abortRequested = true;
        controller.abort();
        break;
      }
    }
  } catch (error) {
    if (!abortRequested || error === null || typeof error !== 'object' || !('name' in error) || error.name !== 'AbortError') throw error;
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

/** Exact protocol acceptance is shared by every external engine. */
/**
 * @param {{content: string, usage?: {prompt_tokens?: number, completion_tokens?: number}}} result
 * @param {string} expectedAnswer
 */
export function validateRuntimeAdapterCompletion({ content, usage }, expectedAnswer) {
  if (content.trim() !== expectedAnswer) throw new Error('The final answer did not exactly match the expected answer');
  if (typeof usage?.prompt_tokens !== 'number' || !Number.isSafeInteger(usage.prompt_tokens) || usage.prompt_tokens <= 0
      || typeof usage?.completion_tokens !== 'number' || !Number.isSafeInteger(usage.completion_tokens) || usage.completion_tokens <= 0) {
    throw new Error('Authoritative tokenizer usage was not supplied');
  }
  return { content, usage, answerExact: true };
}

/** Cancellation recovery must not be disguised by a server restart. */
/**
 * @param {{state?: string, pid?: number}} before
 * @param {{state?: string, pid?: number}} afterCancel
 * @param {{state?: string, pid?: number}} afterFollowup
 */
export function validateRuntimeAdapterRecovery(before, afterCancel, afterFollowup) {
  if (![before, afterCancel, afterFollowup].every(status => status.state === 'running'
      && typeof status.pid === 'number' && Number.isSafeInteger(status.pid) && status.pid > 0 && status.pid === before.pid)) {
    throw new Error('Cancellation and follow-up must preserve the same running server process');
  }
  return true;
}

export const DEFAULT_RUNTIME_ADAPTER_REQUEST_TIMEOUT_MS = 120000;

/** @param {unknown} value */
export function validateRuntimeAdapterRequestTimeout(value) {
  const timeoutMs = typeof value === 'string' && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600000) {
    throw new Error('--request-timeout-ms must be an integer from 1 to 600000');
  }
  return timeoutMs;
}

/** Keep the deadline active until both response headers and the whole SSE body settle. */
/**
 * @template T
 * @param {(controller: AbortController) => Promise<T>} operation
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
export async function withRuntimeAdapterRequestDeadline(operation, timeoutMs = DEFAULT_RUNTIME_ADAPTER_REQUEST_TIMEOUT_MS) {
  const deadlineMs = validateRuntimeAdapterRequestTimeout(timeoutMs);
  const controller = new AbortController();
  let expired = false;
  const deadline = setTimeout(() => { expired = true; controller.abort(); }, deadlineMs);
  try {
    const result = await operation(controller);
    if (expired) throw new Error(`Runtime adapter request timed out after ${deadlineMs}ms`);
    return result;
  } catch (error) {
    // readRuntimeAdapterStream handles intentional generation cancellation.
    // A deadline abort must remain a failure, even if output arrived at the boundary.
    if (expired) throw new Error(`Runtime adapter request timed out after ${deadlineMs}ms`);
    // Close an unread body too, such as a non-2xx response rejected before SSE parsing.
    controller.abort();
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}
