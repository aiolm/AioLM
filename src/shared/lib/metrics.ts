export interface PerformanceMetrics {
  promptTokens?: number;
  completionTokens?: number;
  firstTokenMs?: number;
  totalMs?: number;
  tokensPerSecond?: number;
}

export function deriveTokensPerSecond(completionTokens?: number, totalMs?: number): number | null {
  if (!completionTokens || !totalMs || totalMs <= 0) return null;
  return completionTokens / (totalMs / 1000);
}
