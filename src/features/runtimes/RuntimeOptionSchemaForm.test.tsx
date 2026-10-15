import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import type { OptionSchema } from '../../shared/api/runtimeHelp';

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
    render(<I18nProvider initialLocale="en"><RuntimeOptionSchemaForm schema={current} values={{}} scope={[]} onChange={() => undefined} /></I18nProvider>);
    expect(screen.getByText('--threads', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('--label', { exact: false })).toBeInTheDocument();
    await waitFor(() => expect(runtimeHelp.runtimeHelpResolve).toHaveBeenCalled());
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
    fireEvent.click(screen.getByRole('button', { name: 'Split into ordered plan' }));
    expect(await screen.findByText(/Plan order: alpha, beta, alpha/)).toBeInTheDocument();
    expect(screen.getByText(/Managed by the app/)).toBeInTheDocument();
    expect(screen.getByText(/Unrecognized/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Apply plan to values' }));
    expect(onChange).toHaveBeenCalledWith({ alpha: { spelling: null, occurrences: [['1'], ['3']] }, beta: '2' });
  });
});
const known = <T,>(value: T) => ({ value, certainty: 'documented' as const, source: { kind: 'adapter', id: 't', revision: 'r' } });

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
});
