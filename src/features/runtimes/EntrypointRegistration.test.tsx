import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { effectiveSchema } from '../../testing/effectiveSchema';
import { testConfig } from '../../testing/appStore';
import EntrypointRegistration from './EntrypointRegistration';

vi.mock('../../shared/api/runtimeHelp', async origin => ({
  ...await origin<typeof import('../../shared/api/runtimeHelp')>(),
  entrypointHelpDiscover: vi.fn(), entrypointHelpCancel: vi.fn(async () => true),
  entrypointManifestPreview: vi.fn(), runtimeEntrypointRegister: vi.fn(), pickRuntimePath: vi.fn(),
}));
const schema = effectiveSchema(['model', 'port'].map(key => ({ key, flag: `--${key}`, target: 'launch' as const, group: 'runtime', kind: { type: 'text' as const } }))).schema;
const output = { text: 'synthetic help', clean_text: 'synthetic help', encoding: 'utf-8', decoding_loss: false, truncated: false };
const report: api.HelpReport = { identity: { fingerprint: 'a'.repeat(64), executable_sha256: 'b'.repeat(64), artifacts_sha256: {}, parser_version: 1 },
  scope: [], stdout: output, stderr: { ...output, text: '', clean_text: '' }, success: true, cancelled: false, timed_out: false, exit_code: 0, elapsed_ms: 1 };
const result: [api.HelpReport, api.RuntimeDescriptor] = [report, { engine: 'custom.synthetic', runtime: 'build-1', fingerprint: report.identity.fingerprint, help_complete: true, schema, retained: [] }];
const registered: api.RegisteredManifest = { engine_id: 'custom.synthetic', runtime_id: 'build-1', display_name: 'Synthetic',
  launch: { program: '/synthetic/python', args: [], env: {} }, probe: { program: '/synthetic/probe', args: [], env: {} } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.entrypointHelpDiscover).mockResolvedValue(result);
  vi.mocked(api.entrypointManifestPreview).mockResolvedValue(registered);
  vi.mocked(api.runtimeEntrypointRegister).mockResolvedValue(registered);
  vi.mocked(api.pickRuntimePath).mockResolvedValue('/synthetic path/한글 engine.py');
});

it('discovers the HTTP bridge entry point instead of attaching engine arguments to the bridge program', async () => {
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.bridge' } });
  fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'bridge-1' } });
  fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/engine' } });
  fireEvent.click(screen.getByRole('radio', { name: 'A separate bridge program serves HTTP' }));
  fireEvent.change(screen.getByLabelText('Bridge program'), { target: { value: '/synthetic/python' } });
  fireEvent.click(within(screen.getByRole('group', { name: 'Bridge arguments' })).getByRole('button', { name: 'Add argument' }));
  fireEvent.change(screen.getByLabelText('Bridge arguments Argument 1'), { target: { value: '/synthetic/bridge.py' } });
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Bridge variable for engine JSON argv'), { target: { value: 'BRIDGE_ENGINE_ARGV' } });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(api.entrypointHelpDiscover).toHaveBeenCalledWith(expect.objectContaining({
    program: '/synthetic/engine', protocol: { kind: 'bridge', program: '/synthetic/python', prefix: ['/synthetic/bridge.py'], engine_argv_env: 'BRIDGE_ENGINE_ARGV' },
  }), {
    program: null, args: ['/synthetic/bridge.py', '--help'], scope: [],
  }));
});

async function enter() {
  fireEvent.change(screen.getByLabelText('Engine ID (custom.*)'), { target: { value: 'custom.synthetic' } });
  fireEvent.change(screen.getByLabelText('Runtime ID'), { target: { value: 'build-1' } });
  fireEvent.change(screen.getByLabelText('Executable or interpreter'), { target: { value: '/synthetic/python' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Add file argument' })[0]);
  await waitFor(() => expect(screen.getAllByDisplayValue('/synthetic path/한글 engine.py')).toHaveLength(2));
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
}

it('keeps exact entry tokens and requires explicit model, port and probe bindings before registering', async () => {
  const onRegistered = vi.fn();
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={onRegistered} /></I18nProvider>);
  expect(api.entrypointHelpDiscover).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(api.entrypointHelpDiscover).toHaveBeenCalledWith(expect.objectContaining({
    prefix: ['/synthetic path/한글 engine.py'], artifacts: ['/synthetic path/한글 engine.py'],
  }), { program: null, args: ['/synthetic path/한글 engine.py', '--help'], scope: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }));
  expect(await screen.findByText('Fill in the required fields.')).toBeVisible();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  for (const [label, flag] of [['Model binding', '--model'], ['Port binding', '--port']]) {
    fireEvent.click(screen.getByRole('combobox', { name: `${label} Option from help` }));
    fireEvent.click(screen.getByRole('option', { name: flag }));
  }
  fireEvent.change(screen.getByLabelText('Probe program'), { target: { value: '/synthetic/probe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert {model}' }));
  fireEvent.click(screen.getByRole('button', { name: 'Insert {options_json}' }));
  fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }));
  await screen.findByRole('button', { name: 'Register' });
  const draft = vi.mocked(api.entrypointManifestPreview).mock.calls[0][0];
  expect(draft).toMatchObject({ model: { kind: 'flag', flag: '--model', equals: false }, port: { kind: 'flag', flag: '--port', equals: false },
    auth: { kind: 'none' }, protocol: { kind: 'openai_http' }, health_path: '/health', model_formats: ['gguf'],
    probe: { program: '/synthetic/probe', args: ['{model}', '{options_json}'] },
    help: { fingerprint: report.identity.fingerprint } });
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  await waitFor(() => expect(onRegistered).toHaveBeenCalledWith('custom.synthetic'));
  expect(api.runtimeEntrypointRegister).toHaveBeenCalledWith(draft);
});

it('does not treat a cancelled late help result as a binding source and can retry', async () => {
  let finish!: (value: typeof result) => void;
  vi.mocked(api.entrypointHelpDiscover).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => { finish(result); });
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
});

it('shows changed options and retained values while reviewing a rebuilt entry point', async () => {
  vi.mocked(api.entrypointHelpDiscover).mockResolvedValueOnce([report, { ...result[1],
    diff: { added: ['new_option'], removed: ['removed_option'], changed: ['changed_option'], retained_unknown: ['removed_option'] },
    retained: ['removed_option'],
  }]);
  render(<I18nProvider initialLocale="en"><EntrypointRegistration cfg={testConfig} locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(screen.getByText(/new_option/)).toBeVisible();
  expect(screen.getByText(/changed_option/)).toBeVisible();
  expect(screen.getByText(/^Saved values absent from the schema/)).toHaveTextContent('removed_option');
  expect(api.entrypointHelpDiscover).toHaveBeenCalledWith(expect.any(Object), expect.any(Object), testConfig);
});

it('cancels only the pending entry point when the registration panel unmounts', async () => {
  vi.mocked(api.entrypointHelpDiscover).mockReturnValueOnce(new Promise(() => undefined));
  const rendered = render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  const entry = vi.mocked(api.entrypointHelpDiscover).mock.calls[0][0];
  rendered.unmount();
  expect(api.entrypointHelpCancel).toHaveBeenCalledWith(entry);
});

it('carries explicit option metadata in the entry so its help review and registration use the same metadata', async () => {
  const metadata = { version: 1, engine_id: 'custom.synthetic', adapter: { id: 'synthetic.adapter', revision: 'r1' },
    options: [{ flag: '--fresh-secret', sensitive: true }] };
  vi.mocked(api.entrypointHelpDiscover).mockResolvedValueOnce([report, { ...result[1],
    metadata: { adapter: 'synthetic.adapter', revision: 'r1', builtin: false, applied: ['fresh_secret'], error: null, conflicts: [
      { key: '', flag: '--absent-flag', field: 'option', observed: null, declared: { sensitive: true }, declared_by: 'synthetic.adapter r1', applies: 'observed', blocking: false },
    ] } }]);
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  const field = screen.getByLabelText('Option metadata (JSON, optional)');
  fireEvent.change(field, { target: { value: '{"version":' } });
  expect(screen.getByRole('alert')).toHaveTextContent('not valid JSON');
  fireEvent.change(field, { target: { value: JSON.stringify(metadata) } });
  expect(screen.queryByRole('alert')).toBeNull();
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(vi.mocked(api.entrypointHelpDiscover).mock.calls[0][0]).toMatchObject({ option_metadata: metadata });
  // The discovered help is reviewed against the metadata before binding.
  const review = screen.getByRole('region', { name: 'Option fact differences' });
  expect(review).toHaveTextContent('adapter synthetic.adapter (r1)');
  expect(review).toHaveTextContent('--absent-flag');
});

it('omits option metadata from the entry when none is given', async () => {
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(api.entrypointHelpDiscover).toHaveBeenCalled());
  expect(vi.mocked(api.entrypointHelpDiscover).mock.calls[0][0]).not.toHaveProperty('option_metadata');
});

it('does not register an optional binding the user chose but left without its option', async () => {
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  for (const [label, flag] of [['Model binding', '--model'], ['Port binding', '--port']]) {
    fireEvent.click(screen.getByRole('combobox', { name: `${label} Option from help` }));
    fireEvent.click(screen.getByRole('option', { name: flag }));
  }
  // Host is switched to "Option from help" but no option is picked.
  fireEvent.click(screen.getByRole('combobox', { name: 'Host binding (optional)' }));
  fireEvent.click(screen.getByRole('option', { name: 'Option from help' }));
  fireEvent.change(screen.getByLabelText('Probe program'), { target: { value: '/synthetic/probe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert {model}' }));
  fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }));
  expect(await screen.findByText(/Host binding \(optional\).*choose its option or select Not used/)).toBeVisible();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  // The other choices stay as typed; choosing "Not used" registers no host.
  expect(screen.getByLabelText('Probe program')).toHaveValue('/synthetic/probe');
  fireEvent.click(screen.getByRole('combobox', { name: 'Host binding (optional)' }));
  fireEvent.click(screen.getByRole('option', { name: 'Not used' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review manifest' }));
  await screen.findByRole('button', { name: 'Register' });
  expect(vi.mocked(api.entrypointManifestPreview).mock.calls[0][0]).toMatchObject({ host: null });
});
