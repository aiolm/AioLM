import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { mergeProviderRequestSettings } from './providerRequestSettings';
import { serverSettingsChanged } from './executionSettings';
import { buildChatRequestBody } from '../api/chat';
import type { EngineInfo } from '../api/providers';

const engine: EngineInfo = { provider: 'vllm', runtime_id: 'synthetic-runtime', upstream_model: 'served-model', tasks: ['generate'],
  modalities: { text: true, image: false, audio: false, video: false }, request_fields: { temperature: 0.9, max_tokens: 256 }, tools_auto: true };

describe('provider request settings', () => {
  it('applies and clears sampling values without changing live launch settings or another engine', () => {
    const live = { ...testConfig, active_provider: 'vllm' as const,
      provider_options: { vllm: { temperature: 0.9, top_p: 0.8, max_model_len: 8192 }, 'mlx-vlm': { seed: 42 } } };
    const saved = { vllm: { temperature: 0.2, max_model_len: 16384 } };
    const merged = mergeProviderRequestSettings(live, saved);
    expect(merged).toEqual({ vllm: { temperature: 0.2, max_model_len: 8192 }, 'mlx-vlm': { seed: 42 } });
    expect(serverSettingsChanged(live, { ...live, provider_options: merged })).toBe(false);
    expect(serverSettingsChanged(live, { ...live, provider_options: saved })).toBe(true);
    const body = buildChatRequestBody('ignored', [{ role: 'user', content: 'Hello' }], { temperature: 99, top_p: 99, top_k: 99,
      engine, provider: 'vllm', provider_options: merged?.vllm });
    expect(body).toMatchObject({ model: 'served-model', temperature: 0.2 });
    expect(body).not.toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_model_len');
    expect(body).not.toHaveProperty('top_p');
  });
  it('keeps protected request fields app-owned and uses only schema fields for the chosen engine', () => {
    const body = buildChatRequestBody('ignored', [], { temperature: 1, top_p: 1, top_k: 1, engine,
      provider_options: { model: 'unowned-model', api_key: 'secret', messages: [], stream: false, temperature: 0, seed: 42 } });
    expect(body).toMatchObject({ model: 'served-model', temperature: 0, stream: true });
    expect(body).not.toHaveProperty('api_key');
    expect(body).not.toHaveProperty('seed');
  });
});
