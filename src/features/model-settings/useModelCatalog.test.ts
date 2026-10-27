import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelModelScan, listModels, type ModelScanResult } from '../../shared/api';
import { invalidateModelCatalog, useModelCatalog } from './useModelCatalog';
import { testConfig } from '../../testing/appStore';

vi.mock('../../shared/api', () => ({ listModels: vi.fn(), cancelModelScan: vi.fn(async () => undefined) }));

describe('model catalog', () => {
  beforeEach(() => { vi.mocked(listModels).mockReset(); vi.mocked(cancelModelScan).mockClear(); });
  it('starts with selected runtime bindings and explicitly explores unverified library candidates', async () => {
    const selection = { provider: 'custom.example' as const, runtime: 'one', source: 'runtime-bindings' as const, binding_paths: ['deployment.json'] };
    vi.mocked(listModels).mockResolvedValue({ models: [], truncated: false, selection });
    const { result, rerender } = renderHook(({ runtime }) => useModelCatalog('', true, { ...testConfig, active_provider: selection.provider, active_runtime: runtime }), { initialProps: { runtime: 'one' } });
    await waitFor(() => expect(result.current.selection).toEqual(selection));
    expect(listModels).toHaveBeenLastCalledWith('', expect.any(String), { provider: selection.provider, runtime: 'one', includeLibrary: false });
    act(() => result.current.exploreLibrary());
    await waitFor(() => expect(listModels).toHaveBeenLastCalledWith('', expect.any(String), { provider: selection.provider, runtime: 'one', includeLibrary: true }));
    vi.mocked(listModels).mockResolvedValue({ models: [], truncated: false, selection: { ...selection, runtime: 'two' } });
    rerender({ runtime: 'two' });
    await waitFor(() => expect(listModels).toHaveBeenLastCalledWith('', expect.any(String), { provider: selection.provider, runtime: 'two', includeLibrary: false }));
    await waitFor(() => expect(result.current.selection?.runtime).toBe('two'));
  });
  it('rejects catalog facts belonging to another runtime', async () => {
    vi.mocked(listModels).mockResolvedValue({ models: [], truncated: false, selection: { provider: 'custom.example', runtime: 'other', source: 'library', binding_paths: [] } });
    const { result } = renderHook(() => useModelCatalog('models', true, { ...testConfig, active_provider: 'custom.example', active_runtime: 'selected' }));
    await waitFor(() => expect(result.current.error).toContain('another runtime'));
    expect(result.current.selection).toBeUndefined();
  });
  it('discards superseded scans and refreshes after catalog changes', async () => {
    let finishOld!: (value: ModelScanResult) => void;
    vi.mocked(listModels).mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }))
      .mockResolvedValue({ models: [{ path: 'new/model.gguf', name: 'model.gguf', size_mb: 1, is_vision: false }], truncated: false });
    const { result, rerender } = renderHook(({ path }) => useModelCatalog(path), { initialProps: { path: 'old' } });
    rerender({ path: 'new' });
    expect(cancelModelScan).toHaveBeenCalledWith(vi.mocked(listModels).mock.calls[0][1]);
    await waitFor(() => expect(result.current.loading).toBe(false));
    await act(async () => { finishOld({ models: [], truncated: true }); });
    expect(result.current.models[0].path).toBe('new/model.gguf');
    expect(result.current.truncated).toBe(false);
    const calls = vi.mocked(listModels).mock.calls.length;
    act(() => invalidateModelCatalog());
    await waitFor(() => expect(vi.mocked(listModels).mock.calls.length).toBe(calls + 1));
  });
});
