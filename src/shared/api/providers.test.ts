import { serverSettingsChanged } from '../config/executionSettings';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { providerCatalog, providerRuntimeOptions, runtimeOptionSchema, runtimeAdapterRegister, providerRemove, type ProviderOption, publishRuntimeCatalog, type ProviderDescription, listModelArtifacts, modelCompatibleForLibrary, modelLoadable, runtimeLabel, providerPortableExport, providerPortableImport, type ModelArtifact, type ModelCompatibility, type RuntimeInstance } from './providers';
import { invoke } from './transport.ts';
import type { AppConfig, GgufModel } from './types';
import { modelSelectable, providerImportCommand } from './providers';
import { entrypointHelpDiscover, runtimeHelpImport, type EntrypointHelp } from './runtimeHelp';
import { effectiveSchema } from '../../testing/effectiveSchema';
import { testConfig } from '../../testing/appStore';

vi.mock('./transport.ts', () => ({
  NATIVE_RUNTIME_ERROR: 'Native desktop runtime is unavailable.',
  isNativeRuntimeAvailable: vi.fn(() => true),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe('additive command import syntax contract', () => {
  it('preserves the old entry point help payload and adds explicit current settings only when supplied', async () => {
    const entry: EntrypointHelp = { engine_id: 'custom.synthetic', runtime_id: 'build-1', program: '/synthetic/engine',
      prefix: [], artifacts: [], environment: {}, protocol: { kind: 'openai_http' } };
    const request = { args: ['--help'], scope: [] };
    await entrypointHelpDiscover(entry, request);
    expect(invoke).toHaveBeenLastCalledWith('entrypoint_help_discover', { entry, request });
    await entrypointHelpDiscover(entry, request, testConfig);
    expect(invoke).toHaveBeenLastCalledWith('entrypoint_help_discover', { entry, request, cfg: testConfig });
  });
  it('normalizes the existing native import response into the issues contract used by the settings UI', async () => {
    const response = { options: { max_model_len: 4096 }, managed: [], unrecognized: [] };
    vi.mocked(invoke).mockResolvedValue(response);
    const result = await providerImportCommand('vllm', '--max-model-len 4096', 'windows');
    expect(result).toMatchObject({ options: response.options, issues: [] });
    expect(result).toMatchObject({ managed: [], unrecognized: [] });
  });

  it('keeps native managed and unknown arguments available as explicit review issues', async () => {
    vi.mocked(invoke).mockResolvedValue({ options: {}, managed: ['--port 8000'], unrecognized: ['--fresh-value', 'kept'] });
    const result = await providerImportCommand('vllm', '--port 8000 --fresh-value kept', 'posix');
    expect(result.issues).toEqual([
      expect.objectContaining({ key: 'managed', message: expect.stringContaining('--port 8000') }),
      expect.objectContaining({ key: 'unrecognized', message: expect.stringContaining('--fresh-value kept') }),
    ]);
  });

  it('keeps the old provider payload when syntax is omitted and sends explicit Windows syntax when chosen', async () => {
    vi.mocked(invoke).mockResolvedValue({ options: {}, issues: [] });
    const command = String.raw`--template C:\tpl\x.jinja`;
    await providerImportCommand('vllm', command);
    expect(invoke).toHaveBeenLastCalledWith('provider_import_command', { providerId: 'vllm', command });
    await providerImportCommand('vllm', command, 'windows');
    expect(invoke).toHaveBeenLastCalledWith('provider_import_command', { providerId: 'vllm', command, syntax: 'windows' });
  });

  it('keeps the old effective-schema payload and adds only the selected quoting rule', async () => {
    vi.mocked(invoke).mockResolvedValue({ plan: [], managed: [], unrecognized: [] });
    const schema = effectiveSchema([]).schema;
    const text = '--workers 4';
    await runtimeHelpImport(schema, [], text);
    expect(invoke).toHaveBeenLastCalledWith('runtime_help_import', { schema, scope: [], text });
    await runtimeHelpImport(schema, [], text, 'posix');
    expect(invoke).toHaveBeenLastCalledWith('runtime_help_import', { schema, scope: [], text, syntax: 'posix' });
  });
});

const compatibility = (tasks: string[], status: ModelCompatibility['status'] = 'supported'): ModelCompatibility => ({
  provider: 'vllm', tasks, status, modalities: { text: true, image: false, audio: false, video: false }, limitations: [], readiness: [], reasons: [], evidence: 'synthetic registry',
});
const model = (result: ModelCompatibility): GgufModel => ({ name: 'Synthetic model', path: '/synthetic/models/model', size_mb: 1, is_vision: false, compatibility: [result] });

describe('runtime model selection', () => {
  it('keeps external candidates selectable without claiming support from their format', () => {
    const provider = 'custom.unknown';
    const candidate = model({ ...compatibility([], 'unknown'), provider });
    expect(modelLoadable(candidate, provider)).toBe(false);
    expect(modelSelectable(candidate, provider)).toBe(true);
    expect(modelCompatibleForLibrary(candidate, provider)).toBe(true);
    expect(modelSelectable({ ...candidate, compatibility: undefined }, provider)).toBe(true);
    expect(modelSelectable(model({ ...compatibility([], 'unsupported'), provider }), provider)).toBe(false);
    expect(modelSelectable(model(compatibility([], 'unknown')), 'vllm')).toBe(false);
  });
  it('preserves omitted catalog IPC defaults and returns the exact selected runtime view', async () => {
    vi.mocked(invoke).mockResolvedValue({ models: [], truncated: false });
    await listModelArtifacts('models', 'scan');
    expect(invoke).toHaveBeenLastCalledWith('list_model_artifacts', { modelsDir: 'models', scanId: 'scan', providerId: null, runtimeId: null });
    const selection = { provider: 'custom.example' as const, runtime: 'one', source: 'runtime-bindings' as const, binding_paths: ['deployment.json'] };
    vi.mocked(invoke).mockResolvedValue({ models: [], truncated: false, selection });
    expect((await listModelArtifacts('models', 'scan', { provider: selection.provider, runtime: selection.runtime, includeLibrary: false })).selection).toEqual(selection);
    expect(invoke).toHaveBeenLastCalledWith('list_model_artifacts', { modelsDir: 'models', scanId: 'scan', providerId: selection.provider, runtimeId: 'one', includeLibrary: false });
  });
  it('names catalog snapshots from proven repositories while preserving external folders and GGUF filenames', async () => {
    const revision = '0123456789abcdef0123456789abcdef01234567';
    const artifact: ModelArtifact = { path: `/synthetic/models/${revision}`, name: revision, format: 'hf-safetensors',
      role: 'model', size_bytes: 1024, file_count: 3, architectures: ['LlamaForCausalLM'],
      modalities: { text: true, image: false, audio: false, video: false }, missing: [], incomplete: false,
      ownership: 'external', notes: [] };
    const artifacts = [
      { ...artifact, repository: 'org/synthetic-model', ownership: 'app' },
      { ...artifact, format: 'mlx', repository: 'org/synthetic-mlx', ownership: 'hf-cache' },
      artifact,
      { ...artifact, name: 'custom-folder', path: '/synthetic/models/custom-folder' },
      { ...artifact, name: 'weights.Q4_K_M.gguf', format: 'gguf', repository: 'org/repository-name' },
      { ...artifact, repository: 'invalid/repository/extra' },
    ];
    vi.mocked(invoke).mockResolvedValue({ models: artifacts.map(value => ({ artifact: value, compatibility: [] })), truncated: false });
    const result = await listModelArtifacts('/synthetic/models');
    expect(result.models.map(value => value.name)).toEqual(['synthetic-model', 'synthetic-mlx', revision, 'custom-folder', 'weights.Q4_K_M.gguf', revision]);
    expect(result.models.map(value => value.path)).toEqual(artifacts.map(value => value.path));
    expect(result.models.map(value => value.artifact)).toEqual(artifacts);
  });
  it('labels the vllm-metal plugin and core versions while retaining the existing provider', () => {
    const runtime: RuntimeInstance = { provider: 'vllm', id: 'synthetic-metal', engine: 'vllm', server: 'vllm',
      version: '0.30.0', variant: 'vllm-metal', plugin_version: '0.30.0', accelerator: 'metal',
      installation: 'managed', location: '/synthetic/runtime', available: true, problems: [] };
    expect(runtimeLabel(runtime)).toBe('vllm-metal 0.30.0 · vLLM 0.30.0 (synthetic-metal) · metal · managed');
    expect(runtimeLabel({ ...runtime, plugin_version: undefined })).toBe('vllm-metal ? · vLLM 0.30.0 (synthetic-metal) · metal · managed');
  });
  it('distinguishes installed runtime identities that report the same version and accelerator', () => {
    const runtime: RuntimeInstance = { provider: 'custom.synthetic', id: 'build-one', engine: 'Synthetic engine', server: 'engine',
      version: '1.0', accelerator: 'cpu', installation: 'external', location: '/synthetic/one', available: true, problems: [] };
    const other = { ...runtime, id: 'build-two', location: '/synthetic/two' };
    expect(runtimeLabel(runtime)).not.toBe(runtimeLabel(other));
    expect(runtimeLabel(runtime)).toContain('build-one');
    expect(runtimeLabel(other)).toContain('build-two');
    expect(runtimeLabel({ ...runtime, version: undefined })).toBe('build-one · cpu · external');
    expect(runtimeLabel({ ...runtime, version: runtime.id })).toBe('build-one · cpu · external');
  });
  it('allows an embedding-only model to run while excluding it from generation workflows', () => {
    const embedding = model(compatibility(['embed']));
    expect(modelLoadable(embedding, 'vllm')).toBe(true);
    expect(modelLoadable(embedding, 'vllm', 'embed')).toBe(true);
    expect(modelLoadable(embedding, 'vllm', 'generate')).toBe(false);
    expect(modelLoadable(model(compatibility(['generate'], 'unknown')), 'vllm')).toBe(false);
  });
  it('includes GGUF projectors in the llama.cpp library filter while keeping primary model selection separate', () => {
    const projector: GgufModel = { name: 'mmproj.gguf', path: '/synthetic/models/mmproj.gguf', size_mb: 1, is_vision: true,
      artifact: { role: 'projector', format: 'gguf' } as ModelArtifact };
    expect(modelCompatibleForLibrary(projector, 'llama.cpp')).toBe(true);
    expect(modelCompatibleForLibrary(projector, 'vllm')).toBe(false);
    expect(modelCompatibleForLibrary(projector, 'mlx-vlm')).toBe(false);
    expect(modelLoadable(projector, 'llama.cpp')).toBe(false);
  });
});

describe('portable runtime IPC', () => {
  it('exports one provider runtime through its own command with provider-scoped identities', async () => {
    const info = { path: '/synthetic/bundle.zip', provider: 'vllm', runtime_id: 'portable-0-31-0-synthetic',
      variant: 'standard', version: '0.31.0', archive_sha256: 'synthetic-digest', bytes: 128, wheels: 6 };
    vi.mocked(invoke).mockResolvedValue(info);
    await expect(providerPortableExport('vllm', 'portable-0-31-0-synthetic')).resolves.toEqual(info);
    expect(invoke).toHaveBeenCalledWith('provider_portable_export', { providerId: 'vllm', runtimeId: 'portable-0-31-0-synthetic' });
    expect(info).not.toHaveProperty('backend');
    expect(info).not.toHaveProperty('build');
  });
  it('imports a bundle through its own command without touching llama backend/build identities', async () => {
    const imported = { provider: 'mlx-vlm', id: 'portable-0-7-6-synthetic', kind: 'managed', python: '/synthetic/python' };
    vi.mocked(invoke).mockResolvedValue(imported);
    await expect(providerPortableImport()).resolves.toEqual(imported);
    expect(invoke).toHaveBeenCalledWith('provider_portable_import');
    expect(imported.id.startsWith('portable-')).toBe(true);
  });
});


describe('external runtime inventory publication', () => {
  it('fetches a new catalog after registration instead of reusing an older in-flight snapshot', async () => {
    let release!: (value: ProviderDescription[]) => void;
    const old = new Promise<ProviderDescription[]>(done => { release = done; });
    const fresh: ProviderDescription[] = [{ id: 'custom.new', engine: 'New engine', server: 'openai-v1', options: [], availability: { supported: true, detail: 'Synthetic' } }];
    vi.mocked(invoke).mockReturnValueOnce(old).mockResolvedValueOnce(fresh);
    const pending = providerCatalog();
    const afterRegistration = providerCatalog(true);
    expect(invoke).toHaveBeenCalledTimes(1);
    release([]);
    await pending;
    await expect(afterRegistration).resolves.toEqual(fresh);
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('invalidates a re-registered runtime schema and never substitutes another installation schema', async () => {
    publishRuntimeCatalog([{ id: 'custom.cache', engine: 'Synthetic', server: 'openai-v1', options: [], availability: { supported: true, detail: 'Synthetic' } }]);
    const schema = [{ key: 'temperature', target: 'request', group: 'sampling', kind: { type: 'number', min: 0, max: 2 } }];
    vi.mocked(invoke).mockResolvedValueOnce(schema);
    await providerRuntimeOptions('custom.cache', 'build-1');
    expect(runtimeOptionSchema('custom.cache', 'build-1')).toEqual(schema);
    expect(runtimeOptionSchema('custom.cache', 'build-2')).toBeUndefined();
    vi.mocked(invoke).mockResolvedValueOnce({ engine_id: 'custom.cache', runtime_id: 'build-1', display_name: 'Synthetic' });
    await runtimeAdapterRegister('/synthetic/new-manifest.json');
    expect(runtimeOptionSchema('custom.cache', 'build-1')).toBeUndefined();
  });
});

function pendingRuntimeOptions() {
  let resolve!: (schema: ProviderOption[]) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<ProviderOption[]>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

const publicationSchema = (target: ProviderOption['target']): ProviderOption[] => [
  { key: 'mode', flag: '--mode', target, group: 'synthetic', kind: { type: 'text' } },
];

describe('runtime option response publication ownership', () => {
  it.each(['remove', 'register'] as const)('does not republish a pending schema after successful %s invalidation', async mutation => {
    const provider = `custom.pending.${mutation}` as const;
    const runtime = 'build-1';
    const cached = publicationSchema('launch');
    const old = publicationSchema('request');
    const unrelated = publicationSchema('launch');
    vi.mocked(invoke).mockResolvedValueOnce(cached).mockResolvedValueOnce(unrelated);
    await expect(providerRuntimeOptions(provider, runtime)).resolves.toBe(cached);
    await providerRuntimeOptions(provider, 'other-build');
    const delayed = pendingRuntimeOptions();
    vi.mocked(invoke).mockReturnValueOnce(delayed.promise);
    const pending = providerRuntimeOptions(provider, runtime);
    expect(invoke).toHaveBeenLastCalledWith('provider_runtime_options', { providerId: provider, runtimeId: runtime });
    if (mutation === 'remove') {
      vi.mocked(invoke).mockResolvedValueOnce(undefined);
      await expect(providerRemove(provider, runtime)).resolves.toBeUndefined();
      expect(invoke).toHaveBeenLastCalledWith('provider_remove', { providerId: provider, runtimeId: runtime });
    } else {
      const registration = { engine_id: provider, runtime_id: runtime, display_name: 'Synthetic replacement' };
      vi.mocked(invoke).mockResolvedValueOnce(registration);
      await expect(runtimeAdapterRegister('/synthetic/replacement-manifest.json')).resolves.toBe(registration);
      expect(invoke).toHaveBeenLastCalledWith('runtime_adapter_register', { manifestPath: '/synthetic/replacement-manifest.json' });
    }
    expect(runtimeOptionSchema(provider, runtime)).toBeUndefined();
    expect(runtimeOptionSchema(provider, 'other-build')).toBe(unrelated);
    delayed.resolve(old);
    await expect(pending).resolves.toBe(old);
    expect(runtimeOptionSchema(provider, runtime)).toBeUndefined();
    expect(runtimeOptionSchema(provider, 'other-build')).toBe(unrelated);
    const base = { ...testConfig, active_provider: provider, active_runtime: runtime, provider_options: { [provider]: { mode: 'before' } } };
    expect(serverSettingsChanged(base, { ...base, provider_options: { [provider]: { mode: 'after' } } })).toBe(true);
  });

  it('retains the latest same-runtime result and other runtime identities when an older read finishes last', async () => {
    const provider = 'custom.latest';
    const runtime = 'same-build';
    const otherRuntime = publicationSchema('request');
    const otherProvider = publicationSchema('request');
    vi.mocked(invoke).mockResolvedValueOnce(otherRuntime).mockResolvedValueOnce(otherProvider);
    await providerRuntimeOptions(provider, 'other-build');
    await providerRuntimeOptions('custom.other', runtime);
    const old = publicationSchema('request');
    const fresh = publicationSchema('launch');
    const delayed = pendingRuntimeOptions();
    vi.mocked(invoke).mockReturnValueOnce(delayed.promise).mockResolvedValueOnce(fresh);
    const pending = providerRuntimeOptions(provider, runtime);
    await expect(providerRuntimeOptions(provider, runtime)).resolves.toBe(fresh);
    expect(runtimeOptionSchema(provider, runtime)).toBe(fresh);
    delayed.resolve(old);
    await expect(pending).resolves.toBe(old);
    expect(runtimeOptionSchema(provider, runtime)).toBe(fresh);
    expect(runtimeOptionSchema(provider, 'other-build')).toBe(otherRuntime);
    expect(runtimeOptionSchema('custom.other', runtime)).toBe(otherProvider);
    const base: AppConfig = { ...testConfig, active_provider: provider, active_runtime: runtime, provider_options: { [provider]: { mode: 'before' } } };
    expect(serverSettingsChanged(base, { ...base, provider_options: { [provider]: { mode: 'after' } } })).toBe(true);
  });

  it.each(['remove', 'register'] as const)('preserves cached facts and a pending publisher when %s fails', async mutation => {
    const provider = `custom.failed.${mutation}` as const;
    const runtime = 'build-1';
    const cached = publicationSchema('launch');
    const fresh = publicationSchema('request');
    vi.mocked(invoke).mockResolvedValueOnce(cached);
    await providerRuntimeOptions(provider, runtime);
    const delayed = pendingRuntimeOptions();
    vi.mocked(invoke).mockReturnValueOnce(delayed.promise);
    const pending = providerRuntimeOptions(provider, runtime);
    const failure = new Error(`Synthetic ${mutation} failure`);
    vi.mocked(invoke).mockRejectedValueOnce(failure);
    if (mutation === 'remove') await expect(providerRemove(provider, runtime)).rejects.toBe(failure);
    else await expect(runtimeAdapterRegister('/synthetic/failed-manifest.json')).rejects.toBe(failure);
    expect(runtimeOptionSchema(provider, runtime)).toBe(cached);
    delayed.resolve(fresh);
    await expect(pending).resolves.toBe(fresh);
    expect(runtimeOptionSchema(provider, runtime)).toBe(fresh);
  });

  it('preserves the exact read failure and leaves a newer pending publisher intact', async () => {
    const provider = 'custom.pending.error';
    const runtime = 'build-1';
    const cached = publicationSchema('launch');
    const fresh = publicationSchema('request');
    vi.mocked(invoke).mockResolvedValueOnce(cached);
    await providerRuntimeOptions(provider, runtime);
    const older = pendingRuntimeOptions();
    const newer = pendingRuntimeOptions();
    vi.mocked(invoke).mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const oldRequest = providerRuntimeOptions(provider, runtime);
    const newRequest = providerRuntimeOptions(provider, runtime);
    const failure = new Error('Synthetic declaration read failed');
    const rejection = expect(oldRequest).rejects.toBe(failure);
    older.reject(failure);
    await rejection;
    expect(runtimeOptionSchema(provider, runtime)).toBe(cached);
    newer.resolve(fresh);
    await expect(newRequest).resolves.toBe(fresh);
    expect(runtimeOptionSchema(provider, runtime)).toBe(fresh);
  });
});
