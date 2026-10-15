import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import HelpDiscoveryPanel from './HelpDiscoveryPanel';
import AdapterCatalogList from './AdapterCatalogList';
import { I18nProvider } from '../../shared/i18n/i18n';
import * as runtimeHelp from '../../shared/api/runtimeHelp';

vi.mock('../../shared/api/runtimeHelp', async origin => {
  const actual = await origin<typeof import('../../shared/api/runtimeHelp')>();
  return {
    ...actual,
    runtimeHelpDiscover: vi.fn(),
    runtimeHelpCached: vi.fn(),
    runtimeHelpCancelOwner: vi.fn(),
    runtimeHelpResolve: vi.fn().mockResolvedValue({ argv: [], request: {} }),
  };
});

beforeEach(() => {
  vi.mocked(runtimeHelp.runtimeHelpDiscover).mockReset();
  vi.mocked(runtimeHelp.runtimeHelpCached).mockResolvedValue(null);
});

const fingerprint = 'a'.repeat(64);

describe('executable help journey', () => {
  it('discovers once on explicit action and shows the fingerprint diff without a second run', async () => {
    const schema = {
      schema_version: 1,
      binding: { engine: 'custom.example', runtime: 'build-1', fingerprint },
      options: [],
      constraints: [],
      raw_help: [],
      end_of_options: { value: null, certainty: 'unknown' as const },
    };
    vi.mocked(runtimeHelp.runtimeHelpDiscover).mockResolvedValueOnce([
      {
        identity: { fingerprint, executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 },
        scope: [],
        stdout: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false, read_error: null },
        stderr: { text: '', clean_text: '', encoding: 'utf-8', decoding_loss: false, truncated: false, read_error: null },
        exit_code: 0,
        success: true,
        cancelled: false,
        timed_out: false,
        error: null,
        elapsed_ms: 1,
      },
      {
        engine: 'custom.example',
        runtime: 'build-1',
        fingerprint,
        help_complete: true,
        schema,
        diff: { added: ['fresh'], removed: [], changed: [], retained_unknown: [] },
        retained: [],
      },
    ]);
    render(<I18nProvider initialLocale="en"><HelpDiscoveryPanel locked={false} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(/Executable absolute path/), { target: { value: '/opt/engines/server' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
    expect(await screen.findByText(/New options/)).toBeInTheDocument();
    expect(runtimeHelp.runtimeHelpDiscover).toHaveBeenCalledTimes(1);
    expect(runtimeHelp.runtimeHelpCached).toHaveBeenCalled();
  });

  it('cancels only its own owner without touching other discoveries', async () => {
    vi.mocked(runtimeHelp.runtimeHelpDiscover).mockImplementationOnce(() => new Promise(() => undefined));
    render(<I18nProvider initialLocale="en"><HelpDiscoveryPanel locked={false} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText(/Executable absolute path/), { target: { value: '/opt/engines/server' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(runtimeHelp.runtimeHelpCancelOwner).toHaveBeenCalledTimes(1);
  });
});

describe('open adapter list', () => {
  it('lists built-in and custom adapters through one search without engine branches', () => {
    render(
      <I18nProvider initialLocale="en"><AdapterCatalogList
        catalog={[
          { id: 'llama.cpp', engine: 'llama.cpp', server: 'llama-server', availability: { supported: true, detail: '' }, options: [] },
          { id: 'custom.synthetic', engine: 'Synthetic', server: 'openai-v1', kind: 'external-process', availability: { supported: true, detail: '' }, options: [] },
        ]}
        runtimes={[
          { provider: 'llama.cpp', id: 'b1-cpu', engine: 'llama.cpp', server: 'llama-server', accelerator: 'cpu', installation: 'managed', location: '/r', available: true, problems: [] },
        ]}
      /></I18nProvider>
    );
    expect(screen.getByText(/Built-in/)).toBeInTheDocument();
    expect(screen.getByText(/Custom/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search adapters'), { target: { value: 'synthetic' } });
    expect(screen.queryByText(/llama\.cpp · llama-server/)).not.toBeInTheDocument();
    expect(screen.getByText(/Synthetic/)).toBeInTheDocument();
  });
});
