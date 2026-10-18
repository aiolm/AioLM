import { invoke } from './transport.ts';
import type { AppConfig, GgufModel } from './types.ts';
import type { CommandSyntax } from './runtimeHelp.ts';

import { PROVIDERS, isExternalProvider, type ProviderId } from './providerIdentity.ts';
export { PROVIDERS, isProviderId, isExternalProvider } from './providerIdentity.ts';
export type { ProviderId, BuiltinProviderId } from './providerIdentity.ts';
const optionSchemas = new Map<string, ProviderOption[]>();
export const runtimeOptionSchema = (provider: ProviderId, runtimeId?: string): ProviderOption[] | undefined => runtimeId ? optionSchemas.get(`${provider}/${runtimeId}`) : catalogSnapshot.find(item => item.id === provider)?.options;
let catalogSnapshot: ProviderDescription[] = [];
const catalogListeners = new Set<() => void>();
export const runtimeCatalogSnapshot = () => catalogSnapshot;
export const subscribeRuntimeCatalog = (listener: () => void) => { catalogListeners.add(listener); return () => { catalogListeners.delete(listener); }; };
export function publishRuntimeCatalog(catalog: ProviderDescription[]) { catalogSnapshot = catalog; for (const listener of catalogListeners) listener(); }
export const registeredProviderIds = (): ProviderId[] => [...new Set<ProviderId>([...PROVIDERS, ...catalogSnapshot.map(item => item.id)])];
export const providerDisplayName = (provider: ProviderId): string => provider === 'vllm' ? 'vLLM' : provider === 'mlx-vlm' ? 'MLX' : provider === 'llama.cpp' ? 'llama.cpp' : catalogSnapshot.find(item => item.id === provider)?.engine ?? provider;
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
export interface ModelCatalogSelection { provider: ProviderId; runtime: string; source: 'runtime-bindings' | 'library'; binding_paths: string[] }
export interface ModelCatalogRequest { provider: ProviderId; runtime: string; includeLibrary?: boolean }
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
  const identity = runtime.version && runtime.version !== runtime.id ? `${engine} (${runtime.id})` : engine;
  return `${identity} · ${runtime.accelerator} · ${runtime.installation}`;
}
export interface ProviderOption {
  key: string; flag?: string; group: string; target: 'launch' | 'request'; runtime_default?: string;
  kind: { type: 'integer' | 'number' | 'flag' | 'toggle' | 'choice' | 'text' | 'path' | 'json'; min?: number; max?: number; choices?: string[]; max_len?: number };
}
export interface ProviderDescription {
  id: ProviderId; engine: string; server: string; managed_version?: string;
  managed_variant?: string | null;
  kind?: 'external-process'; capabilities?: { benchmark: string; deep_verification: string; portable: string };
  availability: { supported: boolean; reason?: string; detail: string }; options: ProviderOption[];
}
export interface EngineInfo {
  provider: ProviderId; runtime_id: string; upstream_model: string; modalities: Modalities;
  runtime_variant?: string; speech_model_type?: string | null;
  tasks?: string[];
  chat_supported?: boolean;
  request_option_keys?: string[];
  request_fields: Record<string, unknown>; request_lora?: string;
  embedding_model?: string | null; embedding_namespace?: string | null; tools_auto?: boolean; tool_parser?: boolean;
}
let catalogRequest: Promise<ProviderDescription[]> | undefined;
export const providerCatalog = (fresh = false): Promise<ProviderDescription[]> => {
  // Registration must not reuse an inventory request started before publication.
  if (fresh && catalogRequest) return catalogRequest.catch(() => undefined).then(() => providerCatalog());
  if (!catalogRequest) catalogRequest = invoke<ProviderDescription[]>('provider_catalog').then(catalog => { publishRuntimeCatalog(catalog); return catalog; }).finally(() => { catalogRequest = undefined; });
  return catalogRequest;
};
export const pickRuntimeAdapter = () => invoke<string | null>('pick_runtime_adapter');
export const runtimeAdapterRegister = async (manifestPath: string) => { const registered = await invoke<{ engine_id: ProviderId; runtime_id: string; display_name: string }>('runtime_adapter_register', { manifestPath }); optionSchemas.delete(`${registered.engine_id}/${registered.runtime_id}`); return registered; };
export const providerRuntimes = () => invoke<RuntimeInstance[]>('provider_runtimes');
export const providerRuntimeOptions = async (providerId: ProviderId, runtimeId: string) => { const schema = await invoke<ProviderOption[]>('provider_runtime_options', { providerId, runtimeId }); optionSchemas.set(`${providerId}/${runtimeId}`, schema); return schema; };
export const providerInstall = (providerId: ProviderId, python?: string) => invoke('provider_install', { providerId, python: python ?? null });
export const providerRegister = (providerId: ProviderId, python: string) => invoke('provider_register', { providerId, python });
export const providerRemove = async (providerId: ProviderId, runtimeId: string) => { await invoke<void>('provider_remove', { providerId, runtimeId }); optionSchemas.delete(`${providerId}/${runtimeId}`); };
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
export interface ImportedProviderCommand {
  model?: string;
  options: Record<string, unknown>;
  issues: Array<{ key: string; message: string }>;
  managed?: string[];
  unrecognized?: string[];
}

/** Native v1 reports review buckets; the settings API also promises issues.
 * Keep the wire response intact and normalize that promise at this boundary. */
export async function providerImportCommand(providerId: ProviderId, command: string, syntax?: CommandSyntax): Promise<ImportedProviderCommand> {
  const result = await invoke<Omit<ImportedProviderCommand, 'issues'> & { issues?: ImportedProviderCommand['issues'] }>(
    'provider_import_command', { providerId, command, ...(syntax ? { syntax } : {}) },
  );
  const issues = result.issues ?? [
    ...(result.managed?.length ? [{ key: 'managed', message: `Review app-managed arguments: ${result.managed.join(' ')}` }] : []),
    ...(result.unrecognized?.length ? [{ key: 'unrecognized', message: `Review unrecognized arguments: ${result.unrecognized.join(' ')}` }] : []),
  ];
  return { ...result, issues };
}
export async function listModelArtifacts(modelsDir: string, scanId?: string, selection?: ModelCatalogRequest) {
  const catalog = await invoke<{ models: CatalogModel[]; truncated: boolean; selection?: ModelCatalogSelection }>('list_model_artifacts', { modelsDir, scanId: scanId ?? null,
    providerId: selection?.provider ?? null, runtimeId: selection?.runtime ?? null,
    ...(selection?.includeLibrary === undefined ? {} : { includeLibrary: selection.includeLibrary }) });
  const models: GgufModel[] = catalog.models.map(({ artifact, compatibility, shards }) => {
    // Snapshot basenames can be revisions. The native inspector separately
    // records repository identity from its manifest or the HF cache layout.
    const repositoryName = artifact.format !== 'gguf'
      ? /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.exec(artifact.repository ?? '')?.[1]
      : undefined;
    return {
      name: repositoryName ?? artifact.name, path: artifact.path, size_mb: artifact.size_bytes / 1024 / 1024,
      is_vision: artifact.role === 'projector', artifact, compatibility, ...(shards ? { shards } : {}),
    };
  });
  return { models, truncated: catalog.truncated, ...(catalog.selection ? { selection: catalog.selection } : {}) };
}
export function modelLoadable(model: GgufModel, provider: ProviderId, task?: 'generate' | 'embed'): boolean {
  const result = model.compatibility?.find(value => value.provider === provider);
  return result ? ['supported', 'partial'].includes(result.status) && (task === undefined || result.tasks.includes(task))
    : provider === 'llama.cpp' && !model.is_vision;
}

/** A candidate can be selected for a probe without claiming that it can run. */
export function modelSelectable(model: GgufModel, provider: ProviderId): boolean {
  return isExternalProvider(provider)
    ? model.compatibility?.find(value => value.provider === provider)?.status !== 'unsupported'
    : modelLoadable(model, provider);
}

/** Library filters include companions that are configured alongside a primary model. */
export function modelCompatibleForLibrary(model: GgufModel, provider: ProviderId): boolean {
  if (isExternalProvider(provider)) return modelSelectable(model, provider);
  if (model.is_vision || model.artifact?.role === 'projector') return provider === 'llama.cpp' && (!model.artifact || model.artifact.format === 'gguf');
  return modelLoadable(model, provider);
}
