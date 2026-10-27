import { describe, expect, it } from 'vitest';
import { testConfig } from '../../testing/appStore';
import { chatContextBudget } from './providerChatContext';

describe('runtime chat context', () => {
  it('uses the vLLM per-sequence limit and leaves model-derived limits to the runtime', () => {
    expect(chatContextBudget({ ...testConfig, active_provider: 'vllm', ctx_size: 512, provider_options: { vllm: { max_model_len: 32768 } } }))
      .toEqual({ contextSize: 32768, runtimeContext: false });
    expect(chatContextBudget({ ...testConfig, active_provider: 'vllm', ctx_size: 512, provider_options: { vllm: {} } }).runtimeContext).toBe(true);
    expect(chatContextBudget({ ...testConfig, active_provider: 'vllm', provider_options: { vllm: { max_model_len: 128 } } }))
      .toEqual({ contextSize: 128, runtimeContext: false });
    expect(chatContextBudget({ ...testConfig, active_provider: 'mlx-vlm', ctx_size: 512, provider_options: { 'mlx-vlm': { max_kv_size: 1024 } } }).runtimeContext).toBe(true);
  });
});
