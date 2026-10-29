// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalizeStreamDelta, SseParser, type StreamDelta } from "./sse";

describe("backend stream telemetry", () => {
  it("retains a split vLLM usage frame after the completion reason until DONE", () => {
    const deltas: StreamDelta[] = [];
    const parser = new SseParser(delta => deltas.push(delta));
    parser.push('data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":"stop"}]}\n\n');
    const frame = `data: ${JSON.stringify({
      choices: [], usage: { prompt_tokens: 100, completion_tokens: 6, prompt_tokens_details: { cached_tokens: 20 } },
      metrics: { generation_time_ms: 100, time_to_first_token_ms: 250, tokens_per_second: 17.14 },
    })}\r\n\r\n`;
    parser.push(frame.slice(0, 67));
    parser.push(frame.slice(67));
    expect(parser.isFinished()).toBe(false);
    expect(deltas[1].metrics).toEqual({ generation_time_ms: 100, time_to_first_token_ms: 250, tokens_per_second: 17.14 });
    expect(normalizeStreamDelta(deltas[1])).toEqual([{
      type: "stats", usage: deltas[1].usage, timings: undefined, metrics: deltas[1].metrics,
    }]);
    expect(parser.push("data: [DONE]\n\n")).toBe(true);
    expect(parser.value()).toBe("Hello");
  });

  it("emits telemetry-only frames and preserves nullable upstream fields", () => {
    const deltas: StreamDelta[] = [];
    const parser = new SseParser(delta => deltas.push(delta));
    parser.push('data: {"choices":[],"metrics":{"generation_time_ms":null}}\n\n');
    expect(deltas).toHaveLength(1);
    expect(normalizeStreamDelta(deltas[0])).toEqual([{
      type: "stats", usage: undefined, timings: undefined, metrics: { generation_time_ms: null },
    }]);
    expect(normalizeStreamDelta({ finish_reason: "stop", metrics: { generation_time_ms: 0 } })).toEqual([{
      type: "completed", finishReason: "stop", usage: undefined, timings: undefined, metrics: { generation_time_ms: 0 },
    }]);
  });

  it.each([null, [], "invalid"])("ignores invalid backend telemetry: %j", metrics => {
    const deltas: StreamDelta[] = [];
    const parser = new SseParser(delta => deltas.push(delta));
    parser.push(`data: ${JSON.stringify({ choices: [], metrics })}\n\n`);
    expect(deltas).toEqual([]);
  });
});
