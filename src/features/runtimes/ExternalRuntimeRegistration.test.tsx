import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { I18nProvider } from '../../shared/i18n/i18n';
import ExternalRuntimeRegistration from './ExternalRuntimeRegistration';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(api, 'runtimeAdapterRegister').mockResolvedValue({ engine_id: 'custom.synthetic', runtime_id: 'build-1', display_name: 'Synthetic engine' });
  vi.spyOn(api, 'providerCatalog').mockResolvedValue([]);
  vi.spyOn(api, 'rtCancel').mockResolvedValue(undefined);
});
const mount = (locked = false) => {
  const selected = vi.fn(); const busy = vi.fn();
  render(<I18nProvider initialLocale="en"><ExternalRuntimeRegistration locked={locked} onRegistered={selected} onBusyChange={busy} /></I18nProvider>);
  return { selected, busy };
};

describe('external engine registration', () => {
  it('registers a selected manifest and changes browsing without applying model settings', async () => {
    const { selected, busy } = mount();
    fireEvent.change(screen.getByRole('textbox', { name: 'Runtime manifest path' }), { target: { value: '/synthetic/runtime.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
    await waitFor(() => expect(selected).toHaveBeenCalledWith('custom.synthetic', expect.objectContaining({ runtime_id: 'build-1', display_name: 'Synthetic engine' })));
    expect(api.runtimeAdapterRegister).toHaveBeenCalledWith('/synthetic/runtime.json');
    expect(screen.getByRole('status')).toHaveTextContent('Synthetic engine · build-1');
    await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  });
  it('keeps a published registration visible when only inventory refresh fails', async () => {
    vi.mocked(api.providerCatalog).mockRejectedValueOnce(new Error('Synthetic inventory failure'));
    const { selected } = mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/synthetic/runtime.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Registered successfully, but inventory refresh failed.');
    expect(screen.getByRole('status')).toHaveTextContent('build-1');
    expect(selected).toHaveBeenCalledWith('custom.synthetic', expect.objectContaining({ runtime_id: 'build-1', display_name: 'Synthetic engine' }));
  });
  it('locks registration while model resources are in use', () => {
    mount(true);
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Probe & register' })).toBeDisabled();
    expect(api.runtimeAdapterRegister).not.toHaveBeenCalled();
  });
  it('cancels a pending probe without losing the chosen manifest', async () => {
    let fail!: (error: string) => void;
    vi.mocked(api.runtimeAdapterRegister).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const { selected } = mount();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '/synthetic/runtime.json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Probe & register' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(api.rtCancel).toHaveBeenCalledOnce());
    await act(async () => fail('runtime probe cancelled'));
    expect(selected).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox')).toHaveValue('/synthetic/runtime.json');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
