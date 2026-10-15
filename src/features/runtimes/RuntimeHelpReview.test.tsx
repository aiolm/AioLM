import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api';
import { I18nProvider } from '../../shared/i18n/i18n';
import { testConfig } from '../../testing/appStore';
import { effectiveSchema } from '../../testing/effectiveSchema';
import RuntimeHelpReview from './RuntimeHelpReview';

vi.mock('../../shared/api', async origin => ({
  ...await origin<typeof import('../../shared/api')>(),
  runtimeHelpTarget: vi.fn(), runtimeHelpDiscoverSelected: vi.fn(),
  runtimeHelpCancelSelected: vi.fn(async () => true), runtimeHelpAccept: vi.fn(),
}));

const cfg = { ...testConfig, active_provider: 'custom.synthetic' as const, active_runtime: 'build-1' };
const effective = effectiveSchema([]);
const report: api.HelpReport = {
  identity: { fingerprint: 'a'.repeat(64), executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 },
  scope: [], stdout: { text: 'stdout options', clean_text: 'stdout options', encoding: 'utf-8', decoding_loss: false, truncated: false },
  stderr: { text: 'stderr options', clean_text: 'stderr options', encoding: 'utf-8', decoding_loss: false, truncated: false },
  success: true, cancelled: false, timed_out: false, exit_code: 0, elapsed_ms: 1,
};
const result: [api.HelpReport, api.RuntimeDescriptor] = [report, {
  engine: 'custom.synthetic', runtime: 'build-1', fingerprint: report.identity.fingerprint,
  help_complete: true, schema: effective.schema, retained: ['old_value'],
  diff: { added: ['new_flag'], removed: ['old_flag'], changed: ['changed_arity'], retained_unknown: ['old_value'] },
}];

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.runtimeHelpTarget).mockImplementation(async config => ({
    engine: config.active_provider!, runtime: config.active_runtime!, program: '/synthetic/python', fixed: false,
    prefix: ['-I', '/synthetic path/engine.py'], request: { args: ['-I', '/synthetic path/engine.py', '--help'], scope: [] },
  }));
  vi.mocked(api.runtimeHelpDiscoverSelected).mockResolvedValue(result);
  vi.mocked(api.runtimeHelpAccept).mockResolvedValue({ version: 1, fingerprint: report.identity.fingerprint, request: { args: ['--help'], scope: [] } });
});

function view(config = cfg, onAccepted = vi.fn()) {
  return <I18nProvider initialLocale="en"><RuntimeHelpReview cfg={config} effective={effective} disabled={false} onAccepted={onAccepted} /></I18nProvider>;
}

it('discovers only on explicit action, preserves token boundaries, reviews the diff and accepts the exact result', async () => {
  const accepted = vi.fn();
  render(view(cfg, accepted));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover help' })).toBeEnabled());
  expect(api.runtimeHelpDiscoverSelected).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add argument' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Help arguments after the entry point Argument 2' }), { target: { value: 'a b 한글' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await screen.findByText(/New options: new_flag/);
  expect(api.runtimeHelpDiscoverSelected).toHaveBeenCalledExactlyOnceWith(cfg, {
    program: null, args: ['-I', '/synthetic path/engine.py', '--help', 'a b 한글'], scope: [],
  });
  expect(screen.getByText(/Removed options: old_flag/)).toBeVisible();
  expect(screen.getByText(/Changed options: changed_arity/)).toBeVisible();
  fireEvent.click(screen.getByText('Raw help'));
  expect(screen.getByText('stdout options stderr options')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Accept this help' }));
  await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
  expect(api.runtimeHelpAccept).toHaveBeenCalledWith(cfg, report.identity.fingerprint, expect.objectContaining({ args: ['-I', '/synthetic path/engine.py', '--help', 'a b 한글'] }));
});

it('cancels the old runtime when selection changes and rejects its late help publication', async () => {
  let finish!: (value: typeof result) => void;
  vi.mocked(api.runtimeHelpDiscoverSelected).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const rendered = render(view());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover help' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  rendered.rerender(view({ ...cfg, active_runtime: 'build-2' }));
  expect(api.runtimeHelpCancelSelected).toHaveBeenCalledWith(cfg);
  await act(async () => { finish(result); });
  expect(screen.queryByRole('button', { name: 'Accept this help' })).not.toBeInTheDocument();
  expect(screen.queryByText(/new_flag/)).not.toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover help' })).toBeEnabled());
});

it('keeps a cancelled late success unavailable for acceptance and can discover again', async () => {
  let finish!: (value: typeof result) => void;
  vi.mocked(api.runtimeHelpDiscoverSelected).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(view());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover help' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { finish(result); });
  expect(screen.queryByRole('button', { name: 'Accept this help' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  expect(await screen.findByRole('button', { name: 'Accept this help' })).toBeEnabled();
});

it('cancels an owned discovery when unmounted and never accepts an incomplete report', async () => {
  vi.mocked(api.runtimeHelpDiscoverSelected).mockResolvedValueOnce([report, { ...result[1], help_complete: false }]);
  const rendered = render(view());
  await waitFor(() => expect(screen.getByRole('button', { name: 'Discover help' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await screen.findByText(/The help is incomplete/);
  expect(screen.queryByRole('button', { name: 'Accept this help' })).not.toBeInTheDocument();
  vi.mocked(api.runtimeHelpDiscoverSelected).mockReturnValueOnce(new Promise(() => undefined));
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  rendered.unmount();
  expect(api.runtimeHelpCancelSelected).toHaveBeenCalledWith(cfg);
});
