import {
  validateBenchmarkConfiguration, validateLegacyBenchmarkConfiguration,
  type BenchmarkConfiguration, type RecordedSetting, type LegacyPublicBenchmarkSubmission,
} from '@aiolm/benchmark-contracts';
import type { LegacyPerformanceBenchmarkResult, PerformanceBenchmarkResult } from '../../api/types';
import { effectiveArguments } from './publicBenchmark';

/** A configuration view only; legacy measurements and frozen publication bytes never change. */
export type BenchmarkProfileSource = BenchmarkConfiguration & {
  source_schema_version: 1 | 2 | 3;
  source_omissions: boolean;
};

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid benchmark configuration.');
  return value as Record<string, unknown>;
};

/** Public detail projections must carry their actual version, not an inferred engine version. */
export function validateBenchmarkProfileSource(value: unknown): BenchmarkProfileSource {
  const source = object(value);
  if (![1, 2, 3].includes(source.schema_version as number)) throw new Error('Unsupported benchmark configuration version.');
  if (source.schema_version === 3) {
    const configuration = validateBenchmarkConfiguration({ runtime: source.runtime, execution: source.execution });
    return { ...structuredClone(configuration), source_schema_version: 3, source_omissions: false };
  }
  const legacy = validateLegacyBenchmarkConfiguration({ runtime: source.runtime, execution: source.execution }, source.schema_version as 1 | 2);
  return normalizeLegacyConfiguration(legacy, source.schema_version as 1 | 2);
}

function normalizeLegacyConfiguration(legacy: Pick<LegacyPublicBenchmarkSubmission, 'runtime' | 'execution'>, version: 1 | 2): BenchmarkProfileSource {
  const { runtime, execution } = legacy;
  const settings: RecordedSetting[] = [];
  // The historical curated settings have known semantics. Raw argv is not a typed snapshot.
  if (runtime.name === 'llama.cpp') {
    const add = (name: string, value: RecordedSetting['value'], unit: RecordedSetting['unit'], role: RecordedSetting['role'] = null) => {
      if (value !== null && !(typeof value === 'string' && (value.length > 128 || value.startsWith('-')))) {
        settings.push({ target: 'launch', scope: [], name, value, unit, role });
      }
    };
    if (execution.context_size > 0) add('ctx-size', execution.context_size, 'tokens', 'context.total_tokens');
    if (execution.parallel > 0) add('parallel', execution.parallel, 'count', 'concurrency.capacity');
    if (execution.settings) {
      const s = execution.settings;
      add('gpu-layers', s.gpu_layers, 'layers');
      add('threads', s.threads, 'threads');
      add('threads-batch', s.threads_batch, 'threads');
      add('flash-attn', s.flash_attention, null);
      add('cache-type-k', s.cache_type_k, null);
      add('cache-type-v', s.cache_type_v, null);
      add('split-mode', s.split_mode, null);
      add('tensor-split', s.tensor_split, 'ratio');
    }
  }
  settings.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const configuration = validateBenchmarkConfiguration({
    runtime: { name: runtime.name, version: runtime.version, backend: runtime.backend, build: runtime.build,
      variant: runtime.variant ?? null, plugin_version: runtime.plugin_version ?? null },
    execution: { topology: 'unknown', memory_scope: 'unavailable', settings },
  });
  return { ...structuredClone(configuration), source_schema_version: version, source_omissions: true };
}

export function publicBenchmarkProfileSource(value: unknown, id: string): BenchmarkProfileSource {
  const detail = object(value);
  if (detail.id !== id) throw new Error('The public benchmark id does not match.');
  return validateBenchmarkProfileSource(detail.benchmark);
}

type LocalConfigurationRecord =
  | { schemaVersion: 1; backend: string; build: string; result: LegacyPerformanceBenchmarkResult }
  | { schemaVersion: 2; result: PerformanceBenchmarkResult };

export function localBenchmarkProfileSource(record: LocalConfigurationRecord): BenchmarkProfileSource {
  if (record.schemaVersion === 2) {
    const p = record.result.provenance;
    if (!p || p.schema_version !== 2) throw new Error('Serving benchmark provenance is unavailable.');
    return validateBenchmarkProfileSource({ schema_version: 3, runtime: p.runtime, execution: p.execution });
  }
  const result = record.result;
  const python = result.provider !== undefined && result.provider !== 'llama.cpp';
  return validateBenchmarkProfileSource({ schema_version: python ? 2 : 1,
    runtime: { name: result.provider ?? 'llama.cpp', version: result.runtime_version || null,
      backend: python ? result.runtime_accelerator ?? null : record.backend || null,
      build: python ? result.runtime_version || null : record.build || null,
      ...(result.runtime_variant === 'vllm-metal' ? { variant: result.runtime_variant, plugin_version: result.runtime_plugin_version } : {}) },
    execution: { context_size: result.context_size, parallel: result.parallel,
      settings: python ? null : result.provenance?.execution_config ?? null,
      effective_args: effectiveArguments(result.args) },
  });
}
