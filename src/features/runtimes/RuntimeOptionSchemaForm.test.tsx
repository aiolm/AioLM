import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import RuntimeOptionSchemaForm, { maskImportReview, maskPreview } from './RuntimeOptionSchemaForm';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import type { OptionSchema } from '../../shared/api/runtimeHelp';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';

vi.mock('../../shared/api/runtimeHelp', async origin => {
  const actual = await origin<typeof import('../../shared/api/runtimeHelp')>();
  return { ...actual, runtimeHelpResolve: vi.fn(), runtimeHelpImport: vi.fn() };
});

const schema = (options: OptionSchema['options']): OptionSchema => ({
  schema_version: 1,
  binding: { engine: 'custom.example', runtime: 'build-a', fingerprint: 'a'.repeat(64) },
  options,
  constraints: [],
  raw_help: [],
  end_of_options: { value: null, certainty: 'unknown' },
});

const textOption = (key: string, extra: Partial<OptionSchema['options'][number]> = {}) => ({
  key,
  scope: [],
  spellings: [{ flag: `--${key}` }],
  position: null,
  kind: { value: null, certainty: 'unknown' as const },
  arity: { value: { min: 1, max: 1 }, certainty: 'verified' as const, source: { kind: 'adapter', id: 't', revision: 'r' } },
  repeatable: { value: null, certainty: 'unknown' as const },
  choices: { value: null, certainty: 'unknown' as const },
  range: { value: null, certainty: 'unknown' as const },
  unit: { value: null, certainty: 'unknown' as const },
  runtime_default: { value: null, certainty: 'unknown' as const },
  group: 'runtime',
  help: `${key} help`,
  target: 'launch' as const,
  request_field: { value: null, certainty: 'unknown' as const },
  restart_required: { value: null, certainty: 'unknown' as const },
  sensitive: { value: null, certainty: 'unknown' as const },
  local_path: { value: null, certainty: 'unknown' as const },
  managed: null,
  raw_spans: [],
  ...extra,
});

beforeEach(() => {
  vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValue({ argv: [], request: {} });
});

describe('generic runtime option renderer', () => {
  it('renders flags with labels, help and runtime defaults without guessing', async () => {
    const current = schema([textOption('threads'), textOption('label')]);
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{}} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(screen.getByText('--threads', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('--label', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalled());
    const header = screen.getByText('--threads', { exact: true }).parentElement!;
    expect(header).toHaveTextContent('Engine default not confirmed.');
    expect(header).not.toHaveTextContent('Runtime default: Runtime default');
    fireEvent.change(screen.getByLabelText(/^--threads/), { target: { value: '7' } });
    expect(onChange).toHaveBeenLastCalledWith({ threads: '7' });
    expect(current.options[0].kind.certainty).toBe('unknown');
  });

  it('links native validation to the rejected value and clears it when the value is accepted', async () => {
    const message = 'value is outside the documented numeric range';
    const current = schema([textOption('threads'), textOption('workers')]);
    vi.mocked(runtimeHelp.runtimeHelpResolve).mockRejectedValueOnce([{ key: 'threads', message }]);
    const view = render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{ threads: '0' }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    await screen.findByText(message);
    expect(screen.getByLabelText(/^--threads/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^--threads/)).toHaveAccessibleDescription(`threads help ${message}`);
    expect(screen.getByLabelText(/^--workers/)).not.toHaveAttribute('aria-invalid');
    view.rerender(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{ threads: '3' }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^--threads/)).not.toHaveAttribute('aria-invalid');
    expect(screen.getByLabelText(/^--threads/)).toHaveAccessibleDescription('threads help');
  });

  it.each([
    ['en', 'numeric range'], ['ko', '숫자 범위'], ['ja', '数値範囲'], ['zh', '数值范围'],
  ] as const)('shows the documented bounds with the field and its native error in %s', async (locale, label) => {
    const message = 'value is outside the documented numeric range';
    const threads = textOption('threads', { kind: known('integer'), range: known({ min: 1, max: 32 }) });
    render(<I18nProvider initialLocale={locale}><p id="range-error">{message}</p>
      <RuntimeOptionSchemaForm compact schema={schema([threads, textOption('label')])} values={{ threads: 0 }} scope={[]}
        validationDescriptions={new Map([['threads', 'range-error']])} onChange={() => undefined} />
    </I18nProvider>);
    expect(screen.getByText(`${label}: 1–32`)).toBeVisible();
    expect(screen.getByLabelText(/^--threads/)).toHaveAccessibleDescription(`threads help ${label}: 1–32 ${message}`);
    expect(screen.getByLabelText(/^--threads/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^--label/)).toHaveAccessibleDescription('label help');
    await waitFor(() => expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalled());
  });

  it('shows a documented zero boundary without inventing an unknown or absent bound', async () => {
    const lower = textOption('lower', { kind: known('number'), range: known({ min: 0 }) });
    const upper = textOption('upper', { kind: known('number'), range: known({ max: 0 }) });
    const unknown = textOption('unknown', { range: { value: { min: 1, max: 32 }, certainty: 'unknown' } });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([lower, upper, unknown])}
      values={{}} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(screen.getByText('numeric range: ≥ 0')).toBeVisible();
    expect(screen.getByText('numeric range: ≤ 0')).toBeVisible();
    expect(screen.getByLabelText(/^--lower/)).toHaveAccessibleDescription('lower help numeric range: ≥ 0');
    expect(screen.getByLabelText(/^--upper/)).toHaveAccessibleDescription('upper help numeric range: ≤ 0');
    expect(screen.getByLabelText(/^--unknown/)).toHaveAccessibleDescription('unknown help');
    expect(screen.queryByText('numeric range: 1–32')).not.toBeInTheDocument();
    await waitFor(() => expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalled());
  });

  it('does not disclose a sensitive option through its numeric bounds', async () => {
    const pin = textOption('pin', {
      kind: known('integer'), sensitive: known(true), range: known({ min: 1234, max: 1234 }),
      runtime_default: known({ literal: 1234 }),
    });
    const view = render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([pin])}
      values={{}} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(screen.getByLabelText(/^--pin/)).toHaveAttribute('type', 'password');
    expect(view.container).not.toHaveTextContent('1234');
    expect(screen.getByLabelText(/^--pin/)).toHaveAccessibleDescription('pin help');
    await waitFor(() => expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalled());
  });

  it('marks each rejected tuple value without clearing its own parse error when native issues clear', () => {
    const pair = textOption('pair', { kind: known('integer'), arity: known({ min: 2, max: 2 }), range: known({ min: 0, max: 4 }) });
    const current = schema([pair, textOption('label')]);
    const values = { pair: { occurrences: [[1, 2]] } };
    const descriptions = new Map([['pair', 'native-range native-rule']]);
    const renderForm = (native: boolean) => <I18nProvider initialLocale="en">
      <p id="native-range">Outside range</p><p id="native-rule">Must be different</p>
      <RuntimeOptionSchemaForm compact schema={current} values={values} scope={[]} onChange={() => undefined}
        validationDescriptions={native ? descriptions : undefined} />
    </I18nProvider>;
    const view = render(renderForm(true));
    const first = screen.getByLabelText('--pair Occurrence 1 Value 1');
    const second = screen.getByLabelText('--pair Occurrence 1 Value 2');
    for (const value of [first, second]) {
      expect(value).toHaveAttribute('aria-invalid', 'true');
      expect(value).toHaveAccessibleDescription('pair help numeric range: 0–4 Outside range Must be different');
    }
    expect(screen.getByLabelText(/^--label/)).not.toHaveAttribute('aria-invalid');
    fireEvent.change(first, { target: { value: 'unfinished-number' } });
    view.rerender(renderForm(false));
    expect(first).toHaveAttribute('aria-invalid', 'true');
    expect(first).not.toHaveAccessibleDescription(expect.stringContaining('Outside range'));
    expect(second).not.toHaveAttribute('aria-invalid');
    expect(second).toHaveAccessibleDescription('pair help numeric range: 0–4');
  });

  it('connects host validation messages to choice and switch comboboxes', () => {
    const mode = textOption('mode', { choices: known(['fast', 'exact']) });
    const enabled = textOption('enabled', { kind: known('boolean'), arity: known({ min: 0, max: 0 }) });
    render(<I18nProvider initialLocale="en"><p id="native-rule">Values conflict</p>
      <RuntimeOptionSchemaForm compact schema={schema([mode, enabled])} values={{ mode: 'fast', enabled: true }} scope={[]}
        validationDescriptions={new Map([['mode', 'native-rule'], ['enabled', 'native-rule']])} onChange={() => undefined} />
    </I18nProvider>);
    for (const flag of ['--mode', '--enabled']) {
      const input = screen.getByRole('combobox', { name: flag });
      expect(input).toHaveAttribute('aria-invalid', 'true');
      expect(input).toHaveAccessibleDescription(expect.stringContaining('Values conflict'));
    }
  });

  it('masks sensitive values in the argv preview', async () => {
    const current = schema([
      textOption('token', { sensitive: { value: true, certainty: 'verified', source: { kind: 'adapter', id: 't', revision: 'r' } } }),
    ]);
    vi.mocked(runtimeHelp.runtimeHelpResolve).mockResolvedValueOnce({ argv: ['--token', 'secret-value'], request: {} });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{ token: 'secret-value' }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(await screen.findByText(/Launch preview/)).toBeInTheDocument();
    expect(await screen.findByText(/•••/)).toBeInTheDocument();
    expect(screen.queryByText(/secret-value/)).not.toBeInTheDocument();
  });

  it('keeps unknown saved values with a removal action instead of dropping them', async () => {
    const current = schema([textOption('threads')]);
    const onChange = vi.fn();
    vi.mocked(runtimeHelp.runtimeHelpResolve).mockRejectedValueOnce([{ key: 'removed', message: 'saved option is absent from this schema' }]);
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{ removed: 'original' }} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(await screen.findByText(/absent from this schema/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onChange).toHaveBeenCalledWith({});
  });

  it('filters a large option list through search without engine branches', async () => {
    const current = schema([textOption('alpha'), textOption('beta'), textOption('gamma')]);
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{}} scope={[]} onChange={() => undefined} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Search options'), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('--alpha', { exact: false })).not.toBeInTheDocument());
    expect(screen.getByText('--beta', { exact: false })).toBeInTheDocument();
  });

  it('splits a pasted command into an ordered plan with review buckets', async () => {
    const current = schema([textOption('alpha'), textOption('beta')]);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValueOnce({
      plan: [
        { key: 'alpha', spelling: '--alpha', values: ['1'] },
        { key: 'beta', spelling: '--beta', values: ['2'] },
        { key: 'alpha', spelling: '--alpha', values: ['3'] },
      ],
      managed: ['--port 8080'],
      unrecognized: ['--mystery 1'],
    });
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{}} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(/Pasted command/), { target: { value: '--alpha 1 --beta 2 --alpha 3' } });
    fireEvent.click(screen.getByRole('button', { name: "Read options from command" }));
    expect(await screen.findByText(/Imported option order: alpha, beta, alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Managed by the app/)).toBeInTheDocument();
    expect(screen.getByText(/Unrecognized/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: "Apply these options" }));
    // Grouped values alone would launch A1 A3 B2; the saved order keeps A1 B2 A3.
    expect(onChange).toHaveBeenCalledWith({
      alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2',
      '@option_order': { version: 1, occurrences: [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha' }] },
    });
  });
});
const known = <T,>(value: T) => ({ value, certainty: 'documented' as const, source: { kind: 'adapter', id: 't', revision: 'r' } });

describe('JSON option numeric limits', () => {
  it('renders saved JSON strings with quotes so their type survives an edit', () => {
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([textOption('payload', { kind: known('json') })])}
      values={{ payload: '9007199254740993' }} scope={[]} onChange={vi.fn()} /></I18nProvider>);
    expect(screen.getByLabelText(/^--payload/)).toHaveValue('"9007199254740993"');
  });

  it.each(['en', 'ko', 'ja', 'zh'] as const)('keeps the rejected draft and last saved value, with an accessible error in %s', locale => {
    const onChange = vi.fn();
    const onInvalid = vi.fn();
    const values = { payload: { seed: 17 } };
    render(<I18nProvider initialLocale={locale}><RuntimeOptionSchemaForm schema={schema([textOption('payload', { kind: known('json') })])}
      values={values} scope={[]} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>);
    const field = screen.getByLabelText(/^--payload/);
    const draft = '{"nested":[{"seed":9007199254740993}]}';
    fireEvent.change(field, { target: { value: draft } });
    expect(field).toHaveValue(draft);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription(expect.stringContaining(runtimeOptionsCopy[locale].jsonNumberRange));
    expect(screen.getByRole('alert')).not.toHaveTextContent(draft);
    expect(onChange).not.toHaveBeenCalled();
    expect(onInvalid).toHaveBeenLastCalledWith('schema:payload', true);
    expect(values).toEqual({ payload: { seed: 17 } });
    fireEvent.change(field, { target: { value: '{"seed":9007199254740991,"ratio":0.5,"label":"9007199254740993"}' } });
    expect(onChange).toHaveBeenLastCalledWith({ payload: { seed: 9007199254740991, ratio: 0.5, label: '9007199254740993' } });
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onInvalid).toHaveBeenLastCalledWith('schema:payload', false);
  });
});

describe('editing keeps every saved occurrence, alias and explicit value', () => {
  it('bounds the initial controls for a large installed help and can find its last option without dropping saved values', async () => {
    const onChange = vi.fn();
    const options = Array.from({ length: 1000 }, (_, index) => textOption(`bulk-${index}`));
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema(options)} values={{ 'bulk-0': 'kept' }} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(screen.getAllByRole('textbox')).toHaveLength(64);
    expect(screen.getByRole('button', { name: 'Show more options (936)' })).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search options' }), { target: { value: '--bulk-999' } });
    const last = await screen.findByLabelText(/^--bulk-999/);
    fireEvent.change(last, { target: { value: '한글 value' } });
    expect(onChange).toHaveBeenLastCalledWith({ 'bulk-0': 'kept', 'bulk-999': '한글 value' });
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });
  it('edits one value of a repeated fixed tuple without dropping other rows or the alias', () => {
    const pair = textOption('pair', {
      spellings: [{ flag: '--pair' }, { flag: '-P' }],
      arity: known({ min: 2, max: 2 }),
      repeatable: known(true),
    });
    const onChange = vi.fn();
    const stored = { spelling: '-P', occurrences: [['a b', '한글'], ['x', 'y']] };
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([pair])} values={{ pair: stored }} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('--pair Occurrence 2 Value 1'), { target: { value: 'changed' } });
    expect(onChange).toHaveBeenLastCalledWith({ pair: { spelling: '-P', occurrences: [['a b', '한글'], ['changed', 'y']] } });
    fireEvent.click(screen.getByRole('button', { name: 'Add occurrence' }));
    expect(onChange).toHaveBeenLastCalledWith({ pair: { spelling: '-P', occurrences: [['a b', '한글'], ['x', 'y'], ['', '']] } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove occurrence' })[0]);
    expect(onChange).toHaveBeenLastCalledWith({ pair: { spelling: '-P', occurrences: [['x', 'y']] } });
  });

  it('keeps an explicit empty string distinct from the runtime default', () => {
    const onChange = vi.fn();
    const label = textOption('label');
    const view = render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([label])} values={{}} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Pass an empty value' }));
    expect(onChange).toHaveBeenLastCalledWith({ label: '' });
    view.rerender(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([label])} values={{ label: '' }} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(screen.getByText('An explicit empty string is passed.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Use runtime default' }));
    expect(onChange).toHaveBeenLastCalledWith({});
  });

  it('keeps zero as a value and documented choices in their JSON type', () => {
    const onChange = vi.fn();
    const count = textOption('count', { kind: known('integer') });
    const level = textOption('level', { choices: known([0, 1, 2]) });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([count, level])} values={{}} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(/^--count/), { target: { value: '0' } });
    expect(onChange).toHaveBeenLastCalledWith({ count: 0 });
    fireEvent.click(screen.getByRole('combobox', { name: '--level' }));
    fireEvent.click(screen.getByRole('option', { name: '0' }));
    expect(onChange).toHaveBeenLastCalledWith({ level: 0 });
  });

  it('offers false only where the runtime documents it and never edits managed bindings', () => {
    const onChange = vi.fn();
    const plain = textOption('plain', { kind: known('boolean'), arity: known({ min: 0, max: 0 }) });
    const toggle = textOption('toggle', {
      kind: known('boolean'), arity: known({ min: 0, max: 0 }),
      spellings: [{ flag: '--toggle', polarity: true }, { flag: '--no-toggle', polarity: false }],
    });
    const port = textOption('port', { managed: 'port' });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([plain, toggle, port])} values={{}} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getByRole('combobox', { name: '--plain' }));
    expect(screen.queryByRole('option', { name: 'false' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('combobox', { name: '--toggle' }));
    fireEvent.click(screen.getByRole('option', { name: 'false' }));
    expect(onChange).toHaveBeenLastCalledWith({ toggle: false });
    expect(screen.getByText(/Managed by the app/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^--port/)).not.toBeInTheDocument();
  });

  it('hides sensitive values until revealed', () => {
    const token = textOption('token', { sensitive: known(true) });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([token])} values={{ token: 'synthetic-secret' }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(screen.getByLabelText(/^--token/)).toHaveAttribute('type', 'password');
    fireEvent.click(screen.getByRole('button', { name: 'Show value' }));
    expect(screen.getByLabelText(/^--token/)).toHaveAttribute('type', 'text');
  });

  it('says why an entry-point or adapter-owned option is locked', () => {
    const engine = textOption('engine', { managed: 'entry_point' });
    const lazy = textOption('lazy', { managed: 'reserved' });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([engine, lazy])} values={{ engine: 'mock', lazy: true }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(screen.getByText(/Fixed by the registered entry point/)).toBeVisible();
    expect(screen.getByText(/This option is controlled by AioLM through the engine adapter/)).toBeVisible();
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('never shows the documented default of a secret option', () => {
    const adapter = { kind: 'adapter', id: 'synthetic.adapter', revision: 'r1' };
    const amber = textOption('fresh_amber', {
      sensitive: { value: true, certainty: 'documented', source: adapter },
      runtime_default: { value: { literal: 'default-amber-synthetic' }, certainty: 'documented', source: adapter },
    });
    const plain = textOption('fresh_plain', { runtime_default: { value: { literal: 'visible-default' }, certainty: 'documented', source: adapter } });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([amber, plain])} values={{}} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(document.body).not.toHaveTextContent('default-amber-synthetic');
    expect(screen.getByText('--fresh_amber').parentElement!).toHaveTextContent('•••');
    expect(screen.getByText('--fresh_plain').parentElement!).toHaveTextContent('visible-default');
  });

  it('shows unit, restart and secrecy facts with the source that documents each one', () => {
    const adapter = { kind: 'adapter', id: 'synthetic.adapter', revision: 'r1' };
    const help = { kind: 'help', document: 'stdout', start_line: 3, end_line: 3 };
    const observed = { value: { min: 1, max: 1 }, certainty: 'verified' as const, source: help };
    const cache = textOption('fresh_cache', {
      kind: { value: 'integer', certainty: 'documented', source: adapter }, arity: observed,
      unit: { value: 'MiB', certainty: 'documented', source: adapter },
      restart_required: { value: true, certainty: 'documented', source: adapter },
    });
    const secret = textOption('fresh_secret', { arity: observed, sensitive: { value: true, certainty: 'documented', source: adapter } });
    const plain = textOption('fresh_plain', { arity: { value: null, certainty: 'unknown' } });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([cache, secret, plain])} values={{ fresh_secret: 'synthetic-secret-value' }} scope={[]} onChange={() => undefined} /></I18nProvider>);
    const cacheHeader = screen.getByText('--fresh_cache').parentElement!;
    expect(cacheHeader).toHaveTextContent('MiB');
    expect(cacheHeader).toHaveTextContent('restart required');
    expect(cacheHeader).toHaveTextContent('Documented by: reviewed help, adapter synthetic.adapter (r1)');
    const secretHeader = screen.getByText('--fresh_secret').parentElement!;
    expect(secretHeader).toHaveTextContent('secret value');
    expect(screen.getByLabelText(/^--fresh_secret/)).toHaveAttribute('type', 'password');
    expect(document.body).not.toHaveTextContent('synthetic-secret-value');
    // Unknown facts are marked as such, not attributed to any source.
    const plainHeader = screen.getByText('--fresh_plain').parentElement!;
    expect(plainHeader).toHaveTextContent('The number of values is unknown');
    expect(plainHeader).not.toHaveTextContent('Documented by');
  });
});

describe('saved command-line order and confirmed syntax in the form', () => {
  const alpha = () => textOption('alpha', { spellings: [{ flag: '--alpha' }, { flag: '-a' }], repeatable: known(true) });
  const ordered = {
    alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2',
    '@option_order': { version: 1, occurrences: [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha', spelling: '-a' }] },
  };

  it('reorders occurrences and gives one occurrence its own alias', () => {
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([alpha(), textOption('beta')])} values={ordered} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(screen.getAllByRole('listitem').map(item => item.querySelector('code')?.textContent)).toEqual(['--alpha "1"', '--beta "2"', '-a "3"']);
    fireEvent.click(screen.getByRole('button', { name: 'Move up: --beta "2"' }));
    expect(onChange).toHaveBeenLastCalledWith({
      alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2',
      '@option_order': { version: 1, occurrences: [{ key: 'beta' }, { key: 'alpha' }, { key: 'alpha', spelling: '-a' }] },
    });
    // An edge button stays focusable and does nothing.
    fireEvent.click(screen.getByRole('button', { name: 'Move up: --alpha "1"' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('combobox', { name: '--alpha Occurrence 2 Spelling' })).toHaveTextContent('-a');
    fireEvent.click(screen.getByRole('combobox', { name: '--alpha Occurrence 2 Spelling' }));
    fireEvent.click(screen.getByRole('option', { name: '--alpha' }));
    expect(onChange).toHaveBeenLastCalledWith({ alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2',
      '@option_order': { version: 1, occurrences: [{ key: 'alpha' }, { key: 'beta' }, { key: 'alpha' }] } });
  });

  it('keeps distinct occurrence aliases when editing only one saved value', () => {
    const pair = textOption('pair', {
      spellings: [{ flag: '--pair' }, { flag: '-P' }],
      arity: known({ min: 2, max: 2 }),
      repeatable: known(true),
    });
    const initial = {
      pair: { spelling: '-P', occurrences: [['first', '한글'], ['second', 'value']] },
      token: 'middle',
      '@option_order': { version: 1, occurrences: [{ key: 'pair', spelling: '-P' }, { key: 'token' }, { key: 'pair', spelling: '--pair' }] },
    };
    const onChange = vi.fn();
    function ControlledForm() {
      const [values, setValues] = useState<Record<string, unknown>>(initial);
      return <RuntimeOptionSchemaForm schema={schema([pair, textOption('token')])} values={values} scope={[]}
        onChange={next => { onChange(next); setValues(next); }} />;
    }

    render(<I18nProvider initialLocale="en"><ControlledForm /></I18nProvider>);
    expect(screen.getByRole('combobox', { name: '--pair Occurrence 1 Spelling' })).toHaveTextContent('-P');
    expect(screen.getByRole('combobox', { name: '--pair Occurrence 2 Spelling' })).toHaveTextContent('--pair');

    fireEvent.change(screen.getByLabelText('--pair Occurrence 2 Value 1'), { target: { value: 'edited' } });

    expect(onChange).toHaveBeenLastCalledWith({
      pair: { spelling: '-P', occurrences: [['first', '한글'], ['edited', 'value']] },
      token: 'middle',
      '@option_order': { version: 1, occurrences: [{ key: 'pair', spelling: '-P' }, { key: 'token' }, { key: 'pair' }] },
    });
    expect(screen.getByRole('combobox', { name: '--pair Occurrence 1 Spelling' })).toHaveTextContent('-P');
    expect(screen.getByRole('combobox', { name: '--pair Occurrence 2 Spelling' })).toHaveTextContent('--pair');
    expect(screen.getByLabelText('--pair Occurrence 1 Value 1')).toHaveValue('first');
    expect(screen.getByLabelText('--pair Occurrence 2 Value 1')).toHaveValue('edited');
  });

  it('removes an occurrence together with its saved position', () => {
    const onChange = vi.fn();
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([alpha(), textOption('beta')])} values={ordered} scope={[]} onChange={onChange} /></I18nProvider>);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove occurrence' })[0]);
    expect(onChange).toHaveBeenLastCalledWith({ alpha: { spelling: '-a', occurrences: [['3']] }, beta: '2',
      '@option_order': { version: 1, occurrences: [{ key: 'beta' }, { key: 'alpha', spelling: '-a' }] } });
  });

  it('shows a refused record with an explicit discard action and keeps the values', () => {
    const onChange = vi.fn();
    const future = { ...ordered, '@option_order': { version: 2, occurrences: [] } };
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={schema([alpha(), textOption('beta')])} values={future} scope={[]} onChange={onChange} /></I18nProvider>);
    expect(screen.getByText(/cannot read the saved option order/)).toBeInTheDocument();
    expect(screen.queryByText(/not an option of this runtime/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard saved order' }));
    expect(onChange).toHaveBeenLastCalledWith({ alpha: ordered.alpha, beta: '2' });
  });

  it('confirms an unknown value count only on explicit input for reviewed help options', () => {
    const onConfirm = vi.fn();
    const items = textOption('items', { arity: { value: null, certainty: 'unknown' } });
    const catalog = textOption('catalog');
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm compact schema={schema([items, catalog])} values={{ items: 'kept' }} scope={[]} onChange={() => undefined}
      confirmSyntaxFor={option => option.key === 'items'} onConfirmSyntax={onConfirm} /></I18nProvider>);
    expect(screen.getAllByText(/Confirm value syntax/)).toHaveLength(1);
    fireEvent.click(screen.getByText('Confirm value syntax (--items)'));
    fireEvent.change(screen.getByLabelText('Minimum values per occurrence'), { target: { value: '2' } });
    fireEvent.change(screen.getByLabelText('Maximum values per occurrence'), { target: { value: '1' } });
    expect(screen.getByRole('button', { name: 'Save confirmed syntax' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Maximum values per occurrence'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('combobox', { name: 'repeatable (--items)' }));
    fireEvent.click(screen.getByRole('option', { name: 'Can repeat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save confirmed syntax' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({ key: 'items' }), { arity: { min: 2, max: null }, repeatable: true });
  });
  it('masks sensitive words in import review buckets while keeping the pasted command available', async () => {
    const secret = 'synthetic-amber-6281';
    const current = schema([textOption('amber', { sensitive: { value: true, certainty: 'verified' }, managed: 'entry_point' })]);
    vi.mocked(runtimeHelp.runtimeHelpImport).mockResolvedValueOnce({ plan: [], managed: ['--amber', secret], unrecognized: [`--unknown=${secret}`] });
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{}} scope={[]} onChange={vi.fn()} /></I18nProvider>);
    fireEvent.click(screen.getByText('Import a pasted command line'));
    const text = `--amber ${secret} --unknown=${secret}`;
    const input = screen.getByRole('textbox', { name: /Pasted command/ });
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: "Read options from command" }));
    const review = await screen.findByText(/--amber/, { selector: '.app-feedback-message' });
    expect(review).not.toHaveTextContent(secret);
    expect(review).toHaveTextContent('•••');
    expect(screen.getByText(/--unknown=/, { selector: '.app-feedback-message' })).not.toHaveTextContent(secret);
    expect(input).toHaveValue(text);
  });

});


describe('command review projections', () => {
  it('masks documented sensitive Number values across equivalent decimal and exponent formatting', () => {
    const current = schema([textOption('quota', { kind: known('number'), sensitive: known(true) })]);
    const values = { quota: 1e30 };
    const argv = ['--quota', '1e30', '--copy=1e+30', '2'];
    const before = structuredClone({ values, argv });
    // Alternate exponent spelling is a semantic comparison control; the
    // current native serializer emits 1e+30. Its actual 1.0 differs from JS 1.
    expect(maskPreview(argv, current, values)).toEqual(['--quota', '•••', '--copy=•••', '2']);
    // Root's public native resolver also pins browser-like JSON 0.000001
    // becoming argv 1e-6, while the stored JS display is 0.000001.
    expect(maskPreview(['1e-6'], current, { quota: 1e-6 })).toEqual(['•••']);
    expect(maskPreview(['1.0', '--copy=1e0'], current, { quota: 1 })).toEqual(['•••', '--copy=•••']);
    expect({ values, argv }).toEqual(before);
  });

  it('masks documented Json primitives and equivalent object formatting without changing argv', () => {
    const current = schema([textOption('payload', { kind: known('json'), sensitive: known(true) })]);
    expect(maskPreview(['--payload', '"synthetic-preview-secret"'], current, { payload: 'synthetic-preview-secret' }))
      .toEqual(['--payload', '•••']);
    const value = { z: 1, a: [1, 'synthetic-preview-secret'] };
    const argv = ['--payload', '{"a":[1.0,"synthetic-preview-secret"],"z":1}', '--copy={"z":1,"a":[1e0,"synthetic-preview-secret"]}', 'null'];
    const before = structuredClone({ value, argv });
    expect(maskPreview(argv, current, { payload: value })).toEqual(['--payload', '•••', '--copy=•••', 'null']);
    expect(maskPreview(['1.0', '1e0'], current, { payload: 1 })).toEqual(['•••', '•••']);
    expect({ value, argv }).toEqual(before);
  });

  it('keeps Text matching exact and leaves unconfirmed sensitivity unchanged', () => {
    const text = schema([textOption('secret', { kind: known('text'), sensitive: known(true) })]);
    expect(maskPreview(['1e30', '1e+30', '"1e30"'], text, { secret: '1e30' })).toEqual(['•••', '1e+30', '"1e30"']);
    const unconfirmed = schema([textOption('secret', { kind: known('json'), sensitive: { value: true, certainty: 'unknown' } })]);
    expect(maskPreview(['"synthetic-preview-secret"'], unconfirmed, { secret: 'synthetic-preview-secret' }))
      .toEqual(['"synthetic-preview-secret"']);
  });

  it('hides both ambiguous review buckets for a documented sensitive positional without changing raw data', () => {
    const positional = textOption('payload', { position: 0, spellings: [], kind: known('json'), sensitive: known(true) });
    const publicOption = textOption('public');
    const current = schema([positional, publicOption]);
    const values = { public: 'previous' };
    const imported = {
      plan: [{ key: 'public', values: ['kept'] }], managed: ['synthetic-managed-positional', '--public', 'managed-control'],
      unrecognized: ['{"token":"synthetic-private","n":9007199254740993}', '--public', 'ambiguous-control'],
    };
    const before = structuredClone({ values, imported, current });
    // The flattened bucket has no positional ownership. Even a word matching
    // a known flag cannot be proven to be metadata rather than a secret value.
    expect(maskImportReview(imported, current, values)).toEqual({
      managed: ['•••', '•••', '•••'], unrecognized: ['•••', '•••', '•••'],
    });
    expect({ values, imported, current }).toEqual(before);
    const unconfirmed = schema([{ ...positional, sensitive: { value: true, certainty: 'unknown' } }, publicOption]);
    expect(maskImportReview(imported, unconfirmed, values)).toEqual({ managed: imported.managed, unrecognized: imported.unrecognized });
    expect(maskImportReview(imported, schema([publicOption]), values)).toEqual({ managed: imported.managed, unrecognized: imported.unrecognized });
  });

  it('masks tuple values and inline aliases without mutating plans or stored values', () => {
    const current = schema([textOption('amber', { spellings: [{flag:'--amber'},{flag:'-a'}], sensitive: {value:true,certainty:'verified'}, arity: {value:{min:2,max:2},certainty:'verified'} })]);
    const values = { amber: 'previous-synthetic-value' };
    const imported = { plan: [{key:'amber',values:['incoming-synthetic-value']}], managed: ['--amber','first','second','--public','kept','-a=third'], unrecognized: ['--copy=first','--copy=third','--copy=previous-synthetic-value','--copy=incoming-synthetic-value'] };
    const before = structuredClone({values,imported});
    const review=maskImportReview(imported,current,values);
    expect(review.managed).toEqual(['--amber','•••','•••','--public','kept','-a=•••']);
    expect(review.unrecognized).toEqual(['--copy=•••','--copy=•••','--copy=•••','--copy=•••']);
    expect({values,imported}).toEqual(before);
  });
  it('hides the remaining review words when sensitive value arity is unconfirmed', () => {
    const option = textOption('amber', { sensitive: {value:true,certainty:'verified'}, arity: {value:null,certainty:'unknown'} });
    const imported = {plan:[],managed:['--amber','synthetic-one','--public','synthetic-two'],unrecognized:[]};
    expect(maskImportReview(imported,schema([option]),{}).managed).toEqual(['--amber','•••','•••','•••']);
    expect(maskImportReview(imported,schema([{...option,sensitive:{value:true,certainty:'unknown'}}]),{}).managed).toEqual(imported.managed);
  });
});
