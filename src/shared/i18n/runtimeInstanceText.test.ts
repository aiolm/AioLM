// @vitest-environment node
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

  it.each(['serve llm', 'http://127.0.0.1:8123/v1'])('names automatic connections by their command or endpoint: %s', connection_label => {
    const connected = { ...runtime, id: 'connection-opaque', version: 'OpenAI v1; binary version unknown', connection_label };
    const original = structuredClone(connected);
    for (const locale of ['en', 'ko', 'ja', 'zh'] as const) {
      expect(runtimeInstanceLabel(connected, locale)).toBe(connection_label);
    }
    expect(runtimeLabel(connected)).toBe(connection_label);
    expect(connected).toEqual(original);
  });

  it('keeps automatic connections readable when their saved label is empty', () => {
    const connected = { ...runtime, id: 'connection-opaque', connection_label: ' ' };
    const labels = (['en', 'ko', 'ja', 'zh'] as const).map(locale => runtimeInstanceLabel(connected, locale));
    for (const label of labels) {
      expect(label.trim()).not.toBe('');
      expect(label).not.toContain(connected.id);
      expect(label).not.toContain(connected.version);
      expect(label).not.toContain(' · ');
    }
    expect(new Set(labels).size).toBe(4);
    expect(runtimeLabel(connected)).not.toContain(connected.id);
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
  it.each([
    ['en', 'Accelerator not checked', 'Registered installation'],
    ['ko', '가속 장치 미확인', '직접 등록한 설치본'],
    ['ja', 'アクセラレーター未確認', '登録したインストール先'],
    ['zh', '加速设备未检查', '已注册的安装'],
  ] as const)('describes missing native acceleration metadata without claiming verification in %s', (locale, unknown, external) => {
    const unprobed = { ...runtime, version: undefined, accelerator: '', available: false };
    const before = structuredClone(unprobed);
    expect(runtimeInstanceLabel(unprobed, locale)).toBe(`build-one · ${unknown} · ${external}`);
    expect(unprobed).toEqual(before);
    const future = { ...unprobed, accelerator: 'future-device · literal', installation: 'future-installation' };
    expect(runtimeInstanceLabel(future, locale)).toBe('build-one · future-device · literal · future-installation');
    expect(future).toEqual({ ...before, accelerator: 'future-device · literal', installation: 'future-installation' });
  });
});
