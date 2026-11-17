import { validateBenchmarkConfiguration, type BenchmarkConfiguration } from '@aiolm/benchmark-contracts';
import type { PerformanceBenchmarkResult } from '../../api/types';

/** A configuration view of a frozen benchmark snapshot. */
export type BenchmarkProfileSource = BenchmarkConfiguration & {
  source_schema_version: 4;
  source_omissions: boolean;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid benchmark configuration.');
  return value as Record<string, unknown>;
};

/** Public detail projections must carry their actual version, not an inferred engine version. */
export function validateBenchmarkProfileSource(value: unknown): BenchmarkProfileSource {
  const source = object(value);
  if (source.schema_version !== 4) throw new Error('Unsupported benchmark configuration version.');
  const configuration = validateBenchmarkConfiguration({ runtime: source.runtime, execution: source.execution });
  return { ...structuredClone(configuration), source_schema_version: 4, source_omissions: false };
}

export function publicBenchmarkProfileSource(value: unknown, id: string): BenchmarkProfileSource {
  const detail = object(value);
  if (detail.id !== id) throw new Error('The public benchmark id does not match.');
  return validateBenchmarkProfileSource(detail.benchmark);
}

type LocalConfigurationRecord = { schemaVersion: 3; result: PerformanceBenchmarkResult };

export function localBenchmarkProfileSource(record: LocalConfigurationRecord): BenchmarkProfileSource {
  if (record.schemaVersion !== 3) throw new Error('Unsupported benchmark configuration version.');
  const p = record.result.provenance;
  if (!p || p.schema_version !== 3) throw new Error('Serving benchmark provenance is unavailable.');
  return validateBenchmarkProfileSource({ schema_version: 4, runtime: p.runtime, execution: p.execution });
}
