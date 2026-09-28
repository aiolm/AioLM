import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { testConfig } from '../../testing/appStore';
import { I18nProvider } from '../../shared/i18n/i18n';
import { parseRuntimeHelp } from '../../shared/config/serverOptions';
import ResourceEstimatePanel from './ResourceEstimatePanel';
import { resourceEstimateConfig } from './useResourceEstimate';

vi.mock('../../shared/api', async original => ({ ...await original<typeof api>(), estimateModelResources: vi.fn() }));
const GiB = 1024 ** 3;
const estimate: api.ResourceEstimate = {
  vram_bytes: 5 * GiB, ram_offload_bytes: 2 * GiB, ssd_offload_bytes: 0, required_vram_bytes: 5 * GiB, host_memory_bytes: GiB / 2,
  vram_capacity_bytes: 8 * GiB, ram_capacity_bytes: 32 * GiB, disk_bytes: 6 * GiB, disk_complete: true, model_bytes: 5 * GiB,
  auxiliary_bytes: GiB, kv_bytes: GiB / 2, notes: ['approximate'],
};
const cfg = { ...testConfig, active_backend: 'cpu', active_model: 'models/example.gguf', runtime_defaults: [] };
function panel(config = cfg, invalid = false, open = true) {
  return <I18nProvider initialLocale="en"><ResourceEstimatePanel cfg={config} options={[]} verified={false} open={open} invalid={invalid} /></I18nProvider>;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const details = () => screen.getByText('Estimate details').closest('details')!;

describe('pre-load resource estimates', () => {
  beforeEach(() => { vi.resetAllMocks(); vi.mocked(api.estimateModelResources).mockResolvedValue(estimate); });

  it('summarizes VRAM, RAM Offload and SSD Offload as point estimates without loading or saving', async () => {
    const large = 22.5 * GiB;
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, vram_bytes: large, required_vram_bytes: large, vram_capacity_bytes: 24 * GiB });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-vram')).toHaveTextContent('22.50 GiB'));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB');
    expect(screen.getByTestId('resource-disk')).toHaveTextContent('0 B');
    const summary = screen.getByTestId('resource-vram').closest('dl')!;
    expect([...summary.querySelectorAll('dt')].map(term => term.textContent)).toEqual(['VRAM', 'RAM Offload', 'SSD Offload']);
    expect(summary).not.toHaveTextContent(/–/);
    expect(api.estimateModelResources).toHaveBeenCalledWith(cfg, []);
    expect(screen.getByRole('status')).toHaveTextContent('Estimated memory · updates with settings');
    expect(screen.getByText(/estimated values for this configuration, not measurements/)).not.toBeVisible();
    fireEvent.click(screen.getByText('Estimate details'));
    expect(screen.getByText(/estimated values for this configuration, not measurements/)).toBeVisible();
    expect(screen.getByText(/other apps and running models is not subtracted/)).toBeVisible();
    expect(within(details()).getByText('Fixed host memory').nextSibling).toHaveTextContent('512.0 MiB');
    expect(within(details()).getByText('Total VRAM').nextSibling).toHaveTextContent('24.00 GiB');
  });

  it('shows zero RAM and SSD Offload when the whole model fits in VRAM', async () => {
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, vram_bytes: 7 * GiB, required_vram_bytes: 7 * GiB, ram_offload_bytes: 0 });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-vram')).toHaveTextContent('7.00 GiB'));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent(/^0 B$/);
    expect(screen.getByTestId('resource-disk')).toHaveTextContent(/^0 B$/);
    expect(screen.getByText('Estimate details')).toHaveTextContent(/^Estimate details$/);
    expect(within(details()).queryByText('Requested VRAM')).not.toBeInTheDocument();
  });

  it('keeps SSD Offload separate from the size of stored model files', async () => {
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, vram_bytes: 8 * GiB, required_vram_bytes: 8 * GiB,
      ram_offload_bytes: 20 * GiB, ssd_offload_bytes: 2 * GiB, disk_bytes: 30 * GiB, model_bytes: 29 * GiB, notes: ['approximate', 'disk_offload'] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-disk')).toHaveTextContent('2.00 GiB'));
    expect(screen.getByText('Estimate details')).toHaveTextContent('Exceeds VRAM and RAM capacity');
    fireEvent.click(screen.getByText('Estimate details'));
    expect(screen.getByTestId('resource-files')).toHaveTextContent('30.00 GiB');
    expect(within(details()).getByText('Stored model files')).toBeVisible();
    expect(within(details()).getByText('Main model files').nextSibling).toHaveTextContent('29.00 GiB');
    expect(screen.getByText(/they are not SSD Offload/)).toBeVisible();
    expect(screen.getByText(/disk-backed access, such as memory-mapped files, when the runtime and settings allow it/)).toBeVisible();
  });

  it('shows explicit lazy SSD placement without an exceeded-capacity warning', async () => {
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, vram_bytes: 5 * GiB, required_vram_bytes: 5 * GiB,
      ram_offload_bytes: 0, ssd_offload_bytes: GiB / 2, vram_capacity_bytes: 24 * GiB, ram_capacity_bytes: 64 * GiB,
      notes: ['approximate', 'lazy_offload'] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-disk')).toHaveTextContent('512.0 MiB'));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent(/^0 B$/);
    expect(screen.getByText('Estimate details')).toHaveTextContent(/^Estimate details$/);
    fireEvent.click(screen.getByText('Estimate details'));
    expect(screen.getByText(/read on demand under the configured lazy mode/)).toBeVisible();
  });

  it('explains requested VRAM beyond capacity as a settings change the user must make', async () => {
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, required_vram_bytes: 12 * GiB, vram_bytes: 8 * GiB,
      ram_offload_bytes: 6 * GiB, notes: ['approximate', 'placement_adjustment'] });
    render(panel());
    await waitFor(() => expect(screen.getByText('Estimate details')).toHaveTextContent('Requested VRAM exceeds capacity'));
    fireEvent.click(screen.getByText('Estimate details'));
    expect(within(details()).getByText('Requested VRAM').nextSibling).toHaveTextContent('12.00 GiB');
    expect(screen.getByText(/the runtime does not move it automatically. Adjust GPU layers or offload settings/)).toBeVisible();
  });

  it('immediately requests edited options and ignores responses from earlier drafts', async () => {
    const earlier = deferred<api.ResourceEstimate>(); const latest = deferred<api.ResourceEstimate>();
    vi.mocked(api.estimateModelResources).mockReturnValueOnce(earlier.promise).mockReturnValueOnce(latest.promise);
    const view = render(panel());
    view.rerender(panel({ ...cfg, ctx_size: 8192, ngl: 20 }));
    expect(api.estimateModelResources).toHaveBeenLastCalledWith(expect.objectContaining({ ctx_size: 8192, ngl: 20 }), []);
    await act(async () => latest.resolve({ ...estimate, ram_offload_bytes: 3 * GiB }));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('3.00 GiB');
    await act(async () => earlier.resolve(estimate));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('3.00 GiB');
    const pending = deferred<api.ResourceEstimate>(); vi.mocked(api.estimateModelResources).mockReturnValueOnce(pending.promise);
    view.rerender(panel({ ...cfg, ctx_size: 16384 }));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('…');
    expect(screen.queryByText('3.00 GiB')).not.toBeInTheDocument();
  });

  it('withholds stale estimates for invalid edits, missing selection and closed dialogs', async () => {
    const view = render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    view.rerender(panel(cfg, true));
    expect(screen.getByText(/Finish editing valid settings/)).toBeVisible();
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('—');
    view.rerender(panel({ ...cfg, active_model: '' }));
    expect(screen.getByText(/Select a model and runtime/)).toBeVisible();
    view.rerender(panel({ ...cfg, ctx_size: 12345 }, false, false));
    expect(api.estimateModelResources).toHaveBeenCalledTimes(1);
  });

  it('recalculates instead of reusing the previous result when the same draft is reopened', async () => {
    const second = deferred<api.ResourceEstimate>(); const third = deferred<api.ResourceEstimate>();
    const view = render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    vi.mocked(api.estimateModelResources).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise);
    view.rerender(panel(cfg, false, false));
    view.rerender(panel());
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('…');
    view.rerender(panel(cfg, false, false));
    view.rerender(panel());
    await act(async () => second.resolve({ ...estimate, ram_offload_bytes: 3 * GiB }));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('…');
    await act(async () => third.resolve({ ...estimate, ram_offload_bytes: 4 * GiB }));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('4.00 GiB');
  });

  it('does not reuse an earlier error after invalid input returns to the same draft', async () => {
    vi.mocked(api.estimateModelResources).mockRejectedValueOnce(new Error('read failed'));
    const view = render(panel());
    await screen.findByRole('button', { name: 'Retry estimate' });
    const pending = deferred<api.ResourceEstimate>(); vi.mocked(api.estimateModelResources).mockReturnValueOnce(pending.promise);
    view.rerender(panel(cfg, true));
    view.rerender(panel());
    expect(screen.queryByRole('button', { name: 'Retry estimate' })).not.toBeInTheDocument();
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('…');
    await act(async () => pending.resolve(estimate));
    expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB');
  });

  it('distinguishes unavailable memory and an incomplete file total from zero', async () => {
    vi.mocked(api.estimateModelResources).mockResolvedValue({ ...estimate, vram_bytes: null, ram_offload_bytes: null, ssd_offload_bytes: null,
      required_vram_bytes: null, host_memory_bytes: null, disk_complete: false, disk_bytes: 0, notes: ['missing_files', 'unsupported_architecture'] });
    render(panel());
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('Unavailable'));
    expect(screen.getByTestId('resource-vram')).toHaveTextContent('Unavailable');
    expect(screen.getByTestId('resource-disk')).toHaveTextContent('Unavailable');
    fireEvent.click(screen.getByText('Estimate details'));
    expect(screen.getByTestId('resource-files')).toHaveTextContent('≥ 0 B');
    expect(screen.getByText(/stored file total is incomplete/)).toBeVisible();
  });

  it('keeps estimate details open while an edited draft is recalculated', async () => {
    const view = render(panel());
    fireEvent.click(await screen.findByText('Estimate details'));
    // Editing can happen before the browser dispatches its deferred toggle event.
    view.rerender(panel({ ...cfg, ctx_size: 8192 }));
    expect(screen.queryByText('Estimate details')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/they are not SSD Offload/)).toBeVisible());
  });

  it('re-estimates when runtime device lines change and ignores capacity from earlier devices', async () => {
    const withDevices = (devices: string[]) => <I18nProvider initialLocale="en"><ResourceEstimatePanel cfg={cfg} options={[]} verified={false} runtimeDevices={devices} open invalid={false} /></I18nProvider>;
    const first = ['CUDA0: Example GPU (8192 MiB, 7000 MiB free)'];
    const view = render(withDevices(first));
    await waitFor(() => expect(screen.getByTestId('resource-vram')).toHaveTextContent('5.00 GiB'));
    expect(api.estimateModelResources).toHaveBeenCalledWith(cfg, first);
    // Same lines in a new array are the same devices and do not request again.
    view.rerender(withDevices([...first]));
    expect(api.estimateModelResources).toHaveBeenCalledTimes(1);
    const stale = deferred<api.ResourceEstimate>(); const current = deferred<api.ResourceEstimate>();
    vi.mocked(api.estimateModelResources).mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
    const second = ['CUDA0: Larger GPU (24576 MiB, 23000 MiB free)'];
    view.rerender(withDevices(['CUDA0: Other GPU (16384 MiB, 15000 MiB free)']));
    view.rerender(withDevices(second));
    expect(api.estimateModelResources).toHaveBeenLastCalledWith(cfg, second);
    expect(screen.getByTestId('resource-vram')).toHaveTextContent('…');
    await act(async () => current.resolve({ ...estimate, vram_bytes: 7 * GiB, ram_offload_bytes: 0, vram_capacity_bytes: 24 * GiB }));
    await act(async () => stale.resolve({ ...estimate, vram_bytes: 3 * GiB }));
    expect(screen.getByTestId('resource-vram')).toHaveTextContent('7.00 GiB');
    expect(screen.getByTestId('resource-ram')).toHaveTextContent(/^0 B$/);
  });

  it('allows retry after a failed estimate', async () => {
    vi.mocked(api.estimateModelResources).mockRejectedValueOnce(new Error('read failed'));
    render(panel());
    fireEvent.click(await screen.findByRole('button', { name: 'Retry estimate' }));
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    expect(api.estimateModelResources).toHaveBeenCalledTimes(2);
  });

  it('resolves defaults from the selected runtime without substituting display fallback values', async () => {
    const options = parseRuntimeHelp('-c, --ctx-size N  context (default: 8192)\n-b, --batch-size N  batch size (default: 2048)');
    const inherited = { ...cfg, ctx_size: 777, ngl: 123, runtime_defaults: ['ctx_size', 'ngl', 'batch_size'] };
    expect(resourceEstimateConfig(inherited, options, true)).toMatchObject({ ctx_size: 4096, batch_size: 2048, ngl: 99, runtime_defaults: [] });
    expect(resourceEstimateConfig(inherited, options, false)).toMatchObject({ ctx_size: 4096, ngl: 99, runtime_defaults: ['batch_size'] });
    expect(inherited.ctx_size).toBe(777);
    render(<I18nProvider initialLocale="en"><ResourceEstimatePanel cfg={inherited} options={options} verified open invalid={false} /></I18nProvider>);
    await waitFor(() => expect(screen.getByTestId('resource-ram')).toHaveTextContent('2.00 GiB'));
    expect(api.estimateModelResources).toHaveBeenCalledWith(expect.objectContaining({ ctx_size: 4096, batch_size: 2048, ngl: 99, runtime_defaults: [] }), []);
  });

  it('keeps an inherited speculative type inherited because launch then skips the draft model', () => {
    const options = parseRuntimeHelp('--spec-type TYPE  speculative decoding type (default: draft)');
    const inherited = { ...cfg, spec_type: 'none', spec_draft_model: 'models/draft.gguf', runtime_defaults: ['spec_type'] };
    expect(resourceEstimateConfig(inherited, options, true)).toMatchObject({ spec_type: 'none', spec_draft_model: 'models/draft.gguf', runtime_defaults: ['spec_type'] });
  });
});
