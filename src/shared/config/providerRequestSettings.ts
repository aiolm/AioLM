import type { AppConfig } from '../api/types';
import { providerOf, type ProviderId } from '../api/providers.ts';
import keys from './providerRequestOptions.json' with { type: 'json' };

/** A request uses only the selected engine's schema; launch bindings never cross this boundary. */
export function providerRequestFields(provider: ProviderId, options: Record<string, unknown>): Record<string, unknown> {
  if (provider === 'llama.cpp') return {};
  return Object.fromEntries(keys[provider].filter(key => options[key] !== undefined).map(key => [key, options[key]]));
}

export function mergeProviderRequestSettings(live: AppConfig, saved: AppConfig['provider_options']): AppConfig['provider_options'] {
  const provider = providerOf(live);
  if (provider === 'llama.cpp') return live.provider_options;
  const current = live.provider_options?.[provider] ?? {};
  const requestKeys = [...keys[provider], ...(provider === 'vllm' ? ['request_lora'] : [])];
  const launch = Object.fromEntries(Object.entries(current).filter(([key]) => !requestKeys.includes(key)));
  const selected = saved?.[provider] ?? {};
  const request = Object.fromEntries(requestKeys.filter(key => selected[key] !== undefined).map(key => [key, selected[key]]));
  return { ...live.provider_options, [provider]: { ...launch, ...request } };
}
