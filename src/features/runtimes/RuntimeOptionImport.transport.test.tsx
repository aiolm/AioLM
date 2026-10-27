import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import { createTestStore } from '../../testing/appStore';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import { ProviderOptions } from '../model-settings/ProviderControls';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';
import { ORDER_KEY } from './optionOrder';

vi.mock('../../shared/api/runtimeHelp', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/runtimeHelp')>(),
  runtimeHelpImport: vi.fn(), runtimeHelpResolve: vi.fn(),
}));
vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerRuntimeOptions: vi.fn(),
  providerOptionSchema: vi.fn(), providerOptionIssues: vi.fn(), runtimeHelpTarget: vi.fn(),
}));

const options: api.ProviderOption[] = [
  { key: 'count', flag: '--count', target: 'launch', group: 'other', kind: { type: 'integer' } },
  { key: 'label', flag: '--label', target: 'launch', group: 'other', kind: { type: 'text' } },
];
const view = effectiveSchema(options);
// These decimal digits are the native JSON payload, never an already-rounded
// numeric literal in this test. JS transport has lost the final digit by here.
const transported = (decimal: string): api.ImportedPlan => JSON.parse(
  `{"plan":[{"key":"count","spelling":"--count","values":[${decimal}]}],"managed":[],"unrecognized":[]}`,
) as api.ImportedPlan;
const sourceValues = () => ({
  count: { spelling: null, occurrences: [[7], [8]] },
  label: 'kept', retained_unknown: { nested: ['original'] },
  [ORDER_KEY]: { version: 1, occurrences: [{ key: 'count' }, { key: 'label' }, { key: 'count' }] },
});

beforeEach(() => {
  localStorage.clear(); vi.clearAllMocks();
  vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv: [], request: {} });
  vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'vllm', engine: 'vllm', server: 'synthetic', availability: { supported: true, detail: '' }, options }]);
  vi.mocked(api.providerRuntimes).mockResolvedValue([]);
  vi.mocked(api.providerRuntimeOptions).mockResolvedValue(options);
  vi.mocked(api.providerOptionSchema).mockResolvedValue(view);
  vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
  vi.mocked(api.runtimeHelpTarget).mockReturnValue(new Promise(() => undefined));
});
afterEach(cleanup);

describe('imported integer values at the JavaScript transport boundary', () => {
  it.each([
    ['en', 'This integer may have changed. Review the original pasted command before applying.'],
    ['ko', '이 정수 값이 원래와 다를 수 있습니다. 적용하기 전에 원래 붙여넣은 명령을 검토하세요.'],
    ['ja', 'この整数の値が元と異なる可能性があります。適用する前に、貼り付けた元のコマンドを確認してください。'],
    ['zh', '此整数的值可能已发生变化。应用前请检查最初粘贴的命令。'],
  ] as const)('retains paste, review and saved values on refusal in %s, then accepts a safe import', async (locale, message) => {
    const saved = sourceValues();
    const before = structuredClone(saved);
    const onChange = vi.fn();
    const copy = runtimeOptionsCopy[locale];
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(transported('9007199254740993'));
    render(<I18nProvider initialLocale={locale}><RuntimeOptionSchemaForm schema={view.schema} scope={[]} values={saved} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByText(copy.importTitle));
    const text = '--count 9007199254740993';
    const input = screen.getByRole('textbox', { name: copy.importLabel });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: copy.split }));
    await screen.findByText(`${copy.planOrder}: count`);
    fireEvent.click(screen.getByRole('button', { name: copy.apply }));
    expect.soft(onChange).not.toHaveBeenCalled();
    expect.soft(screen.queryByText(message)).toBeInTheDocument();
    expect(input).toHaveValue(text);
    expect(screen.getByText(`${copy.planOrder}: count`)).toBeInTheDocument();
    expect(saved).toEqual(before);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValueOnce(transported('9007199254740991'));
    fireEvent.change(input, { target: { value: '--count 9007199254740991' } });
    fireEvent.click(screen.getByRole('button', { name: copy.split }));
    await waitFor(() => expect(runtimeHelp.runtimeHelpImport).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: copy.apply }));
    expect(onChange).toHaveBeenLastCalledWith({
      count: 9007199254740991, label: 'kept', retained_unknown: { nested: ['original'] },
      [ORDER_KEY]: { version: 1, occurrences: [{ key: 'label' }, { key: 'count' }] },
    });
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it('applies the manual Integer safety boundary to provider command import without changing the paste', async () => {
    const cfg = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { count: 7, label: 'kept' } } }).cfg!;
    const before = structuredClone(cfg);
    const onChange = vi.fn();
    const onChecking = vi.fn();
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(transported('9007199254740993'));
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={onChange} onInvalid={vi.fn()} onChecking={onChecking} /></I18nProvider>);
    await waitFor(() => expect(onChecking).toHaveBeenLastCalledWith(false));
    const field = screen.getByLabelText(/^--count/);
    fireEvent.change(field, { target: { value: '9007199254740993' } });
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(onChange).not.toHaveBeenCalled();
    const text = '--count 9007199254740993';
    const input = screen.getByRole('textbox', { name: 'Import command' });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    await waitFor(() => expect(runtimeHelp.runtimeHelpImport).toHaveBeenCalledWith(view.schema, [], text, 'posix', undefined));
    // Wait for the actual import callback rather than checking before it resolves.
    expect(await screen.findByText('This integer may have changed. Review the original pasted command before applying.')).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    expect(input).toHaveValue(text);
    expect(cfg).toEqual(before);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValueOnce(transported('9007199254740991'));
    fireEvent.change(input, { target: { value: '--count 9007199254740991' } });
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ provider_options: { vllm: {
      count: 9007199254740991, label: 'kept',
      [ORDER_KEY]: { version: 1, occurrences: [{ key: 'label' }, { key: 'count' }] },
    } } }));
  });
});

describe('typed sensitive positional import review', () => {
  const payload = schemaOption({ key: 'payload', target: 'launch', group: 'other', kind: { type: 'json' } });
  payload.position = 0;
  payload.sensitive = { value: true, certainty: 'verified' };
  const current = effectiveSchema([], [payload, schemaOption(options[1])]);
  const raw = '{"token": "synthetic-private-positional", "n":9007199254740993}';
  const paste = `'${raw}' --label public`;
  const refused = () => ({ plan: [{ key: 'label', spelling: '--label', values: ['public'] }], managed: [], unrecognized: [raw] });

  it('keeps the full form raw paste and safe imported option while masking a refused Json positional review', async () => {
    const saved = { label: 'kept' };
    const onChange = vi.fn();
    const imported = refused();
    const before = structuredClone(imported);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(imported);
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current.schema} scope={[]} values={saved} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByText('Import a pasted command line'));
    const input = screen.getByRole('textbox', { name: /Pasted command/ });
    fireEvent.change(input, { target: { value: paste } });
    fireEvent.click(screen.getByRole('button', { name: 'Read options from command' }));
    const review = await screen.findByText(/Unrecognized, kept for review/, { selector: '.app-feedback-message' });
    expect.soft(review).not.toHaveTextContent('synthetic-private-positional');
    expect.soft(review).toHaveTextContent('•••');
    expect(input).toHaveValue(paste);
    fireEvent.click(screen.getByRole('button', { name: 'Apply these options' }));
    expect(onChange).toHaveBeenCalledWith({ label: 'public' });
    expect(imported).toEqual(before);
    expect(saved).toEqual({ label: 'kept' });
  });

  it('masks the ProviderOptions refused positional review while retaining original paste and safe sibling options', async () => {
    const cfg = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { label: 'kept' } } }).cfg!;
    const before = structuredClone(cfg);
    const onChange = vi.fn();
    vi.mocked(api.providerOptionSchema).mockResolvedValue(current);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(refused());
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--label/);
    const input = screen.getByRole('textbox', { name: 'Import command' });
    fireEvent.change(input, { target: { value: paste } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ provider_options: { vllm: { label: 'public' } } }));
    const review = screen.getByText(/synthetic-private-positional|•••/, { selector: '.app-feedback-message' });
    expect.soft(review).not.toHaveTextContent('synthetic-private-positional');
    expect.soft(review).toHaveTextContent('•••');
    expect(input).toHaveValue(paste);
    expect(cfg).toEqual(before);
  });

  it('masks a registered entry managed positional review without changing the paste or applying its value', async () => {
    const managed = effectiveSchema([], [{ ...payload, managed: 'discovery' }, schemaOption(options[1])], {
      entry: { version: 1, program: 'synthetic-engine', prefix: [], positional_bindings: [] },
    });
    // Native import_plan_for_entry sends an unmapped/template managed slot's
    // bare token to managed before typed parsing, without adding a plan row.
    const imported = { plan: [{ key: 'label', spelling: '--label', values: ['public'] }], managed: [raw], unrecognized: [] };
    const cfg = createTestStore({ active_provider: 'vllm', active_runtime: 'synthetic', provider_options: { vllm: { label: 'kept' } } }).cfg!;
    const before = structuredClone({ cfg, imported });
    const onChange = vi.fn();
    vi.mocked(api.providerOptionSchema).mockResolvedValue(managed);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValue(imported);
    render(<I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByLabelText(/^--label/);
    const input = screen.getByRole('textbox', { name: 'Import command' });
    fireEvent.change(input, { target: { value: paste } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith({ provider_options: { vllm: { label: 'public' } } }));
    expect(runtimeHelp.runtimeHelpImport).toHaveBeenCalledWith(managed.schema, [], paste, 'posix', managed.entry);
    const review = screen.getByText(/synthetic-private-positional|•••/, { selector: '.app-feedback-message' });
    expect.soft(review).not.toHaveTextContent('synthetic-private-positional');
    expect.soft(review).toHaveTextContent('•••');
    expect(input).toHaveValue(paste);
    expect({ cfg, imported }).toEqual(before);
  });
});

describe('native typed scalar preview display', () => {
  it.each([
    { kind: 'number' as const, value: 1e-6, native: '1e-6', visible: '1e-6' },
    { kind: 'json' as const, value: 'synthetic-native-preview', native: '"synthetic-native-preview"', visible: 'synthetic-native-preview' },
  ])('masks the real form $kind preview despite native scalar formatting', async ({ kind, value, native, visible }) => {
    const option = schemaOption({ key: 'payload', flag: '--payload', target: 'launch', group: 'other', kind: { type: kind } });
    option.sensitive = { value: true, certainty: 'verified' };
    const current = effectiveSchema([], [option]);
    const values = { payload: value };
    const argv = ['--payload', native];
    const before = structuredClone({ values, argv });
    const onChange = vi.fn();
    // Native Number::to_string / Json serde_json::to_string fixtures. Actual
    // webview/native execution is owned by root; this exercises the real UI.
    vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv, request: {} });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current.schema} scope={[]} values={values} onChange={onChange} /></I18nProvider>);
    const preview = await screen.findByText(/--payload/, { selector: 'pre' });
    expect.soft(preview).not.toHaveTextContent(visible);
    expect.soft(preview).toHaveTextContent('•••');
    expect({ values, argv }).toEqual(before);
    expect(onChange).not.toHaveBeenCalled();
  });
});
