import type {
  ServingAggregationRow,
  ServingBenchmarkPoint,
  ServingBenchmarkRow,
  ServingMetricKey,
  ServingMetricStat,
} from './types.js';

const measured = (value: number | null): value is number => value !== null && Number.isFinite(value) && value >= 0;

export const SERVING_METRIC_KEYS = [
  'first_output_ms',
  'prefill_tokens_per_second',
  'decode_tokens_per_second',
  'tpot_ms',
  'reported_tokens_per_second',
  'output_bytes_per_second',
  'e2e_ms',
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
    prefill_tokens_per_second: observation(row.prefill_tokens_per_second),
    decode_tokens_per_second: observation(row.decode_tokens_per_second),
    tpot_ms: observation(row.tpot_ms),
    reported_tokens_per_second: servingRate(row.reported_completion_tokens, row.e2e_ms),
    output_bytes_per_second: servingRate(row.output_bytes, row.e2e_ms),
    e2e_ms: observation(row.e2e_ms),
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
          prefill_tokens_per_second: [],
          decode_tokens_per_second: [],
          tpot_ms: [],
          reported_tokens_per_second: [],
          output_bytes_per_second: [],
          e2e_ms: [],
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
    prefill_tokens_per_second: servingStat(group.observations.prefill_tokens_per_second),
    decode_tokens_per_second: servingStat(group.observations.decode_tokens_per_second),
    tpot_ms: servingStat(group.observations.tpot_ms),
    reported_tokens_per_second: servingStat(group.observations.reported_tokens_per_second),
    output_bytes_per_second: servingStat(group.observations.output_bytes_per_second),
    e2e_ms: servingStat(group.observations.e2e_ms),
    peak_memory_bytes: servingStat(group.observations.peak_memory_bytes),
  })).sort((a, b) => a.concurrency - b.concurrency
    || a.input_bytes - b.input_bytes
    || a.max_output_tokens - b.max_output_tokens);
}
