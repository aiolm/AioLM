import { describe, expect, it } from 'vitest';
import { effectiveArguments, toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import type { PerformanceBenchmarkResult } from '../../api/types';

const submissionId = '00000000-0000-4000-8000-000000000057';
function measured(args: string[]) {
  return {
    backend: 'cpu', build: 'synthetic-build',
    request: { context_profile: 'novel_en' as const, prompt_lengths: [1024], generation_length: 128, batch_sizes: [1], repetitions: 1, warmup: false },
    result: {
      provider: 'vllm', model_format: 'hf-safetensors', run_id: 'synthetic-local-run', status: 'complete',
      message: 'synthetic completed measurement', args: ['synthetic-interpreter', 'serve', 'synthetic-model', '--host', '127.0.0.1', '--port', '9090', ...args],
      runtime_version: '0.31.0', runtime_accelerator: 'cpu', context_size: 4096, parallel: 1,
      rows: [{ id: 'synthetic-local-trial', prompt_tokens: 1024, generation_length: 128, concurrency: 1, repetition: 1,
        completion_tokens: 128, cached_tokens: 0, ttft_ms: 40, tpot_ms: 10, pp_tps: 100, tg_tps: 100,
        e2e_ms: 1400, total_tps: 95, peak_memory_bytes: null, timing_source: 'client', error: null }],
    } satisfies PerformanceBenchmarkResult,
  };
}

describe('public measured launch argument groups', () => {
  it.each([
    ['--lora-modules', 'synthetic-private-first=one', 'synthetic-private-second=two'],
    ['--served-model-name', 'synthetic-private-first', 'synthetic-private-second'],
    ['--future-token', 'synthetic-private-first', 'synthetic-private-second'],
    ['--lora-modules=synthetic-private-first', 'synthetic-private-second'],
  ])('drops every value belonging to private argument %s', (...privateGroup) => {
    const args = [...privateGroup, '--max-model-len', '8192'];
    const input = measured(args);
    const before = structuredClone(input);
    const actual = toPublicBenchmark(input, submissionId);
    console.log('PUBLIC_ARGUMENT_GROUP', JSON.stringify({ privateOption: privateGroup[0], effective: actual.execution.effective_args }));
    expect.soft(actual.execution.effective_args).toEqual(['--max-model-len', '8192']);
    expect.soft(JSON.stringify(actual)).not.toContain('synthetic-private-');
    expect(validatePublicBenchmark(actual)).toBe(actual);
    expect(input).toEqual(before);
  });

  it('control: retains public repeated values, signed numbers, aliases and order', () => {
    const args = ['--tensor-split', '1', '2', '--seed', '-1', '--future-public=one', '--threads', '8', '-t', '9'];
    const before = [...args];
    expect(effectiveArguments(args)).toEqual(args);
    expect(args).toEqual(before);
  });

  it('control: removes existing one-value paths and secrets while retaining adjacent public options', () => {
    expect(effectiveArguments(['--api-key', 'synthetic-private-secret', '--model', '/synthetic/model', '--threads', '8']))
      .toEqual(['--threads', '8']);
  });

  it('control: a host-only launch retains its existing empty public argument list', () => {
    const input = measured([]);
    const before = structuredClone(input);
    const actual = toPublicBenchmark(input, submissionId);
    expect(actual.execution.effective_args).toEqual([]);
    expect(input).toEqual(before);
  });

  it('omits a whole public option if one of its multiple values is private', () => {
    expect(effectiveArguments(['--future-public', 'one', '/synthetic/private/path', 'three', '--threads', '8']))
      .toEqual(['--threads', '8']);
  });

  it('does not publish a partial multivalue option at the argument count limit', () => {
    const prefix = Array.from({ length: 127 }, (_, index) => [`--synthetic-${index}`, String(index)]).flat();
    expect(effectiveArguments([...prefix, '--future-public', 'one', 'two'])).toEqual(prefix);
  });
});
