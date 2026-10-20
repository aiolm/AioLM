import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore } from '../../testing/appStore';
import { effectiveSchema } from '../../testing/effectiveSchema';
import RuntimeOptionSchemaForm from '../runtimes/RuntimeOptionSchemaForm';
import { ProviderOptions } from './ProviderControls';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerRuntimeOptions: vi.fn(),
  providerOptionSchema: vi.fn(), providerOptionIssues: vi.fn(), runtimeHelpTarget: vi.fn(),
}));

// Representative native schema shape: supported sampling request rows remain,
// while an installation need not expose a reasoning launch flag. This does not
// claim that a built-in engine has no request options or that one is installed.
const options: api.ProviderOption[] = [
  { key: 'max_model_len', flag: '--max-model-len', target: 'launch', group: 'context', kind: { type: 'integer' } },
  { key: 'temperature', target: 'request', group: 'sampling', kind: { type: 'number' } },
];
const noCategory = 'This runtime exposes no options in this category.';
const noMatch = 'No options match this search.';

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'synthetic', availability: { supported: true, detail: '' }, options }]);
  vi.mocked(api.providerRuntimes).mockResolvedValue([{ id: 'synthetic', provider: 'vllm', engine: 'vllm', server: 'synthetic', accelerator: 'synthetic', installation: 'external', location: 'synthetic-runtime', available: true, problems: [], server_flags: ['--max-model-len'] }]);
  vi.mocked(api.providerRuntimeOptions).mockResolvedValue(options);
  vi.mocked(api.providerOptionSchema).mockResolvedValue(effectiveSchema(options));
  vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
  vi.mocked(api.runtimeHelpTarget).mockReturnValue(new Promise(() => undefined));
});
afterEach(cleanup);

function mounted() {
  const cfg = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { max_model_len: 8192, temperature: 0.2 } } }).cfg!;
  const before = structuredClone(cfg);
  const onChange = vi.fn(); const onChecking = vi.fn();
  const view = (section: string) => <I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} section={section} disabled={false} onChange={onChange} onInvalid={vi.fn()} onChecking={onChecking} /></I18nProvider>;
  return { cfg, before, onChange, onChecking, view };
}

describe('provider option empty categories', () => {
  it('shows one category message for a checked empty category without blaming an empty search', async () => {
    const state = mounted();
    render(state.view('reasoning'));
    await waitFor(() => expect(state.onChecking).toHaveBeenLastCalledWith(false));
    expect(screen.getByRole('searchbox', { name: 'Search options' })).toHaveValue('');
    expect(screen.getAllByText(noCategory)).toHaveLength(1);
    expect.soft(screen.queryByText(noMatch)).not.toBeInTheDocument();
    expect(state.cfg).toEqual(state.before);
    expect(state.onChange).not.toHaveBeenCalled();
  });

  it('retains a real search and saved values across an empty category, then restores matching fields', async () => {
    const state = mounted();
    const rendered = render(state.view('sampling'));
    await screen.findByLabelText(/^temperature/);
    await waitFor(() => expect(state.onChecking).toHaveBeenLastCalledWith(false));
    fireEvent.click(screen.getByRole('combobox', { name: 'Group' }));
    fireEvent.click(await screen.findByRole('option', { name: 'sampling' }));
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveTextContent('sampling');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: 'no-such-option' } });
    expect(await screen.findByText(noMatch)).toBeVisible();
    expect(screen.queryByText(noCategory)).not.toBeInTheDocument();
    rendered.rerender(state.view('reasoning'));
    expect(screen.getByRole('searchbox', { name: 'Search options' })).toHaveValue('no-such-option');
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveTextContent('sampling');
    expect(screen.getByText(noCategory)).toBeVisible();
    expect.soft(screen.queryByText(noMatch)).not.toBeInTheDocument();
    rendered.rerender(state.view('sampling'));
    expect(screen.getByRole('searchbox', { name: 'Search options' })).toHaveValue('no-such-option');
    expect(screen.getByRole('combobox', { name: 'Group' })).toHaveTextContent('sampling');
    expect(screen.getByText(noMatch)).toBeVisible();
    expect(screen.queryByText(noCategory)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: '' } });
    expect(await screen.findByLabelText(/^temperature/)).toHaveValue('0.2');
    expect(screen.queryByText(noMatch)).not.toBeInTheDocument();
    expect(state.cfg).toEqual(state.before);
    expect(state.onChange).not.toHaveBeenCalled();
  });

  it('keeps the standalone schema form search feedback and option data intact', async () => {
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={effectiveSchema(options).schema} values={{ temperature: 0.2 }} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: 'no-such-option' } });
    expect(await screen.findByText(noMatch)).toBeVisible();
    expect(screen.queryByText(noCategory)).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: 'temperature' } });
    expect(await screen.findByLabelText(/^temperature/)).toHaveValue('0.2');
    expect(onChange).not.toHaveBeenCalled();
  });
});
