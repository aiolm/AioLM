import { SseParser } from "./sse.ts";
import {
  anthropicMessagesUrl,
  buildAnthropicMessagesRequestBody,
  buildNativeChatRequestBody,
  consumeAnthropicStream,
  consumeNativeChatStream,
  nativeChatUrl,
  type AnthropicTool,
} from "./endpointAdapters.ts";
import { mapChatOptionAliases, type JsonObject } from "../config/tuningValidation.ts";
import { readBoundedResponseText } from "./http.ts";
import type { ChatDelta, ChatMessage, ChatRequestBody, ChatSampling } from "./types.ts";
import { resolveMedia } from './commands.ts';
import { providerRequestFields } from '../config/providerRequestSettings.ts';

function asJsonObject(value: unknown): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

export function buildChatRequestBody(
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
): ChatRequestBody {
  if ((sampling.provider ?? sampling.engine?.provider ?? 'llama.cpp') !== 'llama.cpp') {
    const engine = sampling.engine;
    if (!engine) throw new Error('Runtime request capabilities are not ready.');
    if (engine.tasks && !engine.tasks.includes('generate')) throw new Error('Select a generation session for chat; this session serves a different task.');
    if (sampling.tools?.length && engine.tools_auto === false) throw new Error('Enable automatic tool choice and select the model tool parser in the runtime profile.');
    const fields = { ...(sampling.provider_options === undefined ? engine.request_fields : providerRequestFields(engine.provider, sampling.provider_options)) };
    if (typeof fields.max_tokens === 'number' && Number.isFinite(fields.max_tokens)
      && typeof sampling.max_tokens_limit === 'number' && Number.isSafeInteger(sampling.max_tokens_limit) && sampling.max_tokens_limit > 0) {
      fields.max_tokens = Math.min(fields.max_tokens, sampling.max_tokens_limit);
    }
    const selectedLora = engine.provider === 'vllm' && typeof sampling.provider_options?.request_lora === 'string' ? sampling.provider_options.request_lora : undefined;
    return { ...fields, model: selectedLora || (sampling.provider_options === undefined ? engine.request_lora : undefined) || engine.upstream_model,
      messages, stream: true, stream_options: { include_usage: true },
      ...(sampling.tools?.length ? { tools: sampling.tools } : {}) };
  }
  const options = mapChatOptionAliases(sampling.options ?? {});
  const streamOptions = asJsonObject(options.stream_options) ?? {};
  const body: ChatRequestBody = {
    ...options,
    timings_per_token: options.timings_per_token ?? true,
    stream_options: { ...streamOptions, include_usage: streamOptions.include_usage ?? true },
    model,
    messages,
    stream: true,
    ...(!sampling.runtime_defaults?.includes("temperature") ? { temperature: sampling.temperature } : {}),
    ...(!sampling.runtime_defaults?.includes("top_p") ? { top_p: sampling.top_p } : {}),
    ...(!sampling.runtime_defaults?.includes("top_k") ? { top_k: sampling.top_k } : {}),
    tools: sampling.tools?.length ? sampling.tools : undefined,
  };
  const reasoningEffort = sampling.reasoning === "off" && !sampling.runtime_defaults?.includes("reasoning")
    ? "none" : !sampling.runtime_defaults?.includes("reasoning_effort") ? sampling.reasoning_effort : undefined;
  if (reasoningEffort && reasoningEffort !== "default") {
    body.reasoning_effort = reasoningEffort;
    const chatTemplateKwargs = {
      ...(asJsonObject(options.chat_template_kwargs) ?? {}),
    };
    if (reasoningEffort === "none") {
      chatTemplateKwargs.enable_thinking = false;
      delete chatTemplateKwargs.reasoning_effort;
    } else {
      chatTemplateKwargs.enable_thinking = true;
      chatTemplateKwargs.reasoning_effort = reasoningEffort;
    }
    body.chat_template_kwargs = chatTemplateKwargs;
  }
  return body;
}

export async function consumeChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: ChatDelta) => void,
): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseParser(onDelta);
  let doneFrame = false;
  try {
    while (!doneFrame) {
      const { done, value } = await reader.read();
      if (done) break;
      doneFrame = parser.push(decoder.decode(value, { stream: true }));
    }
    if (!doneFrame) {
      parser.push(decoder.decode());
      parser.finish();
      if (!parser.isFinished()) {
        throw new Error("The server ended the response before completing the stream.");
      }
    }
    return parser.value();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed by the transport.
    } finally {
      reader.releaseLock();
    }
  }
}

export async function chatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const url = baseUrl.replace(/\/v1$/, "") + "/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(buildChatRequestBody(model, await materializeMedia(messages, sampling, signal), sampling)),
    signal,
  });
  if (!res.ok) {
    const body = await readBoundedResponseText(res);
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  if (!res.body) throw new Error("The server returned an empty response stream.");

  return consumeChatStream(res.body, onDelta);
}

async function materializeMedia(messages: ChatMessage[], sampling: ChatSampling, signal?: AbortSignal): Promise<ChatMessage[]> {
  const provider = sampling.engine?.provider ?? sampling.provider ?? 'llama.cpp';
  return Promise.all(messages.map(async message => {
    if (typeof message.content === 'string') return message;
    const content = await Promise.all(message.content.map(async part => {
      signal?.throwIfAborted();
      const kind = part.type === 'aiolm_media' ? part.media.kind : part.type === 'image_url' ? 'image' : part.type === 'input_audio' ? 'audio' : ['input_video', 'video_url'].includes(part.type) ? 'video' : 'text';
      if (sampling.engine && !sampling.engine.modalities[kind as keyof typeof sampling.engine.modalities]) throw new Error(`The running model does not support ${kind} input.`);
      const resolved = part.type === 'aiolm_media' ? await resolveMedia(part.media.ref, provider) : part;
      signal?.throwIfAborted();
      return resolved;
    }));
    return { ...message, content };
  }));
}

export async function nativeChatStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  previousResponseId?: string,
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const response = await fetch(nativeChatUrl(baseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(buildNativeChatRequestBody(model, await materializeMedia(messages, sampling, signal), sampling, previousResponseId)),
    signal,
  });
  if (!response.ok) {
    const body = await readBoundedResponseText(response);
    throw new Error(`Native API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("The native API returned an empty response stream.");
  return consumeNativeChatStream(response.body, (delta) => {
    onDelta({ reasoning: delta.reasoning, content: delta.text, usage: delta.usage });
  });
}

export async function anthropicMessagesStream(
  baseUrl: string,
  apiKey: string,
  model: string,
  messages: ChatMessage[],
  sampling: ChatSampling,
  onDelta: (delta: ChatDelta) => void,
  tools: AnthropicTool[] = [],
  signal?: AbortSignal,
): Promise<string> {
  if (!apiKey) throw new Error("Server authentication is not ready; retry after the server becomes ready.");
  const response = await fetch(anthropicMessagesUrl(baseUrl), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(buildAnthropicMessagesRequestBody(model, await materializeMedia(messages, sampling, signal), sampling, tools)),
    signal,
  });
  if (!response.ok) {
    const body = await readBoundedResponseText(response);
    throw new Error(`Anthropic-compatible API HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  if (!response.body) throw new Error("The Anthropic-compatible API returned an empty response stream.");
  return consumeAnthropicStream(response.body, (delta) => {
    onDelta({ reasoning: delta.thinking, content: delta.text, usage: delta.usage });
  });
}
