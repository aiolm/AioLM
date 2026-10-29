// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StreamTimings, StreamUsage } from "../api/sse";
import { buildResponseMetrics, sanitizeResponseMetrics } from "./metrics";

describe("response metrics", () => {
  it("keeps server phase counts and rates separate from client request time", () => {
    expect(buildResponseMetrics(
      { prompt_tokens: 1600, completion_tokens: 240, prompt_tokens_details: { cached_tokens: 64 } },
      { prompt_n: 1536, prompt_ms: 800, prompt_per_second: 1919.5, predicted_n: 256, predicted_ms: 4000, predicted_per_second: 63.9, cache_n: 63 },
      { preparationMs: 3000, firstTokenMs: 900, requestMs: 5000 },
    )).toEqual({
      pp: { tokens: 1536, durationMs: 800, tokensPerSecond: 1919.5 },
      tg: { tokens: 256, durationMs: 4000, tokensPerSecond: 63.9 },
      cachedTokens: 63, preparationMs: 3000, firstTokenMs: 900, requestMs: 5000,
    });
  });

  it("derives rates only from matching phase durations and subtracts a known cache count", () => {
    expect(buildResponseMetrics(
      { prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 600 }, completion_tokens_details: { reasoning_tokens: 30 } },
      { prompt_ms: 200, predicted_ms: 1000 },
    )).toEqual({
      pp: { tokens: 400, durationMs: 200, tokensPerSecond: 2000 },
      tg: { tokens: 50, durationMs: 1000, tokensPerSecond: 50 },
      cachedTokens: 600,
    });
  });

  it("leaves PP unknown when only a total prompt count is supplied", () => {
    expect(buildResponseMetrics({ prompt_tokens: 1000, completion_tokens: 10 }, undefined, { firstTokenMs: 100, requestMs: 200 })).toEqual({
      pp: {}, tg: { tokens: 10 }, firstTokenMs: 100, requestMs: 200,
    });
    expect(buildResponseMetrics({ prompt_tokens: 2, prompt_tokens_details: { cached_tokens: 4 } }, undefined)).toEqual({ pp: {}, tg: {}, cachedTokens: 4 });
    expect(buildResponseMetrics({ prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: null }, undefined))
      .toEqual({ pp: {}, tg: { tokens: 10 } });
  });

  it("uses vLLM's decode interval without presenting overall throughput or TTFT as a phase measurement", () => {
    expect(buildResponseMetrics(
      { prompt_tokens: 100, completion_tokens: 11, prompt_tokens_details: { cached_tokens: 20 } },
      undefined,
      { firstTokenMs: 850, requestMs: 1100 },
      { generation_time_ms: 200, time_to_first_token_ms: 800, queue_time_ms: 40, tokens_per_second: 11, mean_itl_ms: 20 },
    )).toEqual({
      pp: { tokens: 80 }, tg: { tokens: 11, durationMs: 200, tokensPerSecond: 50 },
      cachedTokens: 20, firstTokenMs: 850, requestMs: 1100,
    });
  });

  it("keeps native phase timings authoritative when per-request telemetry is also present", () => {
    expect(buildResponseMetrics(
      { completion_tokens: 11 },
      { predicted_n: 10, predicted_ms: 100, predicted_per_second: 99 },
      {},
      { generation_time_ms: 200, tokens_per_second: 1 },
    ).tg).toEqual({ tokens: 10, durationMs: 100, tokensPerSecond: 99 });
  });

  it("does not invent decode speed from absent, invalid or zero vLLM intervals", () => {
    expect(buildResponseMetrics({ completion_tokens: 1 }, undefined, {}, { generation_time_ms: 0, tokens_per_second: 100 }).tg)
      .toEqual({ tokens: 1, durationMs: 0 });
    expect(buildResponseMetrics({ completion_tokens: 1 }, undefined, {}, { generation_time_ms: 20 }).tg)
      .toEqual({ tokens: 1, durationMs: 20, tokensPerSecond: 0 });
    expect(buildResponseMetrics(undefined, undefined, {}, { generation_time_ms: 20 }).tg)
      .toEqual({ durationMs: 20 });
    expect(buildResponseMetrics({ completion_tokens: 2 }, undefined, {}, { generation_time_ms: null, tokens_per_second: 100 }).tg)
      .toEqual({ tokens: 2 });
    expect(buildResponseMetrics({ completion_tokens: 2 }, undefined, {}, { generation_time_ms: -1 }).tg)
      .toEqual({ tokens: 2 });
  });

  it("preserves zero counts and durations without dividing by zero", () => {
    expect(buildResponseMetrics(
      { prompt_tokens: 10, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 10 } },
      { prompt_ms: 0, predicted_ms: 0 },
      { preparationMs: 0, firstTokenMs: 0, requestMs: 0 },
    )).toEqual({
      pp: { tokens: 0, durationMs: 0 }, tg: { tokens: 0, durationMs: 0 },
      cachedTokens: 10, preparationMs: 0, firstTokenMs: 0, requestMs: 0,
    });
    expect(buildResponseMetrics(undefined, { predicted_n: 0, predicted_ms: 100 }).tg.tokensPerSecond).toBe(0);
    expect(buildResponseMetrics(undefined, { predicted_n: 1, predicted_ms: 0, predicted_per_second: 0 }).tg.tokensPerSecond).toBe(0);
  });

  it("rejects malformed values and falls back to valid server fields", () => {
    const timings = {
      prompt_n: 1.5, prompt_ms: "20", prompt_per_second: Infinity,
      predicted_n: -2, predicted_ms: 1000, predicted_per_second: NaN, cache_n: "0",
    } as unknown as StreamTimings;
    expect(buildResponseMetrics(
      { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 0 } },
      timings, { firstTokenMs: -1, requestMs: Infinity },
    )).toEqual({ pp: { tokens: 100 }, tg: { tokens: 20, durationMs: 1000, tokensPerSecond: 20 }, cachedTokens: 0 });
    expect(buildResponseMetrics(
      { completion_tokens: "20" } as unknown as StreamUsage,
      { predicted_n: Number.MAX_VALUE, predicted_ms: Number.MIN_VALUE },
    ).tg).toEqual({ durationMs: Number.MIN_VALUE });
    expect(buildResponseMetrics(undefined, { predicted_n: 1, predicted_ms: Number.MIN_VALUE }).tg.tokensPerSecond).toBeUndefined();
  });
});

describe("persisted response metrics", () => {
  it("retains valid measurements and removes malformed and unknown fields", () => {
    const stored = {
      pp: { tokens: 0, durationMs: 2.5, tokensPerSecond: Infinity, extra: "discard" },
      tg: { tokens: 2.5, durationMs: -1, tokensPerSecond: 2.5 },
      cachedTokens: 0, preparationMs: "10", firstTokenMs: 0, requestMs: NaN, extra: { unexpected: true },
    };
    expect(sanitizeResponseMetrics(stored)).toEqual({
      pp: { tokens: 0, durationMs: 2.5 }, tg: { tokensPerSecond: 2.5 }, cachedTokens: 0, firstTokenMs: 0,
    });
    expect(stored.pp.extra).toBe("discard");
  });

  it("restores partial observations and leaves missing measurements absent", () => {
    expect(sanitizeResponseMetrics({ requestMs: 20 })).toEqual({ pp: {}, tg: {}, requestMs: 20 });
    const valid = buildResponseMetrics(undefined, { prompt_n: 12, predicted_n: 4, predicted_ms: 200 });
    expect(sanitizeResponseMetrics(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it.each([undefined, null, [], "metrics", {}, { pp: {}, tg: {} }, { pp: [], tg: { tokens: "4" }, requestMs: -1 }])(
    "ignores records without usable measurements: %j", (value) => {
      expect(sanitizeResponseMetrics(value)).toBeUndefined();
    },
  );
});
