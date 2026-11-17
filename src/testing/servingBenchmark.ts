import type { ServingPerformanceBenchmarkRecord } from '../shared/api/benchmarkHistory';

/** Fresh-input streaming evidence with unreported usage and attached compute. */
export function servingBenchmark(): ServingPerformanceBenchmarkRecord {
  return {
    schemaVersion: 3, id: 'serving', createdAt: 1000, model: '/synthetic/private/model',
    request: { run_id: 'serving', method: { id: 'openai-chat-serving', version: 5 }, context_profile: 'novel_en',
      prompt_bytes: [4096], max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: false, request_usage: false },
    result: { run_id: 'serving', status: 'complete', args: ['--api-key', 'PRIVATE-CREDENTIAL'],
      rows: [{ id: 'serving-1', input_bytes: 4096, max_output_tokens: 128, concurrency: 1, repetition: 1,
        input_sha256_by_request: ['a'.repeat(64)], first_output_ms: 20, e2e_ms: 200,
        output_bytes: 12, reported_prompt_tokens: null, reported_completion_tokens: null,
        prefill_tokens_per_second: null, decode_tokens_per_second: null, tpot_ms: null,
        usage_status: 'missing', finish_reasons: ['stop'], peak_memory_bytes: null,
        timing_source: 'client', failed: false, error: null }],
      provenance: {
        schema_version: 3, app_version: '0.4.3', method: { id: 'openai-chat-serving', version: 5 }, recorded_model_label: 'Serving model',
        workload: { corpus: 'novel_en', corpus_version: 2, inputs: [{ bytes: 4096, sha256: 'a'.repeat(64) }],
          max_output_tokens: 128, concurrencies: [1], repetitions: 1, warmup: false, request_usage: false,
          cache_policy: 'cold_prompt', prompt_nonce: '0123456789abcdef0123456789abcdef' },
        runtime: { name: 'Example engine', version: null, backend: null, build: null, variant: null, plugin_version: null },
        model: { format: 'unknown', status: 'unidentified', sha256: null, size_bytes: null },
        environment: { scope: 'aiolm_host', os: 'test', arch: 'test', cpu: { name: 'Example CPU', logical_cores: 8 },
          installed_gpus: [], execution: { mode: 'unknown', selected_gpus: [], devices: [], selection_complete: false }, detection: 'private diagnostic' },
        execution: { topology: 'attached', memory_scope: 'unavailable', settings: [
          { target: 'request', scope: [], name: 'max_tokens', value: 128, unit: 'tokens', role: null },
          { target: 'request', scope: [], name: 'stream', value: true, unit: null, role: null },
          { target: 'request', scope: [], name: 'temperature', value: 0, unit: null, role: null },
        ] },
      },
    },
  };
}
