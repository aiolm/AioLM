import { invoke } from './transport.ts';
import type { AppConfig, GgufModel } from './types.ts';

export const PROVIDERS = ['llama.cpp', 'vllm', 'mlx-vlm'] as const;
export type ProviderId = typeof PROVIDERS[number];
export const providerDisplayName = (provider: ProviderId): string => provider === 'vllm' ? 'vLLM' : provider === 'mlx-vlm' ? 'MLX' : 'llama.cpp';
export const providerOf = (cfg: Partial<AppConfig>): ProviderId => cfg.active_provider ?? 'llama.cpp';
export interface Modalities { text: boolean; image: boolean; audio: boolean; video: boolean }
export interface ModelArtifact {
  path: string; name: string; format: 'gguf' | 'hf-safetensors' | 'mlx' | 'unknown';
  role: 'model' | 'projector' | 'embedding'; size_bytes: number; file_count: number;
  architectures: string[]; model_type?: string; quantization?: string; modalities: Modalities;
  missing: string[]; incomplete: boolean; revision?: string; repository?: string;
  ownership: 'app' | 'hf-cache' | 'external'; notes: string[];
}
export interface ModelCompatibility {
  provider: ProviderId; status: 'supported' | 'partial' | 'unsupported' | 'unknown';
  tasks: string[]; modalities: Modalities; limitations: string[]; readiness: string[];
  reasons: Array<{ code: string; detail: string }>; evidence: string;
}
export interface CatalogModel { artifact: ModelArtifact; compatibility: ModelCompatibility[]; shards?: GgufModel['shards'] }
export interface RuntimeInstance {
  provider: ProviderId; id: string; engine: string; server: string; version?: string;
  accelerator: string; installation: string; location: string; available: boolean;
  problems: string[]; backend?: string; build?: string;
  server_flags?: string[];
  variant?: string; plugin_version?: string;
}
export function runtimeLabel(runtime: RuntimeInstance): string {
  const version = runtime.version ?? runtime.id;
  const engine = runtime.variant === 'vllm-metal' ? `vllm-metal ${runtime.plugin_version || '?'} · vLLM ${version}` : version;
  return `${engine} · ${runtime.accelerator} · ${runtime.installation}`;
}
export interface ProviderOption {
  key: string; flag?: string; group: string; target: 'launch' | 'request'; runtime_default?: string;
  kind: { type: 'integer' | 'number' | 'flag' | 'toggle' | 'choice' | 'text' | 'path' | 'json'; min?: number; max?: number; choices?: string[]; max_len?: number };
}
export interface ProviderDescription {
  id: ProviderId; engine: string; server: string; managed_version?: string;
  managed_variant?: string | null;
  availability: { supported: boolean; reason?: string; detail: string }; options: ProviderOption[];
}
export interface EngineInfo {
  provider: ProviderId; runtime_id: string; upstream_model: string; modalities: Modalities;
  runtime_variant?: string; speech_model_type?: string | null;
  tasks?: string[];
  request_fields: Record<string, unknown>; request_lora?: string;
  embedding_model?: string | null; embedding_namespace?: string | null; tools_auto?: boolean; tool_parser?: boolean;
}
export const providerCatalog = () => invoke<ProviderDescription[]>('provider_catalog');
export const providerRuntimes = () => invoke<RuntimeInstance[]>('provider_runtimes');
export const providerRuntimeOptions = (providerId: ProviderId, runtimeId: string) => invoke<ProviderOption[]>('provider_runtime_options', { providerId, runtimeId });
export const providerInstall = (providerId: ProviderId, python?: string) => invoke('provider_install', { providerId, python: python ?? null });
export const providerRegister = (providerId: ProviderId, python: string) => invoke('provider_register', { providerId, python });
export const providerRemove = (providerId: ProviderId, runtimeId: string) => invoke<void>('provider_remove', { providerId, runtimeId });
/** Portable bundle export result. Identities stay provider-scoped: `provider`
 * plus `runtime_id`, never the native llama `(backend, build)` vocabulary. */
export interface PortableExportInfo {
  path: string; provider: ProviderId; runtime_id: string; variant: string;
  version: string; archive_sha256: string; bytes: number; wheels: number;
}
/** What a portable import publishes: a new app-owned `portable-*` runtime. */
export interface PortableRuntimeManifest {
  provider: ProviderId; id: string; kind: 'managed' | 'external';
  python: string; requested_version?: string | null;
}
/** Export one probed runtime as a portable archive (native save dialog). */
export const providerPortableExport = (providerId: ProviderId, runtimeId: string) =>
  invoke<PortableExportInfo>('provider_portable_export', { providerId, runtimeId });
/** Import one portable archive into a new isolated runtime (native open dialog). */
export const providerPortableImport = () => invoke<PortableRuntimeManifest>('provider_portable_import');
export const modelArtifact = (path: string) => invoke<ModelArtifact>('model_artifact', { path });
export const modelCompatibility = (cfg: AppConfig) => invoke<ModelCompatibility>('model_compatibility', { cfg });
export const providerCommandPreview = (cfg: AppConfig) => invoke<string[]>('provider_command_preview', { cfg });
export const providerOptionIssues = (cfg: AppConfig) => invoke<Array<{ key: string; code: string; message: string }>>('provider_option_issues', { cfg });
export const providerImportCommand = (providerId: ProviderId, command: string) => invoke<{ model?: string; options: Record<string, unknown>; issues: Array<{ key: string; message: string }> }>('provider_import_command', { providerId, command });
export async function listModelArtifacts(modelsDir: string, scanId?: string, selection?: { provider: ProviderId; runtime: string }) {
  const catalog = await invoke<{ models: CatalogModel[]; truncated: boolean }>('list_model_artifacts', { modelsDir, scanId: scanId ?? null,
    providerId: selection?.provider ?? null, runtimeId: selection?.runtime ?? null });
  const models: GgufModel[] = catalog.models.map(({ artifact, compatibility, shards }) => ({
    name: artifact.name, path: artifact.path, size_mb: artifact.size_bytes / 1024 / 1024,
    is_vision: artifact.role === 'projector', artifact, compatibility, ...(shards ? { shards } : {}),
  }));
  return { models, truncated: catalog.truncated };
}
export function modelLoadable(model: GgufModel, provider: ProviderId, task?: 'generate' | 'embed'): boolean {
  const result = model.compatibility?.find(value => value.provider === provider);
  return result ? ['supported', 'partial'].includes(result.status) && (task === undefined || result.tasks.includes(task))
    : provider === 'llama.cpp' && !model.is_vision;
}

/** Library filters include companions that are configured alongside a primary model. */
export function modelCompatibleForLibrary(model: GgufModel, provider: ProviderId): boolean {
  if (model.is_vision || model.artifact?.role === 'projector') return provider === 'llama.cpp' && (!model.artifact || model.artifact.format === 'gguf');
  return modelLoadable(model, provider);
}
