// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { CACHE_TYPE_OPTIONS } from '../config/tuningValidation.ts';
import { testConfig } from '../../testing/appStore';
import { normalizeAppConfig, normalizeConfigPatch } from './storeConfig.ts';

describe('store config cache type normalization', () => {
  it('preserves every supported cache type independently for loaded configs', () => {
    for (const cacheType of CACHE_TYPE_OPTIONS) {
      const normalized = normalizeAppConfig({ ...testConfig, cache_type_k: cacheType, cache_type_v: 'q4_1' });
      expect(normalized.cache_type_k).toBe(cacheType);
      expect(normalized.cache_type_v).toBe('q4_1');
    }

    const mixed = normalizeAppConfig({ ...testConfig, cache_type_k: 'invalid', cache_type_v: 'iq4_nl' });
    expect(mixed.cache_type_k).toBe('f16');
    expect(mixed.cache_type_v).toBe('iq4_nl');
  });

  it('normalizes object and functional patches without changing the fallback policy', () => {
    const objectPatch = normalizeConfigPatch({ cache_type_k: 'iq4_nl', cache_type_v: 'invalid' }) as Partial<typeof testConfig>;
    expect(objectPatch.cache_type_k).toBe('iq4_nl');
    expect(objectPatch.cache_type_v).toBe('f16');

    const functionalPatch = normalizeConfigPatch(() => ({ cache_type_k: 'q5_1', cache_type_v: 'iq4_nl' })) as (current: typeof testConfig) => Partial<typeof testConfig>;
    expect(functionalPatch(testConfig)).toMatchObject({ cache_type_k: 'q5_1', cache_type_v: 'iq4_nl' });
  });
});
