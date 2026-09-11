import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { rtProbe } from '../../shared/api/index';
import type { RuntimeCapabilities } from '../../shared/api/types';
import { useServerOptions } from './useServerOptions';

vi.mock('../../shared/api/index', () => ({ rtProbe: vi.fn() }));

describe('runtime option refresh', () => {
  it('retains verified options during refresh and never exposes another runtime’s devices', async () => {
    const report: RuntimeCapabilities = { backend: 'vulkan', build: 'b234', executable: 'server', state: 'available', version: '', flags: [], diagnostics: [], devices: ['Vulkan0: GPU'], server_help: '--ctx-size N  size of the prompt context (default: 8192)' };
    vi.mocked(rtProbe).mockResolvedValueOnce(report);
    const { result, rerender } = renderHook(({ backend }) => useServerOptions(backend, 'b234'), { initialProps: { backend: 'vulkan' } });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const options = result.current.options;
    let complete!: (value: RuntimeCapabilities) => void;
    vi.mocked(rtProbe).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    act(() => result.current.refresh());
    expect(result.current.loading).toBe(true);
    expect(result.current.options).toBe(options);
    expect(result.current.capabilities).toBe(report);
    await act(async () => complete(report));
    vi.mocked(rtProbe).mockImplementationOnce(() => new Promise(() => undefined));
    rerender({ backend: 'cpu' });
    expect(result.current.loading).toBe(true);
    expect(result.current.capabilities).toBeUndefined();
    expect(result.current.verified).toBe(false);
  });
});
