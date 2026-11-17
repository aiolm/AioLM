// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { toPublicBenchmark, validatePublicBenchmark } from './publicBenchmark';
import { servingBenchmark } from '../../../testing/servingBenchmark';

const submissionId = '00000000-0000-4000-8000-000000000057';

describe('public configuration privacy boundary', () => {
  it.each([
    ['--lora-modules', 'synthetic-private-first=one', 'synthetic-private-second=two'],
    ['--served-model-name', 'synthetic-private-first', 'synthetic-private-second'],
    ['--future-token', 'synthetic-private-first', 'synthetic-private-second'],
    ['--model', '/synthetic/private/model', '--api-key', 'synthetic-private-secret'],
    ['--future-public', 'one', '/synthetic/private/path', 'three', '--threads', '8'],
    [],
  ])('never projects raw launch arguments into typed configuration: %j', (...args) => {
    const input = servingBenchmark();
    input.result.args = args;
    const before = structuredClone(input);
    const actual = toPublicBenchmark(input, submissionId);
    expect(actual.execution).toEqual(input.result.provenance!.execution);
    expect(actual.execution).not.toHaveProperty('effective_args');
    expect(JSON.stringify(actual)).not.toContain('synthetic-private');
    expect(validatePublicBenchmark(actual)).toBe(actual);
    expect(input).toEqual(before);
  });

  it('rejects raw arguments added to an otherwise valid public configuration', () => {
    const actual = toPublicBenchmark(servingBenchmark(), submissionId);
    expect(() => validatePublicBenchmark({
      ...actual, execution: { ...actual.execution, effective_args: ['--threads', '8'] },
    })).toThrow();
  });
});
