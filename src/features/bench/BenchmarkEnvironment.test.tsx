import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { BenchmarkEnvironment } from './BenchmarkEnvironment';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { rtProbe } from '../../shared/api';
import type { AppConfig, DeviceReport, RuntimeCapabilities } from '../../shared/api/types';
import { materializeProfileApplication } from '../../shared/config/settingsProfiles';

vi.mock('../../shared/api/transport', () => ({ isNativeRuntimeAvailable: () => true }));
vi.mock('../../shared/api', () => ({ rtProbe: vi.fn() }));

const device: DeviceReport = {
  profile: { schema_version: 1, os: 'test', arch: 'x86_64', detection: 'fixture', fingerprint: 'synthetic',
    cpu: { name: 'Example CPU', physical_cores: 8, logical_cores: 16 },
    gpus: [{ stable_id: 'gpu-a', name: 'Example GPU A', vendor: 'amd', integrated: false, vram_mb: 8192 },
      { stable_id: 'gpu-b', name: 'Example GPU B', vendor: 'amd', integrated: false, vram_mb: 16384 }] },
  backends: [], system_memory_bytes: 64 * 1024 ** 3,
};
const cfg: AppConfig = { ...testConfig, active_backend: 'vulkan', ngl: 24, runtime_defaults: [],
  gpu: { gpu_ids: ['gpu-b'], main_gpu: 'gpu-b', split_mode: 'layer', tensor_split: [] } };
const capabilities = (backend = 'vulkan', devices: string[] = []): RuntimeCapabilities => ({
  backend, devices, diagnostics: [], server_help: '', build: 'b123', executable: 'test-runtime', state: 'available', version: '', flags: [],
});
const view = (config = cfg, report: DeviceReport | null = device) => <I18nProvider initialLocale="en"><BenchmarkEnvironment config={config}
  application={materializeProfileApplication(config, '', { id: 'example-profile', name: 'Example profile', scope: 'global', revision: 1, settings: {} })} device={report} runtimes={[]} active busy={false} /></I18nProvider>;
const term = (name: string) => within(screen.getByRole('region', { name: 'Execution environment' })).getByText(name).nextElementSibling!;

beforeEach(() => { vi.clearAllMocks(); vi.mocked(rtProbe).mockResolvedValue(capabilities()); });
afterEach(cleanup);

describe('benchmark execution environment', () => {
  it('shows only selected hardware with physical capacities and profile settings', async () => {
    render(view());
    expect(term('Selected GPU')).toHaveTextContent('Example GPU B · 16.00 GiB VRAM');
    expect(screen.queryByText(/Example GPU A/)).not.toBeInTheDocument();
    expect(term('CPU / system RAM')).toHaveTextContent('8 Core / 16 Thread · 64.00 GiB RAM');
    expect(term('Profile')).toHaveTextContent('Example profile');
    expect(term('GPU layers')).toHaveTextContent('24');
    expect(term('CPU threads')).toHaveTextContent('Automatic');
    await waitFor(() => expect(rtProbe).toHaveBeenCalledWith('vulkan', 'b123'));
  });

  it('groups the profile launch options apart from the hardware that supports them', async () => {
    render(view());
    const region = screen.getByRole('region', { name: 'Execution environment' });
    const settings = within(region).getByRole('heading', { name: 'Key settings' }).nextElementSibling as HTMLElement;
    const hardware = within(region).getByRole('heading', { name: 'Hardware' }).nextElementSibling as HTMLElement;
    for (const label of ['GPU layers', 'CPU threads', 'Batch / microbatch', 'KV cache (K / V)', 'Flash Attention']) expect(settings).toHaveTextContent(label);
    expect(settings).not.toHaveTextContent('Example GPU B');
    expect(hardware).toHaveTextContent('Example GPU B · 16.00 GiB VRAM');
    expect(hardware).toHaveTextContent('Example CPU');
    expect(hardware).not.toHaveTextContent('GPU layers');
    await waitFor(() => expect(rtProbe).toHaveBeenCalled());
  });

  it('uses runtime device names and reported memory without equating runtime and OS indexes', async () => {
    vi.mocked(rtProbe).mockResolvedValue(capabilities('vulkan', ['Vulkan0: Example Runtime GPU (24576 MiB, 23000 MiB free)']));
    render(view({ ...cfg, gpu: { ...cfg.gpu!, gpu_ids: ['runtime:vulkan:Vulkan0'] } }));
    await waitFor(() => expect(term('Selected GPU')).toHaveTextContent('Vulkan0 · Example Runtime GPU · 24.00 GiB VRAM'));
    expect(term('Selected GPU')).not.toHaveTextContent('free');
    expect(term('Selected GPU')).not.toHaveTextContent('Example GPU A');
    expect(term('Selected GPU')).not.toHaveTextContent('runtime:vulkan:');
  });

  it('keeps unknown and automatic GPU selections distinct from installed adapters', async () => {
    const rendered = render(view({ ...cfg, gpu: { ...cfg.gpu!, gpu_ids: ['missing'] } }));
    await waitFor(() => expect(term('Selected GPU')).toHaveTextContent('Device specifications unavailable'));
    rendered.rerender(view({ ...cfg, gpu: { ...cfg.gpu!, gpu_ids: [] } }));
    expect(term('Selected GPU')).toHaveTextContent('Runtime selects the GPU at launch');
    expect(term('Selected GPU')).not.toHaveTextContent('Example GPU');
  });

  it('shows only the main GPU in single-device mode and honors the explicit draft device', async () => {
    vi.mocked(rtProbe).mockResolvedValue(capabilities('vulkan', ['Vulkan2: Example Draft GPU (8192 MiB)']));
    render(view({ ...cfg, spec_type: 'draft', spec_draft_device: 'Vulkan2',
      gpu: { ...cfg.gpu!, gpu_ids: ['gpu-a', 'gpu-b'], main_gpu: 'gpu-b', split_mode: 'single', draft_gpu_id: 'gpu-a' } }));
    await waitFor(() => expect(term('Selected GPU')).toHaveTextContent('Example Draft GPU · 8.00 GiB VRAM'));
    expect(term('Selected GPU')).toHaveTextContent('Example GPU B');
    expect(term('Selected GPU')).not.toHaveTextContent('Example GPU A');
    expect(term('Selected GPU')).toHaveTextContent('Draft');
  });

  it('keeps speculative modes without a draft file separate from CPU-only execution', async () => {
    const rendered = render(view({ ...cfg, ngl: 0, mmproj: '  ', spec_type: 'none' }));
    expect(term('Selected GPU')).toHaveTextContent('CPU only');
    rendered.rerender(view({ ...cfg, ngl: 0, spec_type: 'ngram-simple', spec_draft_model: '', spec_draft_device: 'none' }));
    expect(term('Selected GPU')).toHaveTextContent('Example GPU B');
    expect(term('Selected GPU')).toHaveTextContent('CPU only · Draft');
    await waitFor(() => expect(rtProbe).toHaveBeenCalled());
  });

  it('ignores raw aliases filtered by launch and does not show stale inherited values', async () => {
    render(view({ ...cfg, ngl: 0, threads: 6, cache_type_k: 'stale', runtime_defaults: ['cache_type_k'],
      server_args: ['--threads', '5', '-t=7', '--n-gpu-layers=48', '--device=Vulkan0'] }));
    expect(term('Selected GPU')).toHaveTextContent('CPU only');
    expect(term('GPU layers')).toHaveTextContent('0');
    expect(term('CPU threads')).toHaveTextContent('6');
    expect(term('KV cache (K / V)')).not.toHaveTextContent('stale');
    await waitFor(() => expect(rtProbe).toHaveBeenCalled());
  });

  it('drops an old runtime response after changing the selected backend', async () => {
    let resolveOld!: (value: RuntimeCapabilities) => void;
    vi.mocked(rtProbe).mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(capabilities('cuda', ['CUDA0: Example CUDA GPU (8192 MiB)']));
    const rendered = render(view({ ...cfg, gpu: { ...cfg.gpu!, gpu_ids: ['runtime:vulkan:Vulkan0'] } }));
    rendered.rerender(view({ ...cfg, active_backend: 'cuda', gpu: { ...cfg.gpu!, gpu_ids: ['runtime:cuda:CUDA0'] } }));
    await waitFor(() => expect(term('Selected GPU')).toHaveTextContent('Example CUDA GPU'));
    await act(async () => resolveOld(capabilities('vulkan', ['Vulkan0: Old GPU'])));
    expect(term('Selected GPU')).not.toHaveTextContent('Old GPU');
  });
});
