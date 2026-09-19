import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { DeviceReport, GpuPlacement } from '../../shared/api/types';
import DraftGpuEditor from './DraftGpuEditor';

const device = { profile: { gpus: [
  { stable_id: 'gpu-a', name: 'Radeon 9700', vendor: 'amd', integrated: false, vram_mb: 16384 },
  { stable_id: 'gpu-b', name: 'Radeon 9700', vendor: 'amd', integrated: false, vram_mb: 16384 },
] }, backends: [] } as unknown as DeviceReport;

const twoGpus: GpuPlacement = {
  gpu_ids: ['gpu-a', 'gpu-b'], main_gpu: null, split_mode: 'layer', tensor_split: [], draft_gpu_id: null,
};

function mount(placement: GpuPlacement = twoGpus, devices = device) {
  const onChange = vi.fn();
  const onInvalid = vi.fn();
  render(<I18nProvider initialLocale="en"><DraftGpuEditor placement={placement} device={devices} disabled={false} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>);
  return { onChange, onInvalid };
}

describe('DraftGpuEditor linkage', () => {
  it('keeps weights editable in non-tensor modes while two GPUs are selected', () => {
    mount();
    expect(screen.getByLabelText('Tensor split (comma-separated weights)')).toBeEnabled();
  });

  it('disables the weights input with fewer than two GPUs selected', () => {
    mount({ ...twoGpus, gpu_ids: ['gpu-a'] });
    expect(screen.getByLabelText('Tensor split (comma-separated weights)')).toBeDisabled();
  });

  it('disables the main GPU selector with no GPU selected', () => {
    mount({ ...twoGpus, gpu_ids: [] });
    expect(screen.getByRole('combobox', { name: 'Main GPU' })).toBeDisabled();
  });

  it('keeps mode switches passing weights through untouched', () => {
    const { onChange } = mount({ ...twoGpus, split_mode: 'tensor', tensor_split: [1, 1] });
    fireEvent.click(screen.getByRole('combobox', { name: 'Multi-GPU split mode' }));
    fireEvent.click(screen.getByRole('option', { name: 'layer' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ split_mode: 'layer', tensor_split: [1, 1] }));
  });

  it('stays quiet about missing devices before the runtime reports any', () => {
    // A backend switch empties this list until the new probe answers; warning
    // then claimed every saved GPU was gone.
    mount(twoGpus, { ...device, profile: { ...device.profile, gpus: [] } } as DeviceReport);
    expect(screen.queryByText('This saved assignment references a GPU that is not detected. Reselect it before loading.')).not.toBeInTheDocument();
  });

  it('names a main GPU and a split mode instead of offering an automatic choice', async () => {
    mount({ ...twoGpus, main_gpu: null, split_mode: 'none' });
    expect(screen.getByRole('combobox', { name: 'Main GPU' })).toHaveTextContent('gpu-a');
    expect(screen.getByRole('combobox', { name: 'Multi-GPU split mode' })).toHaveTextContent('layer');

    fireEvent.click(screen.getByRole('combobox', { name: 'Multi-GPU split mode' }));
    await waitFor(() => expect(screen.getAllByRole('option')).toHaveLength(4));
    expect(screen.queryByRole('option', { name: 'Automatic' })).not.toBeInTheDocument();
  });

  it('keeps the automatic choice for the draft device, which is genuinely optional', async () => {
    mount();
    fireEvent.click(screen.getByRole('combobox', { name: 'Draft device' }));
    await waitFor(() => expect(screen.getByRole('option', { name: 'Automatic' })).toBeInTheDocument());
  });

  it('offers no action that empties the placement', () => {
    // An empty selection means "let the backend decide", which this app refuses
    // for indistinguishable cards. Selecting a runtime fills the placement with
    // the devices it reports, so there is nothing here to clear it back to.
    mount();
    expect(screen.queryByRole('button', { name: 'Automatic' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
