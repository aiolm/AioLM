import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import RuntimeOptionSchemaForm from './RuntimeOptionSchemaForm';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as runtimeHelp from '../../shared/api/runtimeHelp';
import type { OptionSchema } from '../../shared/api/runtimeHelp';

vi.mock('../../shared/api/runtimeHelp', async origin => {
  const actual = await origin<typeof import('../../shared/api/runtimeHelp')>();
  return { ...actual, runtimeHelpResolve: vi.fn() };
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
    expect(screen.getByText(/•••/)).toBeInTheDocument();
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
});
