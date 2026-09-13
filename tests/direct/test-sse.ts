import assert from "node:assert/strict";
import { normalizeStreamDelta, SseParser, type StreamDelta } from "../../src/shared/api/sse.ts";

const deltas: StreamDelta[] = [];
const parser = new SseParser((delta) => deltas.push(delta));
const reasoningFrame = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "think" } }] })}\n\n`;
const contentFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "hel" } }] })}\n\n`;
const finalFrame = `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`;
assert.equal(parser.push(reasoningFrame.slice(0, 12)), false);
assert.equal(parser.push(reasoningFrame.slice(12) + contentFrame), false);
assert.equal(parser.push(finalFrame + "data: [DONE]\n\n"), true);
assert.equal(parser.value(), "hello");
assert.equal(deltas.length, 3);
assert.equal(deltas[0].reasoning, "think");
assert.equal(deltas[1].content, "hel");
assert.equal(deltas[2].content, "lo");

const partial = new SseParser(() => undefined);
partial.push(`data: ${JSON.stringify({ choices: [{ delta: { content: "tail" } }] })}`);
assert.equal(partial.finish(), "tail");
assert.equal(partial.isFinished(), false);

const complete = new SseParser(() => undefined);
complete.push("data: [DONE]\n\n");
assert.equal(complete.isFinished(), true);

const malformed = new SseParser(() => undefined);
assert.throws(() => malformed.push("data: {not-json}\n"), /invalid SSE frame/);

const metricDeltas: StreamDelta[] = [];
const metricParser = new SseParser((delta) => metricDeltas.push(delta));
const metricFrame = `data: ${JSON.stringify({ choices: [], timings: { prompt_n: 120, prompt_ms: 30 } })}\r\n\r\n`;
metricParser.push(metricFrame.slice(0, 43));
metricParser.push(metricFrame.slice(43));
assert.equal(metricDeltas.length, 1);
assert.deepEqual(metricDeltas[0].timings, { prompt_n: 120, prompt_ms: 30 });
assert.equal(metricParser.isFinished(), false);
assert.deepEqual(normalizeStreamDelta(metricDeltas[0]), [
  { type: "stats", usage: undefined, timings: { prompt_n: 120, prompt_ms: 30 } },
]);
assert.deepEqual(normalizeStreamDelta({ content: "next", finish_reason: null, timings: { predicted_n: 2 } }), [
  { type: "text_delta", text: "next" },
  { type: "stats", usage: undefined, timings: { predicted_n: 2 } },
]);
assert.deepEqual(normalizeStreamDelta({ finish_reason: null }), []);
assert.deepEqual(normalizeStreamDelta({ usage: { completion_tokens: 3 } }), [
  { type: "stats", usage: { completion_tokens: 3 }, timings: undefined },
]);
assert.deepEqual(normalizeStreamDelta({ finish_reason: "stop", usage: { completion_tokens: 3 }, timings: { predicted_n: 3 } }), [
  { type: "completed", finishReason: "stop", usage: { completion_tokens: 3 }, timings: { predicted_n: 3 } },
]);
metricParser.push(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
metricParser.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 150, completion_tokens: 20 }, timings: { predicted_n: 20, predicted_ms: 400 } })}\n\n`);
assert.deepEqual(normalizeStreamDelta(metricDeltas[1]), [
  { type: "completed", finishReason: "stop", usage: undefined, timings: undefined },
]);
assert.equal(normalizeStreamDelta(metricDeltas[2])[0].type, "stats");
assert.equal(metricDeltas[2].usage?.completion_tokens, 20);
assert.equal(metricDeltas[2].timings?.predicted_ms, 400);
assert.equal(metricParser.push("data: [DONE]\n\n"), true);
assert.equal(metricParser.value(), "");

console.log("SSE parser tests passed");
