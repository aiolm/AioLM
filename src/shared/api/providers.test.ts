import { describe, expect, it, vi, beforeEach } from 'vitest';
import { modelCompatibleForLibrary, modelLoadable, runtimeLabel, providerPortableExport, providerPortableImport, type ModelArtifact, type ModelCompatibility, type RuntimeInstance } from './providers';
import { invoke } from './transport.ts';
import type { GgufModel } from './types';

vi.mock('./transport.ts', () => ({
  NATIVE_RUNTIME_ERROR: 'Native desktop runtime is unavailable.',
  isNativeRuntimeAvailable: vi.fn(() => true),
  invoke: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const compatibility = (tasks: string[], status: ModelCompatibility['status'] = 'supported'): ModelCompatibility => ({
  provider: 'vllm', tasks, status, modalities: { text: true, image: false, audio: false, video: false }, limitations: [], readiness: [], reasons: [], evidence: 'synthetic registry',
});
const model = (result: ModelCompatibility): GgufModel => ({ name: 'Synthetic model', path: '/synthetic/models/model', size_mb: 1, is_vision: false, compatibility: [result] });

describe('runtime model selection', () => {
  it('labels the vllm-metal plugin and core versions while retaining the existing provider', () => {
    const runtime: RuntimeInstance = { provider: 'vllm', id: 'synthetic-metal', engine: 'vllm', server: 'vllm',
      version: '0.30.0', variant: 'vllm-metal', plugin_version: '0.30.0', accelerator: 'metal',
      installation: 'managed', location: '/synthetic/runtime', available: true, problems: [] };
    expect(runtimeLabel(runtime)).toBe('vllm-metal 0.30.0 · vLLM 0.30.0 · metal · managed');
    expect(runtimeLabel({ ...runtime, plugin_version: undefined })).toBe('vllm-metal ? · vLLM 0.30.0 · metal · managed');
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
