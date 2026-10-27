export const PROVIDERS = ['llama.cpp', 'vllm', 'mlx-vlm'] as const;
export type BuiltinProviderId = typeof PROVIDERS[number];
export type ProviderId = BuiltinProviderId | `custom.${string}`;
export const isProviderId = (value: unknown): value is ProviderId => typeof value === 'string' && (PROVIDERS.some(id => id === value) || /^custom\.[a-z0-9][a-z0-9._-]{0,56}$/.test(value));
export const isExternalProvider = (id: ProviderId): boolean => id.startsWith('custom.');
