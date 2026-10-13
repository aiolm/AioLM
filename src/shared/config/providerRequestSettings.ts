import type { AppConfig } from '../api/types';
import { providerOf, isExternalProvider, runtimeOptionSchema, type ProviderId } from '../api/providers.ts';
import keys from './providerRequestOptions.json' with { type: 'json' };

export function providerRequestKeys(provider: ProviderId, runtimeId?: string, declared?: readonly string[]): readonly string[] {
  if (provider === 'llama.cpp') return [];
  if (!isExternalProvider(provider)) return keys[provider as 'vllm' | 'mlx-vlm'];
  if (declared) return declared;
  const schema = runtimeOptionSchema(provider, runtimeId);
  if (!schema) throw new Error('Runtime request option schema is unavailable. Probe the selected runtime before editing request defaults.');
  return schema.filter(option => option.target === 'request').map(option => option.key);
}

/** A request uses only the selected engine's schema; launch bindings never cross this boundary. */
export function providerRequestFields(provider: ProviderId, options: Record<string, unknown>, declared?: readonly string[]): Record<string, unknown> {
  if (provider === 'llama.cpp') return {};
  return Object.fromEntries(providerRequestKeys(provider, undefined, declared).filter(key => options[key] !== undefined).map(key => [key, options[key]]));
}

export function mergeProviderRequestSettings(live: AppConfig, saved: AppConfig['provider_options'], declared?: readonly string[]): AppConfig['provider_options'] {
  const provider = providerOf(live);
  if (provider === 'llama.cpp') return live.provider_options;
  const current = live.provider_options?.[provider] ?? {};
  const requestKeys = [...providerRequestKeys(provider, live.active_runtime, declared), ...(provider === 'vllm' ? ['request_lora'] : [])];
  const launch = Object.fromEntries(Object.entries(current).filter(([key]) => !requestKeys.includes(key)));
  const selected = saved?.[provider] ?? {};
  const request = Object.fromEntries(requestKeys.filter(key => selected[key] !== undefined).map(key => [key, selected[key]]));
  return { ...live.provider_options, [provider]: { ...launch, ...request } };
}
