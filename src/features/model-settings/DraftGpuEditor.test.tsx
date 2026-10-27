import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../shared/i18n/i18n';
import type { DeviceReport, GpuPlacement } from '../../shared/api/types';
import DraftGpuEditor from './DraftGpuEditor';
import { emptyGpuPlacement } from '../../shared/runtime/sessionUtils';
import { useState } from 'react';

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
  it('shows the saved manual placement without changing either field and switches explicitly to GPU selection', () => {
    const onChange = vi.fn();
    const manualChanges = vi.fn();
    function Harness() {
      const [manual, setManual] = useState('CUDA0,CUDA1');
      return <DraftGpuEditor placement={{ ...twoGpus, draft_gpu_id: 'gpu-b' }} device={device} disabled={false} onChange={onChange}
        draftDevice={manual} onDraftDeviceChange={value => { manualChanges(value); setManual(value); }} onInvalid={vi.fn()} />;
    }
    render(<I18nProvider initialLocale="en"><Harness /></I18nProvider>);
    expect(screen.getByLabelText('Draft device names')).toHaveValue('CUDA0,CUDA1');
    expect(screen.queryByRole('combobox', { name: 'Draft device' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled(); expect(manualChanges).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Draft device names'), { target: { value: 'none' } });
    expect(manualChanges).toHaveBeenLastCalledWith('none');
    fireEvent.click(screen.getByRole('combobox', { name: 'Draft model device' }));
    fireEvent.click(screen.getByRole('option', { name: 'Choose a detected GPU' }));
    expect(manualChanges).toHaveBeenLastCalledWith('');
    expect(screen.queryByLabelText('Draft device names')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Draft device' })).toHaveTextContent('gpu-b');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Draft model device' }));
    fireEvent.click(screen.getByRole('option', { name: 'Enter device names' }));
    expect(screen.getByLabelText('Draft device names')).toHaveValue('');
    expect(screen.queryByRole('combobox', { name: 'Draft device' })).not.toBeInTheDocument();
  });

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

  it('lets the user clear a saved assignment when the selected runtime reports no GPUs', () => {
    const placement = { ...twoGpus, main_gpu: 'gpu-a', tensor_split: [1, 2], draft_gpu_id: 'gpu-b' };
    const { onChange, onInvalid } = mount(placement, { ...device, profile: { ...device.profile, gpus: [] } } as DeviceReport);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Clear GPU assignment' }));
    expect(onChange).toHaveBeenCalledWith(emptyGpuPlacement());
    expect(onInvalid).toHaveBeenCalledWith('gpu_tensor_split', false);
    expect(placement.gpu_ids).toEqual(['gpu-a', 'gpu-b']);
  });

  it('keeps the clear action disabled while runtime settings are locked', () => {
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><DraftGpuEditor placement={twoGpus} device={null} disabled onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    const clear = screen.getByRole('button', { name: 'Clear GPU assignment' });
    expect(clear).toBeDisabled();
    fireEvent.click(clear);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not offer recovery for an already empty CPU assignment', () => {
    const { onChange } = mount(emptyGpuPlacement(), { ...device, profile: { ...device.profile, gpus: [] } } as DeviceReport);
    expect(screen.queryByRole('button', { name: 'Clear GPU assignment' })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });
});
