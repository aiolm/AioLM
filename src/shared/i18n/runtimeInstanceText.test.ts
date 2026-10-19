import { describe, expect, it } from 'vitest';
import { runtimeLabel, type RuntimeInstance } from '../api/providers';
import { runtimeInstanceLabel } from './runtimeInstanceText';

const runtime: RuntimeInstance = {
  provider: 'custom.synthetic', id: 'build-one', engine: 'Synthetic engine', server: 'synthetic-server',
  version: '1.2', accelerator: 'unverified', installation: 'external', location: 'synthetic-runtime', available: true, problems: [],
};

describe('runtime inventory wording', () => {
  it('explains unchecked acceleration without claiming model compatibility or changing the inventory', () => {
    const original = structuredClone(runtime);
    expect(runtimeInstanceLabel(runtime, 'ko')).toBe('1.2 (build-one) · 가속 장치 미확인 · 직접 등록한 설치본');
    expect(runtime).toEqual(original);
    expect(runtimeLabel(runtime)).toBe('1.2 (build-one) · unverified · external');
  });

  it('preserves future adapter markers and different build identities', () => {
    const future = { ...runtime, accelerator: 'future-device', installation: 'future-installation' };
    expect(runtimeInstanceLabel(future, 'ja')).toContain('future-device · future-installation');
    expect(runtimeInstanceLabel(future, 'ja')).not.toBe(runtimeInstanceLabel({ ...future, id: 'build-two' }, 'ja'));
  });

  it('retains the plugin version and host engine version in localized installation labels', () => {
    const metal = { ...runtime, variant: 'vllm-metal', plugin_version: '0.3', accelerator: 'metal', installation: 'managed' };
    for (const locale of ['en', 'ko', 'ja', 'zh'] as const) {
      const label = runtimeInstanceLabel(metal, locale);
      expect(label).toContain('vllm-metal 0.3 · vLLM 1.2 (build-one) · metal');
      expect(label).not.toContain(' · managed');
    }
  });
});
