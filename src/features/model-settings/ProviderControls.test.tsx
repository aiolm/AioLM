import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import * as api from '../../shared/api';
import { ProviderOptions } from './ProviderControls';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerOptionIssues: vi.fn(), providerRuntimeOptions: vi.fn(),
}));

describe('runtime-specific option controls', () => {
  it('shows category-specific engine options and preserves values in other categories', async () => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'vllm', availability: { supported: true, detail: '' }, options: [
      { key: 'max_model_len', flag: '--max-model-len', target: 'launch', group: 'context', kind: { type: 'integer' } },
      { key: 'temperature', target: 'request', group: 'sampling', kind: { type: 'number' } },
    ] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([]);
    const onChange = vi.fn(); const onInvalid = vi.fn();
    const config = { ...testConfig, active_provider: 'vllm' as const, active_runtime: '', provider_options: { vllm: { max_model_len: 8192, temperature: 0.2 } } };
    const view = (section: string) => <I18nProvider initialLocale="en"><ProviderOptions cfg={config} section={section} disabled={false} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>;
    const rendered = render(view('sampling'));
    const temperature = await screen.findByLabelText(/^temperature/);
    expect(screen.queryByLabelText(/^--max-model-len/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^extra_args/)).not.toBeInTheDocument();
    fireEvent.change(temperature, { target: { value: '0.5' } });
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { vllm: { max_model_len: 8192, temperature: 0.5 } } });
    rendered.rerender(view('tuning'));
    expect(await screen.findByLabelText(/^--max-model-len/)).toBeVisible();
    expect(screen.queryByLabelText(/^temperature/)).not.toBeInTheDocument();
  });
  beforeEach(() => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'vllm', availability: { supported: true, detail: '' }, options: [
      { key: 'max_model_len', flag: '--max-model-len', target: 'launch', group: 'context', kind: { type: 'integer', min: 1, max: 10000 } },
      { key: 'temperature', target: 'request', group: 'sampling', kind: { type: 'number', min: 0, max: 100 } },
    ] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([{ provider: 'vllm', id: 'synthetic', engine: 'vllm', server: 'vllm', accelerator: 'cuda', installation: 'external', location: 'runtime', available: true, problems: [], server_flags: [] }]);
    vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
    vi.mocked(api.providerRuntimeOptions).mockImplementation(async () => (await api.providerCatalog())[0].options);
  });
  function mount(values: Record<string, unknown> = {}) {
    const onChange = vi.fn(); const onInvalid = vi.fn();
    const view = render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...testConfig, active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: values } }} disabled={false} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>);
    return { ...view, onChange, onInvalid };
  }
  it('shows supported request options and hides unsupported launch and adapter bindings', async () => {
    mount({ trust_remote_code: false });
    expect(await screen.findByLabelText(/^temperature/)).toBeVisible();
    expect(screen.queryByLabelText(/^--max-model-len/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^lora_adapters/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^request_lora/)).not.toBeInTheDocument();
    expect(screen.queryByText('trust_remote_code')).not.toBeInTheDocument();
  });
  it('keeps saved unsupported bindings editable and clears them without losing other engine values', async () => {
    const { onChange } = mount({ max_model_len: 8192, lora_adapters: [], request_lora: 'adapter', temperature: 0.2 });
    const field = await screen.findByLabelText(/^--max-model-len/);
    expect(screen.getByLabelText(/^lora_adapters/)).toBeVisible();
    fireEvent.change(field, { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { vllm: { lora_adapters: [], request_lora: 'adapter', temperature: 0.2 } } });
  });
  it('explains invalid JSON locally, blocks applying it, and releases validation on unmount', async () => {
    const { onChange, onInvalid, unmount } = mount();
    const field = await screen.findByLabelText(/^extra_args/);
    fireEvent.change(field, { target: { value: '[' } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Check the option format and allowed range.');
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(onInvalid).toHaveBeenCalledWith('provider:extra_args', true));
    unmount();
    expect(onInvalid).toHaveBeenCalledWith('provider:extra_args', false);
  });
  it('uses the selected Metal option schema even when the generic vLLM flag exists', async () => {
    vi.mocked(api.providerRuntimes).mockResolvedValue([{ provider: 'vllm', id: 'synthetic', engine: 'vllm', server: 'vllm',
      accelerator: 'metal', variant: 'vllm-metal', plugin_version: '0.30.0', installation: 'external', location: 'runtime',
      available: true, problems: [], server_flags: ['--tensor-parallel-size', '--kv-cache-dtype'] }]);
    vi.mocked(api.providerRuntimeOptions).mockResolvedValue([
      { key: 'kv_cache_dtype', flag: '--kv-cache-dtype', target: 'launch', group: 'memory', kind: { type: 'choice', choices: ['auto'] } },
    ]);
    mount({ max_model_len: 8192 });
    const cache = await screen.findByLabelText(/^--kv-cache-dtype/);
    fireEvent.click(cache);
    expect(screen.getByRole('option', { name: 'auto' })).toBeVisible();
    expect(screen.queryByRole('option', { name: 'fp8' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^--tensor-parallel-size/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^--max-model-len/)).not.toBeInTheDocument();
    expect(screen.getByText('max_model_len')).toBeVisible();
    expect(api.providerRuntimeOptions).toHaveBeenCalledWith('vllm', 'synthetic');
  });
});
