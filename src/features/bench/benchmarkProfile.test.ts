import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RecordedSetting } from '@aiolm/benchmark-contracts';
import { benchmarkSettingsProfile, publicBenchmarkProfileSource, type BenchmarkProfileSource } from './benchmarkProfile';
import { runtimeHelpResolvePlan, type EffectiveSchema, type OptionSchemaDefinition } from '../../shared/api/runtimeHelp';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { testConfig } from '../../testing/appStore';
import { webcrypto } from 'node:crypto';
import type { AppConfig } from '../../shared/api/types';

vi.mock('../../shared/api/runtimeHelp', async importOriginal => ({ ...await importOriginal<object>(), runtimeHelpResolvePlan: vi.fn(async () => ({ argv: [], request: {} })) }));
const known = <T,>(value: T) => ({ value, certainty: 'documented' as const });
const setting = (name: string, value: RecordedSetting['value'], extra: Partial<RecordedSetting> = {}): RecordedSetting => ({ target: 'launch', scope: [], name, value, unit: null, role: null, ...extra });
const source = (settings: RecordedSetting[]): BenchmarkProfileSource => ({ source_schema_version: 3, source_omissions: false,
  runtime: { name: null, version: null, backend: null, build: null, variant: null, plugin_version: null },
  execution: { topology: 'unknown', memory_scope: 'unavailable', settings: [...settings].sort((a, b) =>
    a.target === b.target ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.target < b.target ? -1 : 1) } });
function option(key: string, extra: Partial<OptionSchemaDefinition> = {}): OptionSchemaDefinition {
  return { ...schemaOption({ key, flag: `--${key}`, group: 'Runtime', target: 'launch', kind: { type: 'integer' } }),
    benchmark_public: known(true), repeatable: known(false), ...extra };
}
function destination(options: OptionSchemaDefinition[], names: Record<string, string>, overrides: Partial<EffectiveSchema> = {}): { cfg: AppConfig; effective: EffectiveSchema } {
  return { cfg: { ...testConfig, active_provider: 'custom.destination', active_runtime: 'destination-runtime' },
    effective: effectiveSchema([], options, { benchmark_names: names, ...overrides }) };
}

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.mocked(runtimeHelpResolvePlan).mockReset().mockResolvedValue({ argv: [], request: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe('destination-checked benchmark profiles', () => {
  it('restores a typed launch setting by public name, independent of the source engine identity', async () => {
    const dest = destination([option('local_batch', { scope: ['serve'], unit: known('count') })], { local_batch: 'batch' }, { scope: ['serve'] });
    const { profile, omitted } = await benchmarkSettingsProfile(source([setting('batch', 16, { scope: ['serve'], unit: 'count' }),
      setting('temperature', 0, { target: 'request' })]), 'public-1', dest);
    expect(profile.id).toBe('profile-benchmark-89575abd9c3b724d88ddd3cfb8eb89fe5c994ab34665828cdcf0e4a79ddb5293');
    expect(profile.provider).toBe('custom.destination');
    expect(profile.settings).toEqual({ provider_options: { 'custom.destination': { local_batch: 16 } } });
    expect(omitted).toBe(false);
    expect(runtimeHelpResolvePlan).toHaveBeenCalledWith(dest.effective.schema, ['serve'], [{ key: 'local_batch', values: [16] }]);
  });

  it('omits null, ambiguous, wrong-scope, private, wrong-type, bounds, unit and role mismatches without choosing or clamping', async () => {
    const dest = destination([
      option('null'), option('scope', { scope: ['serve'] }), option('private', { sensitive: known(true) }),
      option('wrong_type', { kind: known('text') }), option('bounded', { range: known({ min: 1, max: 8 }) }),
      option('unit', { unit: known('tokens') }), option('role', { benchmark_role: known('concurrency.capacity') }),
      option('ambiguous_a'), option('ambiguous_b'), option('path', { local_path: known(true) }),
    ], { null: 'null', scope: 'scope', private: 'private', wrong_type: 'wrong_type', bounded: 'bounded', unit: 'unit', role: 'role', ambiguous_a: 'ambiguous', ambiguous_b: 'ambiguous', path: 'path' });
    const { profile, omitted } = await benchmarkSettingsProfile(source([
      setting('null', null), setting('scope', 1), setting('private', 1), setting('wrong_type', 1), setting('bounded', 99),
      setting('unit', 1), setting('role', 1), setting('ambiguous', 1), setting('path', 1), setting('missing', 1),
    ]), 'public-2', dest);
    expect(profile.settings).toEqual({});
    expect(omitted).toBe(true);
  });

  it('preserves false, zero and numeric arrays only when their exact destination shape is established', async () => {
    const dest = destination([option('cache', { kind: known('boolean'), arity: known({ min: 0, max: 0 }) }),
      option('zero'), option('split', { kind: known('json') }), option('repeated', { repeatable: known(true) })],
    { cache: 'cache', zero: 'zero', split: 'split', repeated: 'repeated' });
    const { profile } = await benchmarkSettingsProfile(source([setting('cache', false), setting('zero', 0), setting('split', [0.25, 0.75]), setting('repeated', [4, 8])]), 'arrays', dest);
    expect(profile.settings.provider_options?.['custom.destination']).toMatchObject({ cache: false, zero: 0, split: [0.25, 0.75], repeated: { spelling: null, occurrences: [[4], [8]] } });
  });

  it('uses native dedicated controls and never copies the current model, runtime, device or profile values', async () => {
    const dest = destination([option('context', { spellings: [{ flag: '--ctx-size' }], managed: 'discovery', unit: known('tokens'), benchmark_role: known('context.total_tokens') })], { context: 'ctx-size' });
    dest.cfg = { ...dest.cfg, active_provider: 'llama.cpp', active_backend: 'cpu', active_build: 'b-test', ctx_size: 32768, threads: 99 };
    const { profile } = await benchmarkSettingsProfile(source([setting('ctx-size', 8192, { unit: 'tokens', role: 'context.total_tokens' })]), 'native', dest);
    expect(profile.settings).toEqual({ ctx_size: 8192 });
    expect(profile.provider).toBe('llama.cpp');
    expect(profile).not.toHaveProperty('legacy_runtime');
    expect(dest.effective.schema.options[0].managed).toBe('discovery');
  });

  it('omits resolver-rejected values but surfaces genuine API failures for retry', async () => {
    const dest = destination([option('batch')], { batch: 'batch' });
    vi.mocked(runtimeHelpResolvePlan).mockRejectedValueOnce([{ key: 'batch', message: 'outside destination bounds' }]);
    expect(await benchmarkSettingsProfile(source([setting('batch', 16)]), 'invalid', dest)).toMatchObject({ omitted: true, profile: { settings: {} } });
    vi.mocked(runtimeHelpResolvePlan).mockRejectedValueOnce(new Error('schema service unavailable'));
    await expect(benchmarkSettingsProfile(source([setting('batch', 16)]), 'failed', dest)).rejects.toThrow('schema service unavailable');
  });

  it('keeps destination-specific IDs and explicitly reports legacy omissions without parsing raw arguments', async () => {
    const projected = publicBenchmarkProfileSource({ id: 'legacy', benchmark: { schema_version: 1,
      runtime: { name: 'llama.cpp', version: null, backend: null, build: null },
      execution: { context_size: 4096, parallel: 2, settings: null, effective_args: ['--batch-size', '1024'] } } }, 'legacy');
    const dest = destination([], {});
    expect((await benchmarkSettingsProfile(projected, 'legacy', dest)).omitted).toBe(true);
    expect(projected.execution.settings.some(entry => entry.name === 'batch-size')).toBe(false);
    const first = await benchmarkSettingsProfile(source([]), 'same', dest);
    const second = await benchmarkSettingsProfile(source([]), 'same', { ...dest, cfg: { ...dest.cfg, active_provider: 'vllm' } });
    expect(first.profile.id).not.toBe(second.profile.id);
    expect(() => publicBenchmarkProfileSource({ id: 'other', benchmark: {} }, 'legacy')).toThrow();
  });

  it.each([64, 65])('retains safe legacy settings when tensor split has %i entries without changing the source', length => {
    const split = Array.from({ length }, () => 1);
    const detail = { id: 'legacy-array', benchmark: { schema_version: 1,
      runtime: { name: 'llama.cpp', version: null, backend: null, build: null },
      execution: { context_size: 4096, parallel: 2, effective_args: ['--threads', '8'],
        settings: { gpu_layers: null, threads: 8, threads_batch: null, flash_attention: 'on',
          cache_type_k: null, cache_type_v: null, split_mode: null, tensor_split: split } } } };
    const frozen = JSON.stringify(detail);
    const normalized = publicBenchmarkProfileSource(detail, detail.id);
    expect(normalized.source_schema_version).toBe(1);
    expect(normalized.source_omissions).toBe(true);
    expect(normalized.execution.settings).toEqual([
      setting('ctx-size', 4096, { unit: 'tokens', role: 'context.total_tokens' }),
      setting('flash-attn', 'on'),
      setting('parallel', 2, { unit: 'count', role: 'concurrency.capacity' }),
      ...(length === 64 ? [setting('tensor-split', split, { unit: 'ratio' })] : []),
      setting('threads', 8, { unit: 'threads' }),
    ]);
    expect(JSON.stringify(detail)).toBe(frozen);
  });
});
