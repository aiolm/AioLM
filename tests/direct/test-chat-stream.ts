import assert from "node:assert/strict";
import { buildChatRequestBody, consumeChatStream, readBoundedResponseText } from "../../src/shared/api/index.ts";
import { buildMultimodalContent, capMaxTokens, estimateChatTokens, trimChatHistory } from "../../src/features/chat/chatUtils.ts";
import { SseParser, type StreamDelta } from "../../src/shared/api/sse.ts";

const encoder = new TextEncoder();

function stream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function frame(content: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
}

const complete = await consumeChatStream(
  stream([encoder.encode(frame("ok") + "data: [DONE]\n\n")]),
  () => undefined,
);
assert.equal(complete, "ok");

let cancelled = false;
const openStream = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode(frame("done") + "data: [DONE]\n\n"));
  },
  cancel() {
    cancelled = true;
  },
});
assert.equal(await consumeChatStream(openStream, () => undefined), "done");
assert.equal(cancelled, true);

const oversizedFrame = `data: ${"x".repeat(5 * 1024 * 1024)}`;
assert.throws(() => new SseParser(() => undefined).push(oversizedFrame), /SSE frame exceeds/);

const oversizedErrorBody = new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(encoder.encode("x".repeat(2 * 1024 * 1024)));
    controller.close();
  },
});
await assert.rejects(
  () => readBoundedResponseText(new Response(oversizedErrorBody), 1024),
  /response body exceeds/,
);

await assert.rejects(
  () => consumeChatStream(stream([encoder.encode(frame("partial"))]), () => undefined),
  /ended the response before completing the stream/,
);

const unicode = "안녕";
const bytes = encoder.encode(frame(unicode) + "data: [DONE]\n\n");
const split = Math.max(1, bytes.findIndex((value) => value >= 0x80));
const decoded = await consumeChatStream(
  stream([bytes.slice(0, split), bytes.slice(split)]),
  () => undefined,
);
assert.equal(decoded, unicode);

const multimodal = buildMultimodalContent("describe this", [{ name: "image.png", dataUrl: "data:image/png;base64,AA==" }]);
assert.equal(multimodal[0].type, "text");
assert.equal(multimodal[1].type, "image_url");
const trimmed = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "old message".repeat(200) },
  { role: "assistant", content: "old answer".repeat(200) },
  { role: "user", content: "latest" },
], 100);
assert.equal(trimmed.trimmed, true);
assert.equal(trimmed.messages[0].role, "system");
assert.equal(trimmed.messages.at(-1)?.content, "latest");

const orphanSafe = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "long user turn ".repeat(100) },
  { role: "assistant", content: "answer" },
], 50);
assert.equal(orphanSafe.messages.at(-1)?.role, "user");

const oversizedLatest = trimChatHistory([
  { role: "system", content: "system" },
  { role: "user", content: "latest user content ".repeat(10_000) },
  { role: "assistant", content: "latest answer" },
], 256);
assert.ok(estimateChatTokens(oversizedLatest.messages) <= 256);

const promptTokens = estimateChatTokens([{ role: "user", content: "x".repeat(16384) }]);
const capped = capMaxTokens({ max_tokens: 4096, keep: true }, promptTokens, 4096);
assert.equal(capped.max_tokens, 1);
assert.equal(capped.keep, true);

const mappedRequest = buildChatRequestBody("local-model", [{ role: "user", content: "hello" }], {
  temperature: 0.8,
  top_p: 0.95,
  top_k: 40,
  options: { mirostat_lr: 0.2, mirostat_ent: 4, seed: 7 },
});
assert.equal(mappedRequest.mirostat_eta, 0.2);
assert.equal(mappedRequest.mirostat_tau, 4);
assert.equal(mappedRequest.mirostat_lr, undefined);
assert.equal(mappedRequest.mirostat_ent, undefined);
assert.equal(mappedRequest.seed, 7);
assert.equal(mappedRequest.timings_per_token, true);
assert.deepEqual(mappedRequest.stream_options, { include_usage: true });

const sampling = Object.freeze({
  temperature: 0.8, top_p: 0.95, top_k: 40,
  options: Object.freeze({ timings_per_token: false, stream_options: Object.freeze({ include_usage: false, include_obfuscation: false }) }),
});
const explicitMetricsRequest = buildChatRequestBody("local-model", [], sampling);
assert.equal(explicitMetricsRequest.timings_per_token, false);
assert.deepEqual(explicitMetricsRequest.stream_options, { include_usage: false, include_obfuscation: false });
assert.notEqual(explicitMetricsRequest.stream_options, sampling.options.stream_options);
const defaultMetricsOptions = Object.freeze({ stream_options: Object.freeze({ include_obfuscation: false }) });
const defaultMetricsRequest = buildChatRequestBody("local-model", [], { ...sampling, options: defaultMetricsOptions });
assert.deepEqual(defaultMetricsRequest.stream_options, { include_usage: true, include_obfuscation: false });
assert.deepEqual(defaultMetricsOptions, { stream_options: { include_obfuscation: false } });

const statsDeltas: StreamDelta[] = [];
const statsFrames = frame("reply")
  + `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`
  + `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 5 }, timings: { prompt_n: 40, predicted_n: 5, predicted_ms: 100 } })}\n\n`
  + "data: [DONE]\n\n";
assert.equal(await consumeChatStream(stream([encoder.encode(statsFrames)]), (delta) => statsDeltas.push(delta)), "reply");
assert.equal(statsDeltas.at(-1)?.usage?.completion_tokens, 5);
assert.equal(statsDeltas.at(-1)?.timings?.predicted_ms, 100);

const toolChunks: StreamDelta[] = [];
const toolParser = new SseParser((delta) => toolChunks.push(delta));
toolParser.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "plan" } }] })}\n\n`);
toolParser.push(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "search", arguments: JSON.stringify({ q: "llama" }) } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 2 } })}\n\n`);
assert.equal(toolChunks[0]?.reasoning, "plan");
assert.equal(toolChunks[1]?.tool_calls?.[0]?.name, "search");
assert.equal(toolChunks[1]?.finish_reason, "tool_calls");
assert.equal(toolChunks[1]?.usage?.prompt_tokens, 4);

console.log("Chat stream tests passed");
