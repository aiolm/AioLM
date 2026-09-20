import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { cancelModelScan, listModels, type ModelScanResult } from '../../shared/api';
import { invalidateModelCatalog, useModelCatalog } from './useModelCatalog';

vi.mock('../../shared/api', () => ({ listModels: vi.fn(), cancelModelScan: vi.fn(async () => undefined) }));

describe('model catalog', () => {
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
