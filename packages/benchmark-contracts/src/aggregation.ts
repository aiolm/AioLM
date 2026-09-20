import type { BenchmarkTrial, BenchmarkSummary, PublicBenchmarkRow } from './types.js';

const numericMetrics = ['ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'total_tps', 'peak_memory_bytes'] as const;
const measured = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const mean = (values: Array<number | null>): number | null => {
  // A missing sample makes the aggregate unmeasured too; never turn unknown into zero.
  if (values.length === 0 || !values.every(measured)) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

function stddev(values: Array<number | null>): number | null {
  const average = mean(values);
  if (average === null || values.length < 2 || !values.every(measured)) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
}

/** Group only identical workloads and timing methods. Failed rows never become speed samples. */
export function summarizeBenchmarkTrials(rows: BenchmarkTrial[]): BenchmarkSummary[] {
  const groups = new Map<string, BenchmarkTrial[]>();
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    const key = [row.prompt_tokens, row.generation_length, row.concurrency, row.timing_source, row.error ?? ''].join('|');
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const summaries = [...groups.values()].map((group): BenchmarkSummary => {
    const first = group[0];
    const usable = group.filter((row) => !row.error);
    const result: BenchmarkSummary = {
      ...first,
      id: [first.prompt_tokens, first.generation_length, first.concurrency, first.timing_source, first.error ?? ''].join('|'),
      repetition: 0,
      samples: usable.length,
      completion_tokens: mean(usable.map((row) => row.completion_tokens)) ?? 0,
      cached_tokens: mean(usable.map((row) => row.cached_tokens)) ?? 0,
      e2e_ms: mean(usable.map((row) => row.e2e_ms)) ?? first.e2e_ms,
      tg_stddev: stddev(usable.map((row) => row.tg_tps)),
      speedup: null,
    };
    for (const key of numericMetrics) result[key] = mean(usable.map((row) => row[key]));
    const memory = usable.map((row) => row.peak_memory_bytes);
    result.peak_memory_bytes = memory.length > 0 && memory.every(measured) ? Math.max(...memory) : null;
    return result;
  }).sort((a, b) => a.prompt_tokens - b.prompt_tokens || a.concurrency - b.concurrency || a.generation_length - b.generation_length);

  const baselines = new Map(summaries.filter(row => row.concurrency === 1 && !row.error)
    .map(row => [`${row.prompt_tokens}|${row.generation_length}|${row.timing_source}`, row]));
  for (const row of summaries) {
    const baseline = baselines.get(`${row.prompt_tokens}|${row.generation_length}|${row.timing_source}`);
    if (!row.error && row.cached_tokens === 0 && baseline?.cached_tokens === 0
        && row.tg_tps !== null && baseline.tg_tps !== null && baseline.tg_tps > 0) {
      row.speedup = row.tg_tps / baseline.tg_tps;
    }
  }
  return summaries;
}

/** Public submissions contain trials in order, without private local trial identifiers. */
export function summarizePublicBenchmarkRows(rows: PublicBenchmarkRow[]): BenchmarkSummary[] {
  return summarizeBenchmarkTrials(rows.map((row, index) => ({ ...row, id: String(index), error: row.failed ? 'failed' : null })));
}
