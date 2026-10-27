import type { AppConfig } from '../../shared/api/types';
import { providerOf } from '../../shared/api/providers';

/** Engine-owned context limits never inherit a leftover llama.cpp allocation. */
export function chatContextBudget(cfg?: AppConfig | null): { contextSize: number; runtimeContext: boolean } {
  const provider = providerOf(cfg ?? {});
  if (provider === 'llama.cpp') return { contextSize: Math.max(512, cfg?.ctx_size ?? 4096), runtimeContext: cfg?.runtime_defaults?.includes('ctx_size') ?? false };
  const value = provider === 'vllm' ? cfg?.provider_options?.vllm?.max_model_len : undefined;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return { contextSize: value, runtimeContext: false };
  return { contextSize: 4096, runtimeContext: true };
}
