import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import * as api from '../../shared/api';
import { ProviderOptions } from './ProviderControls';
import { providerTelemetryCopy } from './providerTelemetry';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerOptionIssues: vi.fn(), providerRuntimeOptions: vi.fn(),
}));

describe('runtime-specific option controls', () => {
  it('keeps saved options intact while their runtime schema is being checked', async () => {
    let resolveSchema!: (options: api.ProviderOption[]) => void;
    vi.mocked(api.providerRuntimeOptions).mockReturnValueOnce(new Promise(resolve => { resolveSchema = resolve; }));
    const onInvalid = vi.fn(); const onChecking = vi.fn(); const onChange = vi.fn();
    const view = render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...testConfig, active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { max_model_len: 8192 } } }} disabled={false} onChange={onChange} onInvalid={onInvalid} onChecking={onChecking} /></I18nProvider>);
    expect(onChecking).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('button', { name: 'Clear value' })).not.toBeInTheDocument();
    expect(onInvalid).not.toHaveBeenCalledWith('provider-options', true);
    await act(async () => { resolveSchema([{ key: 'max_model_len', flag: '--max-model-len', target: 'launch', group: 'context', kind: { type: 'integer' } }]); });
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    expect(screen.getByLabelText(/^--max-model-len/)).toHaveValue('8192');
    expect(onChange).not.toHaveBeenCalled();
    view.unmount();
    expect(onChecking).toHaveBeenLastCalledWith(false);
  });

  it('blocks a failed runtime schema check without offering to reset unchecked options', async () => {
    vi.mocked(api.providerRuntimeOptions).mockRejectedValueOnce(new Error('Synthetic schema probe failed'));
    const onInvalid = vi.fn(); const onChecking = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...testConfig, active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { max_model_len: 8192 } } }} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={onChecking} /></I18nProvider>);
    expect(await screen.findByText(/Synthetic schema probe failed/)).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Clear value' })).not.toBeInTheDocument();
    await waitFor(() => expect(onInvalid).toHaveBeenCalledWith('provider-options', true));
  });

  it('still reports an option absent from a successfully loaded runtime schema', async () => {
    const onInvalid = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...testConfig, active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { unsupported_option: 3 } } }} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText('unsupported_option')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Clear value' })).toBeEnabled();
    await waitFor(() => expect(onInvalid).toHaveBeenCalledWith('provider-options', true));
  });

  it('keeps a failed schema check blocked when an option value triggers validation again', async () => {
    vi.mocked(api.providerRuntimeOptions).mockRejectedValueOnce(new Error('Synthetic schema probe failed'));
    const onInvalid = vi.fn(); const onChecking = vi.fn();
    const config = { ...testConfig, active_provider: 'vllm' as const, active_runtime: 'synthetic', provider_options: { vllm: { max_model_len: 8192 } } };
    const view = (cfg: api.AppConfig) => <I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={onChecking} /></I18nProvider>;
    const rendered = render(view(config));
    expect(await screen.findByText(/Synthetic schema probe failed/)).toBeVisible();
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    const calls = vi.mocked(api.providerOptionIssues).mock.calls.length;
    rendered.rerender(view({ ...config, provider_options: { vllm: { max_model_len: 4096 } } }));
    await waitFor(() => expect(api.providerOptionIssues).toHaveBeenCalledTimes(calls + 1));
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    expect(screen.getByText(/Synthetic schema probe failed/)).toBeVisible();
    expect(onInvalid).toHaveBeenLastCalledWith('provider-options', true);
    expect(screen.queryByRole('button', { name: 'Clear value' })).not.toBeInTheDocument();
  });

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

  function telemetryControls(flags = ['--enable-prompt-tokens-details', '--enable-per-request-metrics'], accelerator = 'metal') {
    vi.mocked(api.providerRuntimes).mockResolvedValue([{ provider: 'vllm', id: 'synthetic', engine: 'vllm', server: 'vllm',
      accelerator, ...(accelerator === 'metal' ? { variant: 'vllm-metal' } : {}), installation: 'external', location: 'runtime', available: true,
      problems: [], server_flags: flags }]);
    vi.mocked(api.providerRuntimeOptions).mockResolvedValue([
      { key: 'enable_prompt_tokens_details', flag: '--enable-prompt-tokens-details', target: 'launch', group: 'metrics', kind: { type: 'flag' }, runtime_default: 'false' },
      { key: 'enable_per_request_metrics', flag: '--enable-per-request-metrics', target: 'launch', group: 'metrics', kind: { type: 'flag' }, runtime_default: 'false' },
    ]);
  }

  it('shows automatic supported telemetry without saving implicit values and allows an explicit opt-out', async () => {
    telemetryControls();
    const { onChange } = mount({ temperature: 0.2 });
    const details = await screen.findByLabelText('--enable-prompt-tokens-details');
    expect(screen.getAllByText(providerTelemetryCopy.en.hint)).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(details);
    expect(screen.getByRole('option', { name: providerTelemetryCopy.en.automatic })).toBeVisible();
    fireEvent.click(screen.getByRole('option', { name: 'false' }));
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { vllm: { temperature: 0.2, enable_prompt_tokens_details: false } } });
  });

  it('keeps per-request telemetry at the runtime default when engine stats are explicitly disabled', async () => {
    telemetryControls();
    mount({ extra_args: ['--disable_log_stats'] });
    const metrics = await screen.findByLabelText('--enable-per-request-metrics');
    expect(screen.getAllByText(providerTelemetryCopy.en.hint)).toHaveLength(1);
    fireEvent.click(metrics);
    expect(screen.getByRole('option', { name: 'Runtime default' })).toBeVisible();
    expect(screen.queryByRole('option', { name: providerTelemetryCopy.en.automatic })).not.toBeInTheDocument();
  });

  it.each([
    ['--enable-per-request-metrics', '--no-enable-per-request-metrics'],
    ['--enable-per-request-metrics', '--no_enable_per_request_metrics'],
    ['--enable-prompt-tokens-details', '--no-enable-prompt-tokens-details'],
    ['--enable-prompt-tokens-details', '--no_enable_prompt_tokens_details'],
  ])('keeps %s truthful when a standard runtime opts out with raw %s', async (flag, raw) => {
    telemetryControls(['--enable-prompt-tokens-details', '--enable-per-request-metrics', raw.replace(/_/g, '-')], 'cuda');
    const { onChange } = mount({ extra_args: [raw] });
    const metrics = await screen.findByLabelText(flag);
    expect(screen.getAllByText(providerTelemetryCopy.en.hint)).toHaveLength(1);
    fireEvent.click(metrics);
    expect(screen.getByRole('option', { name: 'Runtime default' })).toBeVisible();
    expect(screen.queryByRole('option', { name: providerTelemetryCopy.en.automatic })).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not promise automatic telemetry when the selected runtime has not reported the flags', async () => {
    telemetryControls([]);
    mount({ enable_per_request_metrics: false });
    const metrics = await screen.findByLabelText('--enable-per-request-metrics');
    expect(screen.queryByText(providerTelemetryCopy.en.hint)).not.toBeInTheDocument();
    fireEvent.click(metrics);
    expect(screen.getByRole('option', { name: 'Runtime default' })).toBeVisible();
  });
});
