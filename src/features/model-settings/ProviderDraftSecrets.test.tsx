import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import * as api from '../../shared/api';
import { ProviderOptions } from './ProviderControls';
import { effectiveSchema, schemaOption } from '../../testing/effectiveSchema';
import type { CommandEntry, OptionSchemaDefinition } from '../../shared/api/runtimeHelp';

vi.mock('../../shared/api', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api')>(),
  providerCatalog: vi.fn(), providerRuntimes: vi.fn(), providerOptionIssues: vi.fn(), providerRuntimeOptions: vi.fn(),
  providerOptionSchema: vi.fn(), runtimeHelpTarget: vi.fn(),
  runtimeHelpDiscoverSelected: vi.fn(), runtimeHelpCancelSelected: vi.fn(async () => true), runtimeHelpAccept: vi.fn(),
  pickRuntimePath: vi.fn(),
}));

const SECRET = 'synthetic-draft-amber-3771';
const PLAIN = 'plain-token';
const PREFIX = ['-I', 'engine.py', 'serve', SECRET, PLAIN];

const entry: CommandEntry = {
  version: 1, program: '/synthetic/engine', prefix: PREFIX,
  layout: { version: 1, subcommands: [2], options: [{ index: 0, values: 0 }] },
  positional_bindings: ['model'],
};

function slot(key: string, position: number, sensitive: OptionSchemaDefinition['sensitive']): OptionSchemaDefinition {
  return { ...schemaOption({ key, target: 'launch', group: 'options', kind: { type: 'text' } }), position, managed: 'discovery', sensitive, help: `${key} help` };
}

const known = { value: true as const, certainty: 'documented' as const, source: { kind: 'adapter' as const, id: 'synthetic.role', revision: '1' } };
const slots = [
  slot('input', 0, { value: null, certainty: 'unknown' as const }),
  slot('marker', 2, known),
];

const freshEffective = () => effectiveSchema([], slots, { entry });

const cfg = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: 'syn-1' };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.providerCatalog).mockResolvedValue([{ id: 'custom.synthetic', engine: 'Synthetic', server: 'synthetic', availability: { supported: true, detail: '' }, options: [] }]);
  vi.mocked(api.providerRuntimes).mockResolvedValue([]);
  vi.mocked(api.providerOptionIssues).mockResolvedValue([]);
  vi.mocked(api.providerRuntimeOptions).mockResolvedValue([]);
  vi.mocked(api.providerOptionSchema).mockResolvedValue(freshEffective());
  vi.mocked(api.runtimeHelpTarget).mockResolvedValue({
    engine: 'custom.synthetic', runtime: 'syn-1', program: '/synthetic/engine', fixed: false,
    prefix: PREFIX, request: { args: [...PREFIX, '--help'], scope: [] },
  });
});

function chooseMarker() {
  fireEvent.click(screen.getByRole('combobox', { name: 'marker Positional layout' }));
  fireEvent.click(screen.getByRole('option', { name: `Entry token 4: ${SECRET}` }));
}

describe('unsaved known-sensitive static roles', () => {
  it('masks the help command, preview and import review from draft mapping without saving', async () => {
    const confirm = vi.spyOn(api, 'runtimeHelpConfirmSyntax').mockReturnValue(new Promise(() => undefined));
    const preview = vi.spyOn(api, 'providerCommandPreview').mockResolvedValue(['/synthetic/engine', ...PREFIX]);
    const imported = vi.spyOn(api, 'runtimeHelpImport').mockResolvedValue({ plan: [], managed: ['serve', SECRET], unrecognized: [] });
    const onChange = vi.fn();
    const view = (runtime: string) => <I18nProvider initialLocale="en"><ProviderOptions cfg={{ ...cfg, active_runtime: runtime }} disabled={false} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>;
    const rendered = render(view('syn-1'));
    await screen.findByRole('heading', { name: 'Positional layout' });
    await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
    // Before linkage the token is not proven sensitive: correctly visible.
    expect(screen.getByText(/Help command/)).toHaveTextContent(SECRET);
    // A preview generated before linkage is raw, correctly for that moment.
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    await waitFor(() => expect(preview).toHaveBeenCalled());
    expect(document.body).toHaveTextContent(SECRET);

    // Explicitly mapping the documented-sensitive slot masks every projection.
    chooseMarker();
    await waitFor(() => expect(screen.getByText(/Help command/)).toHaveTextContent('•••'));
    // The stale pre-linkage preview is cleared instead of keeping the raw secret.
    expect(document.body).not.toHaveTextContent(SECRET);
    // Nothing was saved or applied behind the user's back.
    expect(confirm).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();

    // Fresh projections from the draft stay masked.
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    await waitFor(() => expect(preview).toHaveBeenCalledTimes(2));
    expect(document.body).not.toHaveTextContent(SECRET);

    const paste = `serve ${SECRET}`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Import command' }), { target: { value: paste } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    const review = await screen.findByText(/serve •••/);
    expect(review).not.toHaveTextContent(SECRET);
    expect(screen.getByRole('textbox', { name: 'Import command' })).toHaveValue(paste);

    // Switching runtimes drops the draft: the new review shows its own bytes.
    rendered.rerender(view('syn-2'));
    await waitFor(() => expect(screen.getByText(/Help command/)).toHaveTextContent(SECRET));
    confirm.mockRestore();
    preview.mockRestore();
    imported.mockRestore();
  });

  it('masks responses that resolve after the draft mapping without saving', async () => {
    const confirm = vi.spyOn(api, 'runtimeHelpConfirmSyntax').mockReturnValue(new Promise(() => undefined));
    let resolvePreview!: (argv: string[]) => void;
    const preview = vi.spyOn(api, 'providerCommandPreview').mockReturnValue(new Promise(resolve => { resolvePreview = resolve; }));
    let resolveImport!: (plan: api.ImportedPlan) => void;
    const imported = vi.spyOn(api, 'runtimeHelpImport').mockReturnValue(new Promise(resolve => { resolveImport = resolve; }));
    const { container } = render(<I18nProvider initialLocale="en"><ProviderOptions cfg={cfg} disabled={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    await screen.findByRole('heading', { name: 'Positional layout' });
    await waitFor(() => expect(screen.getByText(/Help command/)).toBeInTheDocument());
    // Start both display requests before any linkage exists; keep them pending.
    fireEvent.click(screen.getByRole('button', { name: 'Command preview' }));
    const paste = `serve ${SECRET}`;
    fireEvent.change(screen.getByRole('textbox', { name: 'Import command' }), { target: { value: paste } });
    fireEvent.click(screen.getByRole('combobox', { name: 'Command syntax' }));
    fireEvent.click(screen.getByRole('option', { name: 'POSIX argument quoting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import command' }));
    // Map the documented-sensitive slot without saving, then resolve late.
    chooseMarker();
    await waitFor(() => expect(screen.getByText(/Help command/)).toHaveTextContent('•••'));
    // The stale pre-linkage preview is cleared instead of keeping raw bytes.
    expect(container.querySelector('pre')).toBeNull();
    resolvePreview(['/synthetic/engine', ...PREFIX]);
    resolveImport({ plan: [], managed: ['serve', SECRET], unrecognized: [] });
    // Late responses mask the token. The user's own paste input keeps its
    // exact bytes by contract, so response assertions scope past it: the
    // paste textarea legitimately still holds the raw text.
    await waitFor(() => {
      const rendered = container.querySelector('pre');
      expect(rendered).not.toBeNull();
      expect(rendered).toHaveTextContent('•••');
      expect(rendered).not.toHaveTextContent(SECRET);
    });
    const maskedReview = await screen.findByText(/serve •••/);
    expect(maskedReview).not.toHaveTextContent(SECRET);
    expect(screen.getByText(/Help command/)).not.toHaveTextContent(SECRET);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Import command' })).toHaveValue(paste);
    confirm.mockRestore();
    preview.mockRestore();
    imported.mockRestore();
  });
});
