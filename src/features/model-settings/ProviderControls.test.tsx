import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import * as api from '../../shared/api';
import { ProviderOptions, ProviderRuntimeControl } from './ProviderControls';
import { providerTelemetryCopy } from './providerTelemetry';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerOptionIssues: vi.fn(), providerRuntimeOptions: vi.fn(),
  providerOptionSchema: vi.fn(), runtimeHelpTarget: vi.fn(),
}));

// The effective schema is the runtime's catalog mapping, as the backend builds it.
beforeEach(() => {
  vi.mocked(api.runtimeHelpTarget).mockReturnValue(new Promise(() => undefined));
  vi.mocked(api.providerOptionSchema).mockImplementation(async cfg => effectiveSchema(await api.providerRuntimeOptions(api.providerOf(cfg), cfg.active_runtime ?? '')));
});

describe('runtime inventory readiness', () => {
  it('withdraws cached readiness while refreshing and keeps a failed inventory unconfirmed', async () => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([{ id: 'synthetic', provider: 'vllm', engine: 'vllm', server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'runtime', available: true, problems: [] }]);
    const onReady = vi.fn(); const onChange = vi.fn();
    const view = (revision: number) => <I18nProvider initialLocale="en"><ProviderRuntimeControl cfg={{ ...testConfig, active_provider: 'vllm', active_runtime: 'synthetic' }} disabled={false} onProvider={vi.fn()} onChange={onChange} onReady={onReady} revision={revision} /></I18nProvider>;
    const rendered = render(view(0));
    expect(onReady).toHaveBeenLastCalledWith(null);
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(true));
    let fail!: (cause: Error) => void;
    vi.mocked(api.providerRuntimes).mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject; }));
    rendered.rerender(view(1));
    await waitFor(() => expect(onReady).toHaveBeenLastCalledWith(null));
    expect(screen.getByRole('status')).toBeVisible();
    await act(async () => { fail(new Error('Synthetic inventory read failed')); });
    expect(await screen.findByText(/Synthetic inventory read failed/)).toBeVisible();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(onReady).toHaveBeenLastCalledWith(null);
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('runtime-specific option controls', () => {
  it('renders an installed native build option through the same schema and retains other engine values', async () => {
    const extra = schemaOption({ key: 'fresh-native', flag: '--fresh-native', target: 'launch', group: 'runtime', kind: { type: 'integer' } });
    vi.mocked(api.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], [extra]));
    const onChange = vi.fn();
    const native = { ...testConfig, active_provider: 'llama.cpp' as const, active_backend: 'cpu', active_build: 'b1', provider_options: { vllm: { temperature: 0.5 } } };
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={native} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    const field = await screen.findByLabelText(/^--fresh-native/);
    fireEvent.change(field, { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { vllm: { temperature: 0.5 }, 'llama.cpp': { 'fresh-native': 0 } } });
    expect(api.providerOptionSchema).toHaveBeenCalledWith(native);
  });
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

describe('custom engine before a runtime is chosen (U1)', () => {
  it('asks for a runtime instead of validating an empty runtime id, then validates once one is chosen', async () => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'custom.synthetic', engine: 'Synthetic engine', server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([]);
    vi.mocked(api.providerOptionIssues).mockReset();
    // What the native check answers for an empty id; the panel must never ask it.
    vi.mocked(api.providerOptionIssues).mockRejectedValue('invalid runtime id: ');
    const onInvalid = vi.fn(); const onChecking = vi.fn();
    const config = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: '' };
    const view = (cfg: api.AppConfig) => <I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={onChecking} /></I18nProvider>;
    const rendered = render(view(config));
    expect(await screen.findByText('Choose a runtime')).toBeVisible();
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(screen.queryByText(/invalid runtime id/)).not.toBeInTheDocument();
    expect(api.providerOptionIssues).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Command preview' })).toBeDisabled();

    vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
    vi.mocked(api.providerRuntimeOptions).mockResolvedValue([]);
    rendered.rerender(view({ ...config, active_runtime: 'syn-1' }));
    await waitFor(() => expect(api.providerOptionIssues).toHaveBeenCalledOnce());
    expect(vi.mocked(api.providerOptionIssues).mock.calls[0][0]).toMatchObject({ active_provider: 'custom.synthetic', active_runtime: 'syn-1' });
    expect(screen.getByRole('button', { name: 'Command preview' })).toBeEnabled();
  });
});

describe('registered engine options from accepted help (G04)', () => {
  const fresh = { ...schemaOption({ key: 'fresh_pair', flag: '--fresh-pair', target: 'launch', group: 'options', kind: { type: 'text' } }),
    kind: { value: null, certainty: 'unknown' as const }, arity: { value: { min: 2, max: 2 }, certainty: 'verified' as const, source: { kind: 'help', document: 'stdout', start_line: 1, end_line: 1 } } };
  const config = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: 'syn-1' };
  beforeEach(() => {
    vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'custom.synthetic', engine: 'Synthetic', server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
    vi.mocked(api.providerRuntimes).mockResolvedValue([]);
    vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
    vi.mocked(api.providerRuntimeOptions).mockResolvedValue([{ key: 'workers', flag: '--workers', target: 'launch', group: 'runtime', kind: { type: 'integer', min: 1, max: 8 } }]);
  });

  it('discards an imported command that finishes after a different runtime is selected', async () => {
    let finish!: (value: api.ImportedPlan) => void;
    const imported = vi.spyOn(api, 'runtimeHelpImport').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onChange = vi.fn();
    const view = (cfg: api.AppConfig) => <I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>;
    const rendered = render(view(config));
    await screen.findByLabelText(/^--workers/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Import command' }), { target: { value: '--workers 4' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    rendered.rerender(view({ ...config, active_runtime: 'syn-2' }));
    await act(async () => { finish({ plan: [{ key: 'workers', values: [4] }], managed: [], unrecognized: [] }); });
    expect(onChange).not.toHaveBeenCalled();
    imported.mockRestore();
  });

  it('requires explicit command syntax and passes Windows paths to the common import without guessing', async () => {
    const path = String.raw`C:\한글 dir\x.jinja`;
    const option = schemaOption({ key: 'template', flag: '--template', target: 'launch', group: 'options', kind: { type: 'path' } });
    vi.mocked(api.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], [option]));
    const imported = vi.spyOn(api, 'runtimeHelpImport').mockResolvedValue({ plan: [{ key: 'template', values: [path] }], managed: [], unrecognized: [] });
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={config} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--template/);
    const text = `--template "${path}"`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Import command' }), { target: { value: text } });
    expect(screen.getByRole('button', { name: 'Import command' })).toBeDisabled();
    expect(imported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'Windows argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    await waitFor(() => expect(imported).toHaveBeenCalledWith(expect.any(Object), [], text, 'windows'));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ provider_options: expect.objectContaining({ 'custom.synthetic': expect.objectContaining({ template: path }) }) })));
    imported.mockRestore();
  });

  it('discards an import result after the quoting rules change', async () => {
    let finish!: (value: api.ImportedPlan) => void;
    const imported = vi.spyOn(api, 'runtimeHelpImport').mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={config} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--workers/);
    fireEvent.change(screen.getByRole('textbox', { name: 'Import command' }), { target: { value: '--workers 4' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'Windows argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    await act(async () => { finish({ plan: [{ key: 'workers', values: [4] }], managed: [], unrecognized: [] }); });
    expect(onChange).not.toHaveBeenCalled();
    imported.mockRestore();
  });

  it('masks a schema-sensitive value in the launch preview', async () => {
    const sensitive = schemaOption({ key: 'secret', flag: '--secret', target: 'launch', group: 'options', kind: { type: 'text' } });
    sensitive.sensitive = { value: true, certainty: 'verified' };
    vi.mocked(api.providerOptionSchema).mockResolvedValueOnce(effectiveSchema([], [sensitive]));
    const preview = vi.spyOn(api, 'providerCommandPreview').mockResolvedValue(['/synthetic/engine', '--secret', 'synthetic-credential']);
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': { secret: 'synthetic-credential' } } }} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--secret/);
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    expect(await screen.findByText(/•••/)).toBeVisible();
    expect(screen.queryByText(/synthetic-credential/)).not.toBeInTheDocument();
    preview.mockRestore();
  });

  it('shows a failed command preview without blocking the valid draft from being saved or started', async () => {
    // D21: the runtime was registered without a model, so the exact launch
    // command needs the fresh probe that start runs; the options stay valid.
    const preview = vi.spyOn(api, 'providerCommandPreview').mockRejectedValue('selected model requires a fresh adapter probe');
    const onInvalid = vi.fn(); const onChecking = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': { workers: 2 } } }} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={onChecking} /></I18nProvider>);
    await screen.findByLabelText(/^--workers/);
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    expect(onInvalid).toHaveBeenLastCalledWith('provider-options', false);
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    expect(await screen.findByText('selected model requires a fresh adapter probe')).toBeVisible();
    expect(onInvalid).toHaveBeenLastCalledWith('provider-options', false);
    expect(onInvalid).not.toHaveBeenCalledWith('provider-options', true);
    preview.mockRestore();
  });

  it('keeps a failed option check blocked and visible after a successful command preview', async () => {
    vi.mocked(api.providerOptionIssues).mockRejectedValue('Synthetic option check failed');
    const preview = vi.spyOn(api, 'providerCommandPreview').mockResolvedValue(['/synthetic/engine', '--workers', '2']);
    const onInvalid = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': { workers: 2 } } }} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} onChecking={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText('Synthetic option check failed')).toBeVisible();
    await waitFor(() => expect(onInvalid).toHaveBeenLastCalledWith('provider-options', true));
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    expect(await screen.findByText(/"--workers" "2"/)).toBeVisible();
    expect(screen.getByText('Synthetic option check failed')).toBeVisible();
    expect(onInvalid).toHaveBeenLastCalledWith('provider-options', true);
    preview.mockRestore();
  });

  it('renders manifest and help options with one renderer and saves into the profile', async () => {
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema(
      [{ key: 'workers', flag: '--workers', target: 'launch', group: 'runtime', kind: { type: 'integer', min: 1, max: 8 } }], [fresh]));
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': { workers: 2 } } }} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    expect(await screen.findByLabelText(/^--workers/)).toHaveValue('2');
    fireEvent.click(screen.getByRole('button', { name: 'Add occurrence' }));
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { 'custom.synthetic': { workers: 2, fresh_pair: { spelling: null, occurrences: [['', '']] } } } });
    expect(screen.getByText('The accepted help matches this runtime.')).toBeVisible();
  });

  it('saves a confirmed repetition pinned to the accepted help and revalidates', async () => {
    const effective = effectiveSchema([{ key: 'workers', flag: '--workers', target: 'launch', group: 'runtime', kind: { type: 'integer', min: 1, max: 8 } }], [fresh]);
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effective);
    const confirm = vi.spyOn(api, 'runtimeHelpConfirmSyntax').mockResolvedValue(effective);
    const cfg = { ...config, provider_options: { 'custom.synthetic': { fresh_pair: { spelling: null, occurrences: [['a', 'b'], ['c', 'd']] } } } };
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--workers/);
    // Catalog options are adapter facts; only the help option offers confirmation.
    expect(screen.getAllByText(/^Confirm value syntax/)).toHaveLength(1);
    const issueCalls = vi.mocked(api.providerOptionIssues).mock.calls.length;
    fireEvent.click(screen.getByRole('combobox', { name: 'repeatable (--fresh-pair)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Can repeat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save confirmed syntax' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(cfg, 'a'.repeat(64), { fresh_pair: { repeatable: true } }));
    await waitFor(() => expect(vi.mocked(api.providerOptionIssues).mock.calls.length).toBeGreaterThan(issueCalls));
    confirm.mockRestore();
  });

  it('shows stale confirmations with the help difference and re-pins only still-unknown facts', async () => {
    const items = { ...fresh, key: 'fresh_items', spellings: [{ flag: '--fresh-items' }], arity: { value: null, certainty: 'unknown' as const } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [fresh, items], {
      supplement: {
        fingerprint: 'c'.repeat(64), current: false, applied: [],
        options: { fresh_pair: { arity: { min: 1, max: 1 }, repeatable: true }, fresh_items: { arity: { min: 1, max: null } } },
        conflicts: [{ key: 'fresh_pair', field: 'arity', confirmed: { min: 1, max: 1 }, help: { min: 2, max: 2 } }],
      },
    }));
    const confirm = vi.spyOn(api, 'runtimeHelpConfirmSyntax').mockImplementation(async () => effectiveSchema([], [fresh, items]));
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={config} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(/Confirmed for an earlier help/)).toBeVisible();
    expect(screen.getByText(/Differs from the current help \(arity: \{"min":2,"max":2\}\)/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm again for this help (fresh_pair, fresh_items)' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(config, 'a'.repeat(64), {
      fresh_pair: { repeatable: true }, fresh_items: { arity: { min: 1, max: null } },
    }));
    confirm.mockRestore();
  });

  it('offers an explicit discard for an unreadable confirmation file', async () => {
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [fresh], { supplement_error: 'confirmed option syntax version 2 is not supported by this app' }));
    const clear = vi.spyOn(api, 'runtimeHelpClearConfirmedSyntax').mockResolvedValue(effectiveSchema([], [fresh]));
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={config} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    expect(await screen.findByText(/version 2 is not supported/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Discard all confirmations' }));
    await waitFor(() => expect(clear).toHaveBeenCalledWith(config));
    clear.mockRestore();
  });

  it('keeps the saved order record out of unknown values and reorders it from settings', async () => {
    const items = { ...fresh, key: 'fresh_tag', spellings: [{ flag: '--fresh-tag' }], arity: { value: { min: 1, max: 1 }, certainty: 'verified' as const, source: { kind: 'help', document: 'stdout', start_line: 1, end_line: 1 } } };
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [fresh, items]));
    const saved = { fresh_pair: { spelling: null, occurrences: [['a', 'b']] }, fresh_tag: 'x' };
    const onChange = vi.fn();
    const onInvalid = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': saved } }} disabled={false} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>);
    fireEvent.click(await screen.findByRole('button', { name: 'Move up: --fresh-tag "x"' }));
    expect(onChange).toHaveBeenLastCalledWith({ provider_options: { 'custom.synthetic': { ...saved,
      '@option_order': { version: 1, occurrences: [{ key: 'fresh_tag' }, { key: 'fresh_pair' }] } } } });
    await waitFor(() => expect(onInvalid).toHaveBeenLastCalledWith('provider-options', false));
  });

  it('keeps saved help values when the runtime changed and says why launch is blocked', async () => {
    vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema([], [], {
      help_state: 'stale', help_detail: 'the runtime, its declared artifacts or its help command changed since its options were reviewed',
      accepted_fingerprint: 'b'.repeat(64),
    }));
    const onInvalid = vi.fn();
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...config, provider_options: { 'custom.synthetic': { fresh_pair: { spelling: null, occurrences: [['a', 'b']] } } } }} disabled={false} onChange={vi.fn()} onInvalid={onInvalid} /></I18nProvider>);
    expect(await screen.findByText(/changed since its options were reviewed/)).toBeVisible();
    expect(screen.getByText('fresh_pair')).toBeVisible();
    await waitFor(() => expect(onInvalid).toHaveBeenCalledWith('provider-options', true));
  });
});
