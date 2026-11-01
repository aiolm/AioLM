import type {
  BenchmarkTrial,
  BenchmarkSummary,
  PublicBenchmarkRow,
  ServingAggregationRow,
  ServingBenchmarkPoint,
  ServingBenchmarkRow,
  ServingMetricKey,
  ServingMetricStat,
} from './types.js';

const numericMetrics = ['ttft_ms', 'tpot_ms', 'pp_tps', 'tg_tps', 'total_tps'] as const;
const measured = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;
const mean = (values: Array<number | null>): number | null => {
  // A missing sample makes the aggregate unmeasured too; never turn unknown into zero.
  if (values.length === 0 || !values.every(measured)) return null;
  const sum = values.reduce((total, value) => total + value, 0);
  if (Number.isFinite(sum)) return sum / values.length;
  let scale = 0;
  for (const value of values) if (value > scale) scale = value;
  return scale * (values.reduce((total, value) => total + value / scale, 0) / values.length);
};

function scaledStddev(values: Array<number | null>): number {
  let scale = 0;
  for (const value of values) if (value !== null && value > scale) scale = value;
  if (scale === 0) return 0;
  const average = values.reduce<number>((sum, value) => sum + value! / scale, 0) / values.length;
  const squared = values.reduce<number>((sum, value) => {
    const delta = value! / scale - average;
    return sum + delta * delta;
  }, 0);
  return scale * Math.sqrt(squared / (values.length - 1));
}

function stddev(values: Array<number | null>): number | null {
  const average = mean(values);
  if (average === null || values.length < 2 || !values.every(measured)) return null;
  const squared = values.reduce((sum, value) => sum + (value - average) ** 2, 0);
  return Number.isFinite(squared)
    ? Math.sqrt(squared / (values.length - 1))
    : scaledStddev(values);
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
    if (memory.length > 0 && memory.every(measured)) {
      let peak = memory[0]!;
      for (let index = 1; index < memory.length; index += 1) peak = Math.max(peak, memory[index]!);
      result.peak_memory_bytes = peak;
    } else {
      result.peak_memory_bytes = null;
    }
    return result;
  }).sort((a, b) => a.prompt_tokens - b.prompt_tokens || a.concurrency - b.concurrency || a.generation_length - b.generation_length);

  const baselines = new Map(summaries.filter(row => row.concurrency === 1 && !row.error)
    .map(row => [`${row.prompt_tokens}|${row.generation_length}|${row.timing_source}`, row]));
  for (const row of summaries) {
    const baseline = baselines.get(`${row.prompt_tokens}|${row.generation_length}|${row.timing_source}`);
    if (!row.error && row.cached_tokens === 0 && baseline?.cached_tokens === 0
      && row.tg_tps !== null && baseline.tg_tps !== null && baseline.tg_tps > 0) {
      const speedup = row.tg_tps / baseline.tg_tps;
      row.speedup = Number.isFinite(speedup) ? speedup : null;
    }
  }
  return summaries;
}

/** Public submissions contain trials in order, without private local trial identifiers. */
export function summarizePublicBenchmarkRows(rows: PublicBenchmarkRow[]): BenchmarkSummary[] {
  return summarizeBenchmarkTrials(rows.map((row, index) => ({ ...row, id: String(index), error: row.failed ? 'failed' : null })));
}

export const SERVING_METRIC_KEYS = [
  'first_output_ms',
  'first_content_ms',
  'first_reasoning_ms',
  'e2e_ms',
  'content_bytes',
  'reasoning_bytes',
  'output_bytes',
  'output_bytes_per_second',
  'reported_prompt_tokens',
  'reported_completion_tokens',
  'reported_cached_tokens',
  'reported_tokens_per_second',
  'peak_memory_bytes',
] as const satisfies readonly ServingMetricKey[];

function servingRate(numerator: number | null, e2eMs: number): number | null {
  if (!measured(numerator) || !measured(e2eMs) || e2eMs === 0) return null;
  const rate = numerator * 1000 / e2eMs;
  return Number.isFinite(rate) ? rate : null;
}

function servingValues(row: Omit<ServingBenchmarkRow, 'failed'>): Record<ServingMetricKey, number | null> {
  const observation = (value: number | null): number | null => measured(value) ? value : null;
  return {
    first_output_ms: observation(row.first_output_ms),
    first_content_ms: observation(row.first_content_ms),
    first_reasoning_ms: observation(row.first_reasoning_ms),
    e2e_ms: observation(row.e2e_ms),
    content_bytes: observation(row.content_bytes),
    reasoning_bytes: observation(row.reasoning_bytes),
    output_bytes: observation(row.output_bytes),
    output_bytes_per_second: servingRate(row.output_bytes, row.e2e_ms),
    reported_prompt_tokens: observation(row.reported_prompt_tokens),
    reported_completion_tokens: observation(row.reported_completion_tokens),
    reported_cached_tokens: observation(row.reported_cached_tokens),
    reported_tokens_per_second: servingRate(row.reported_completion_tokens, row.e2e_ms),
    peak_memory_bytes: observation(row.peak_memory_bytes),
  };
}

/** Client-observed byte rates and self-reported token rates share the batch E2E duration. */
export function servingMetricValues(row: ServingBenchmarkRow): Record<ServingMetricKey, number | null> {
  return servingValues(row);
}

function servingStat(values: number[]): ServingMetricStat | null {
  if (values.length === 0) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  // All observations are nonnegative, so this midpoint cannot overflow.
  const median = values.length % 2 === 0
    ? values[middle - 1] + (values[middle] - values[middle - 1]) / 2
    : values[middle];
  return { median, min: values[0], max: values[values.length - 1], samples: values.length };
}

/** Missing metrics stay missing; each statistic counts only its own measured observations. */
export function summarizeServingPoints(rows: readonly ServingAggregationRow[]): ServingBenchmarkPoint[] {
  const groups = new Map<string, {
    input_bytes: number;
    max_output_tokens: number;
    concurrency: number;
    samples: number;
    observations: Record<ServingMetricKey, number[]>;
  }>();
  for (const row of rows) {
    if (row.failed || row.error) continue;
    const key = `${row.input_bytes}|${row.concurrency}|${row.max_output_tokens}`;
    let group = groups.get(key);
    if (!group) {
      group = {
        input_bytes: row.input_bytes,
        max_output_tokens: row.max_output_tokens,
        concurrency: row.concurrency,
        samples: 0,
        observations: {
          first_output_ms: [],
          first_content_ms: [],
          first_reasoning_ms: [],
          e2e_ms: [],
          content_bytes: [],
          reasoning_bytes: [],
          output_bytes: [],
          output_bytes_per_second: [],
          reported_prompt_tokens: [],
          reported_completion_tokens: [],
          reported_cached_tokens: [],
          reported_tokens_per_second: [],
          peak_memory_bytes: [],
        },
      };
      groups.set(key, group);
    }
    group.samples += 1;
    const values = servingValues(row);
    for (const metric of SERVING_METRIC_KEYS) {
      const value = values[metric];
      if (measured(value)) group.observations[metric].push(value);
    }
  }
  return [...groups.values()].map((group): ServingBenchmarkPoint => ({
    input_bytes: group.input_bytes,
    max_output_tokens: group.max_output_tokens,
    concurrency: group.concurrency,
    samples: group.samples,
    first_output_ms: servingStat(group.observations.first_output_ms),
    first_content_ms: servingStat(group.observations.first_content_ms),
    first_reasoning_ms: servingStat(group.observations.first_reasoning_ms),
    e2e_ms: servingStat(group.observations.e2e_ms),
    content_bytes: servingStat(group.observations.content_bytes),
    reasoning_bytes: servingStat(group.observations.reasoning_bytes),
    output_bytes: servingStat(group.observations.output_bytes),
    output_bytes_per_second: servingStat(group.observations.output_bytes_per_second),
    reported_prompt_tokens: servingStat(group.observations.reported_prompt_tokens),
    reported_completion_tokens: servingStat(group.observations.reported_completion_tokens),
    reported_cached_tokens: servingStat(group.observations.reported_cached_tokens),
    reported_tokens_per_second: servingStat(group.observations.reported_tokens_per_second),
    peak_memory_bytes: servingStat(group.observations.peak_memory_bytes),
  })).sort((a, b) => a.input_bytes - b.input_bytes
    || a.concurrency - b.concurrency
    || a.max_output_tokens - b.max_output_tokens);
}
