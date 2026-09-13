import type { StreamTimings, StreamUsage } from "../api/sse.ts";

export interface PhaseMetrics {
  tokens?: number;
  durationMs?: number;
  tokensPerSecond?: number;
}

export interface ResponseMetrics {
  pp: PhaseMetrics;
  tg: PhaseMetrics;
  preparationMs?: number;
  firstTokenMs?: number;
  requestMs?: number;
  cachedTokens?: number;
}

interface ObservedMetrics {
  preparationMs?: number;
  firstTokenMs?: number;
  requestMs?: number;
}

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function tokenCount(value: unknown): number | undefined {
  const count = nonnegativeNumber(value);
  return count !== undefined && Number.isSafeInteger(count) ? count : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function phaseMetrics(tokens: number | undefined, duration: unknown, rate: unknown): PhaseMetrics {
  const durationMs = nonnegativeNumber(duration);
  const calculatedRate = tokens !== undefined && durationMs !== undefined && durationMs > 0
    ? nonnegativeNumber(tokens / durationMs * 1000) : undefined;
  const tokensPerSecond = nonnegativeNumber(rate) ?? calculatedRate;
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  };
}

export function buildResponseMetrics(
  usage: StreamUsage | undefined,
  timings: StreamTimings | undefined,
  observed: ObservedMetrics = {},
): ResponseMetrics {
  const cachedTokens = tokenCount(timings?.cache_n) ?? tokenCount(usage?.prompt_tokens_details?.cached_tokens);
  const promptTokens = tokenCount(usage?.prompt_tokens);
  // A prompt total alone cannot distinguish newly processed tokens from cache reuse.
  const uncachedTokens = promptTokens !== undefined && cachedTokens !== undefined && cachedTokens <= promptTokens
    ? promptTokens - cachedTokens : undefined;
  const preparationMs = nonnegativeNumber(observed.preparationMs);
  const firstTokenMs = nonnegativeNumber(observed.firstTokenMs);
  const requestMs = nonnegativeNumber(observed.requestMs);
  return {
    pp: phaseMetrics(tokenCount(timings?.prompt_n) ?? uncachedTokens, timings?.prompt_ms, timings?.prompt_per_second),
    tg: phaseMetrics(tokenCount(timings?.predicted_n) ?? tokenCount(usage?.completion_tokens), timings?.predicted_ms, timings?.predicted_per_second),
    ...(preparationMs !== undefined ? { preparationMs } : {}),
    ...(firstTokenMs !== undefined ? { firstTokenMs } : {}),
    ...(requestMs !== undefined ? { requestMs } : {}),
    ...(cachedTokens !== undefined ? { cachedTokens } : {}),
  };
}

function sanitizePhase(value: unknown): PhaseMetrics {
  const record = asRecord(value);
  const tokens = tokenCount(record.tokens);
  const durationMs = nonnegativeNumber(record.durationMs);
  const tokensPerSecond = nonnegativeNumber(record.tokensPerSecond);
  return {
    ...(tokens !== undefined ? { tokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}),
  };
}

export function sanitizeResponseMetrics(value: unknown): ResponseMetrics | undefined {
  const record = asRecord(value);
  const result: ResponseMetrics = { pp: sanitizePhase(record.pp), tg: sanitizePhase(record.tg) };
  for (const key of ["preparationMs", "firstTokenMs", "requestMs"] as const) {
    const duration = nonnegativeNumber(record[key]);
    if (duration !== undefined) result[key] = duration;
  }
  const cachedTokens = tokenCount(record.cachedTokens);
  if (cachedTokens !== undefined) result.cachedTokens = cachedTokens;
  return Object.keys(result.pp).length || Object.keys(result.tg).length || Object.keys(result).length > 2
    ? result : undefined;
}

export function deriveTokensPerSecond(completionTokens?: number, totalMs?: number): number | null {
  if (!completionTokens || !totalMs || totalMs <= 0) return null;
  return completionTokens / (totalMs / 1000);
}
