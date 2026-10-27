import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import * as api from '../../shared/api/runtimeHelp';
import { I18nProvider } from '../../shared/i18n/i18n';
import { effectiveSchema } from '../../testing/effectiveSchema';
import { testConfig } from '../../testing/appStore';
import { getTaskSnapshot, removeTask } from '../../shared/state/taskRegistry';
import EntrypointRegistration from './EntrypointRegistration';

vi.mock('../../shared/api/runtimeHelp', async origin => ({
  ...await origin<typeof import('../../shared/api/runtimeHelp')>(),
  entrypointHelpDiscover: vi.fn(), entrypointHelpCancel: vi.fn(async () => true),
  entrypointManifestPreview: vi.fn(), runtimeEntrypointRegister: vi.fn(), pickRuntimePath: vi.fn(),
  adapterSetupList: vi.fn(), adapterSetupImport: vi.fn(), adapterSetupPrepare: vi.fn(), adapterSetupCancel: vi.fn(async () => true),
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
  for (const task of getTaskSnapshot()) removeTask(task.id);
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

async function reviewHelpRegistration() {
  await enter();
  fireEvent.click(screen.getByRole('combobox', { name: 'Help encoding' }));
  fireEvent.click(screen.getByRole('option', { name: 'Korean (Windows CP949)' }));
  fireEvent.change(screen.getByLabelText('Help locale (optional)'), { target: { value: 'ko_KR.UTF-8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  for (const [label, flag] of [['Model binding', '--model'], ['Port binding', '--port']]) {
    fireEvent.click(screen.getByRole('combobox', { name: `${label} Option from help` }));
    fireEvent.click(screen.getByRole('option', { name: flag }));
  }
  fireEvent.change(screen.getByLabelText('Compatibility check program'), { target: { value: '/synthetic/probe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert {model}' }));
  fireEvent.click(screen.getByRole('button', { name: 'Insert {options_json}' }));
  fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
  fireEvent.click(screen.getByRole('button', { name: 'Review registration details' }));
  await screen.findByRole('button', { name: 'Register' });
  return vi.mocked(api.entrypointManifestPreview).mock.calls.at(-1)![0];
}

function helpPendingError(submitted: api.EntrypointDraft) {
  return new api.EntrypointHelpPendingError({ version: 1, code: 'entrypoint_help_pending',
    engine_id: submitted.engine_id, runtime_id: submitted.runtime_id, fingerprint: submitted.help!.fingerprint, cause: 'Synthetic help storage refused' });
}

it('keeps the focused registration action available to focus while busy guards reject repeated activation', async () => {
  const onRegistered = vi.fn(); const onPublished = vi.fn();
  const view = render(<I18nProvider initialLocale="en"><dialog open><EntrypointRegistration locked={false} onRegistered={onRegistered} onPublished={onPublished} /></dialog></I18nProvider>);
  let reject!: (cause: unknown) => void;
  try {
    const submitted = await reviewHelpRegistration();
    vi.mocked(api.runtimeEntrypointRegister).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    const action = screen.getByRole('button', { name: 'Register' });
    // fireEvent.click does not focus; start at the native keyboard focus point.
    action.focus(); expect(action).toHaveFocus();
    fireEvent.click(action);
    expect(action).toBeEnabled(); expect(action).toHaveAttribute('aria-disabled', 'true'); expect(action).toHaveFocus();
    fireEvent.click(action); fireEvent.click(action);
    expect(fireEvent.submit(action.closest('form')!)).toBe(false);
    expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(1);
    await act(async () => { reject(helpPendingError(submitted)); });
    const retry = screen.getByRole('button', { name: 'Retry saving help' });
    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'false'));
    expect(retry).toBe(action); expect(retry).toHaveFocus(); expect(onPublished).toHaveBeenCalledOnce();
    vi.mocked(api.runtimeEntrypointRegister).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    retry.focus(); fireEvent.click(retry);
    expect(retry).toBeEnabled(); expect(retry).toHaveAttribute('aria-disabled', 'true'); expect(retry).toHaveFocus();
    fireEvent.click(retry); fireEvent.click(retry);
    expect(fireEvent.submit(retry.closest('form')!)).toBe(false);
    expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(2);
    await act(async () => { reject('Synthetic help write still refused'); });
    await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'false'));
    expect(retry).toHaveFocus(); expect(onRegistered).not.toHaveBeenCalled();
    expect(api.runtimeEntrypointRegister).toHaveBeenLastCalledWith(expect.any(Object), { reportHelpPending: true, resumeHelp: true });
  } finally { await act(async () => { reject?.('Synthetic settled during cleanup'); }); view.unmount(); }
});

it.each(['moved', 'hidden', 'unmounted'] as const)('does not take help-save focus back after its owner is %s', async mode => {
  const onRegistered = vi.fn(); const onPublished = vi.fn();
  const view = render(<I18nProvider initialLocale="en"><dialog open><div data-testid="kept-wizard">
    <EntrypointRegistration locked={false} onRegistered={onRegistered} onPublished={onPublished} />
  </div></dialog><button type="button">Elsewhere</button></I18nProvider>);
  let reject!: (cause: unknown) => void; let restoreFocus: (() => void) | undefined;
  try {
    const submitted = await reviewHelpRegistration();
    vi.mocked(api.runtimeEntrypointRegister).mockRejectedValueOnce(helpPendingError(submitted));
    fireEvent.click(screen.getByRole('button', { name: 'Register' }));
    const retry = await screen.findByRole('button', { name: 'Retry saving help' });
    await waitFor(() => expect(retry).toBeEnabled());
    vi.mocked(api.runtimeEntrypointRegister).mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    retry.focus(); expect(retry).toHaveFocus();
    const focus = vi.spyOn(retry, 'focus'); restoreFocus = () => { focus.mockRestore(); };
    fireEvent.click(retry); expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(2);
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    const kept = screen.getByTestId('kept-wizard');
    if (mode === 'moved') { elsewhere.focus(); expect(elsewhere).toHaveFocus(); }
    if (mode === 'hidden') { kept.hidden = true; retry.blur(); }
    if (mode === 'unmounted') view.unmount();
    await act(async () => { reject('Synthetic help write still refused'); });
    expect(focus).not.toHaveBeenCalled(); expect(onRegistered).not.toHaveBeenCalled(); expect(onPublished).toHaveBeenCalledOnce();
    if (mode === 'moved') expect(elsewhere).toHaveFocus();
    else expect(document.body).toHaveFocus();
    if (mode === 'hidden') { kept.hidden = false; await act(async () => undefined); expect(focus).not.toHaveBeenCalled(); expect(document.body).toHaveFocus(); }
  } finally { await act(async () => { reject?.('Synthetic settled during cleanup'); }); view.unmount(); restoreFocus?.(); }
});

it('retains the full published submission across help-save failure and config changes, and retries only that help', async () => {
  const onRegistered = vi.fn(); const onPublished = vi.fn(); const onBusyChange = vi.fn();
  const props = { locked: false, onRegistered, onPublished, onBusyChange };
  const view = render(<I18nProvider initialLocale="en"><EntrypointRegistration {...props} cfg={testConfig} /></I18nProvider>);
  const preview = await reviewHelpRegistration();
  const expected: api.EntrypointDraft = {
    engine_id: 'custom.synthetic', runtime_id: 'build-1', display_name: 'custom.synthetic', program: '/synthetic/python',
    prefix: ['/synthetic path/한글 engine.py'], working_directory: null, artifacts: ['/synthetic path/한글 engine.py'], environment: {}, protocol: { kind: 'openai_http' },
    model: { kind: 'flag', flag: '--model', equals: false }, port: { kind: 'flag', flag: '--port', equals: false }, host: null, served_model: null, auth: { kind: 'none' },
    probe: { program: '/synthetic/probe', args: ['{model}', '{options_json}'], env: {}, working_directory: null },
    health_path: '/health', health_authenticated: false, model_formats: ['gguf'],
    help: { fingerprint: report.identity.fingerprint, request: { program: null, args: ['/synthetic path/한글 engine.py', '--help'], scope: [], encoding: 'cp949', locale: 'ko_KR.UTF-8' } },
  };
  expect(preview).toEqual(expected);
  vi.mocked(api.runtimeEntrypointRegister).mockRejectedValueOnce(helpPendingError(preview));
  const action = screen.getByRole('button', { name: 'Register' });
  fireEvent.click(action);
  const retry = await screen.findByRole('button', { name: 'Retry saving help' });
  expect(retry).toBe(action);
  await waitFor(() => expect(retry).toHaveAttribute('aria-disabled', 'false'));
  expect(retry).toBeEnabled();
  expect(screen.getByText(/The engine was added, but its reviewed help could not be saved/)).toBeVisible();
  expect(screen.getByText('Synthetic help storage refused', { selector: '.app-diagnostic-summary' })).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(onPublished).toHaveBeenCalledOnce(); expect(onRegistered).not.toHaveBeenCalled();
  const submitted = vi.mocked(api.runtimeEntrypointRegister).mock.calls[0][0];
  expect(submitted).toEqual(expected); expect(submitted).not.toBe(preview);
  expect(submitted.prefix).not.toBe(preview.prefix); expect(submitted.help).not.toBe(preview.help);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(screen.getByText('Browse provided adapters').closest('button')).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(screen.queryByLabelText('Compatibility check program')).not.toBeInTheDocument();
  const changed: typeof testConfig = { ...testConfig, active_provider: 'custom.other', active_runtime: 'other-build' };
  view.rerender(<I18nProvider initialLocale="en"><EntrypointRegistration {...props} locked cfg={changed} /></I18nProvider>);
  expect(retry).toBeDisabled();
  expect(retry).toHaveAttribute('aria-disabled', 'true');
  fireEvent.click(retry); expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(1);
  view.rerender(<I18nProvider initialLocale="en"><EntrypointRegistration {...props} cfg={changed} /></I18nProvider>);
  vi.mocked(api.runtimeEntrypointRegister).mockRejectedValueOnce('Synthetic help write still refused');
  fireEvent.click(retry);
  await screen.findByText('Synthetic help write still refused', { selector: '.app-diagnostic-summary' });
  expect(retry).toBeEnabled(); expect(retry).toHaveAttribute('aria-disabled', 'false'); expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(onRegistered).not.toHaveBeenCalled(); expect(onPublished).toHaveBeenCalledOnce();
  let finish!: (value: api.RegisteredManifest) => void;
  vi.mocked(api.runtimeEntrypointRegister).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  try {
    fireEvent.click(retry);
    await waitFor(() => expect(onBusyChange).toHaveBeenLastCalledWith(true));
    expect(retry).toBeEnabled(); expect(retry).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(retry); expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(3);
    await act(async () => { finish(registered); });
    await waitFor(() => expect(onRegistered).toHaveBeenCalledExactlyOnceWith('custom.synthetic', registered));
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('button', { name: 'Retry saving help' })).not.toBeInTheDocument();
    expect(screen.queryByText(/The engine was added, but/)).not.toBeInTheDocument();
    expect(api.runtimeEntrypointRegister).toHaveBeenCalledTimes(3);
    expect(vi.mocked(api.runtimeEntrypointRegister).mock.calls[0]).toEqual([expected, { reportHelpPending: true }]);
    for (const call of vi.mocked(api.runtimeEntrypointRegister).mock.calls.slice(1)) {
      expect(call).toEqual([expected, { reportHelpPending: true, resumeHelp: true }]); expect(call[0]).toBe(submitted);
    }
    expect(preview).toEqual(expected); expect(submitted).toEqual(expected);
    expect(api.entrypointHelpDiscover).toHaveBeenCalledOnce(); expect(api.entrypointManifestPreview).toHaveBeenCalledOnce();
    expect(api.adapterSetupPrepare).not.toHaveBeenCalled(); expect(api.entrypointHelpCancel).not.toHaveBeenCalled();
  } finally { await act(async () => { finish?.(registered); }); view.unmount(); }
});

it('ignores late partial publication and late resumed completion after their registration owner unmounts', async () => {
  for (const phase of ['register', 'resume'] as const) {
    vi.mocked(api.runtimeEntrypointRegister).mockReset().mockResolvedValue(registered);
    const onRegistered = vi.fn(); const onPublished = vi.fn();
    const view = render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={onRegistered} onPublished={onPublished} /></I18nProvider>);
    const submitted = await reviewHelpRegistration();
    if (phase === 'resume') {
      vi.mocked(api.runtimeEntrypointRegister).mockRejectedValueOnce(helpPendingError(submitted));
      fireEvent.click(screen.getByRole('button', { name: 'Register' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Retry saving help' })).toHaveAttribute('aria-disabled', 'false'));
    }
    let resolve!: (value: api.RegisteredManifest) => void; let reject!: (value: unknown) => void;
    vi.mocked(api.runtimeEntrypointRegister).mockReturnValueOnce(new Promise((done, fail) => { resolve = done; reject = fail; }));
    try {
      fireEvent.click(screen.getByRole('button', { name: phase === 'register' ? 'Register' : 'Retry saving help' }));
      const published = onPublished.mock.calls.length;
      view.unmount();
      await act(async () => { if (phase === 'register') reject(helpPendingError(submitted)); else resolve(registered); });
      expect(onRegistered).not.toHaveBeenCalled(); expect(onPublished).toHaveBeenCalledTimes(published);
      expect(api.entrypointHelpCancel).not.toHaveBeenCalled();
    } finally { await act(async () => { resolve?.(registered); }); view.unmount(); }
  }
});

it('discovers with explicit help encoding and locale and clears that review when either changes', async () => {
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('combobox', { name: 'Help encoding' }));
  fireEvent.click(screen.getByRole('option', { name: 'Korean (Windows CP949)' }));
  const locale = screen.getByLabelText('Help locale (optional)');
  fireEvent.change(locale, { target: { value: 'ko_KR.UTF-8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(api.entrypointHelpDiscover).toHaveBeenLastCalledWith(expect.any(Object), {
    program: null, args: ['/synthetic path/한글 engine.py', '--help'], scope: [], encoding: 'cp949', locale: 'ko_KR.UTF-8',
  });
  fireEvent.change(locale, { target: { value: 'C' } });
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  fireEvent.click(screen.getByRole('combobox', { name: 'Help encoding' }));
  fireEvent.click(screen.getByRole('option', { name: 'Auto (BOM or UTF-8)' }));
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
});

it('takes adapter setup through fresh help and preserves probe environment, model bindings and owned resources for review', async () => {
  const recipe: api.AdapterSetupRecipe = { version: 1, id: 'any.adapter', title: 'Arbitrary adapter', description: 'Explicit connection',
    fields: [{ key: 'installation', label: 'Installation folder', kind: 'folder', required: false, default: '/synthetic/sdk' }],
    prepare: { program: '/synthetic/prepare', args: [], env: {} } };
  const prepared: api.EntrypointDraft = {
    engine_id: 'custom.synthetic', runtime_id: 'build-1', display_name: 'Synthetic', program: '/synthetic/engine',
    prefix: ['--label', 'serve', 'serve'], command_layout: { version: 1, subcommands: [2], options: [{ index: 0, values: 1 }] }, artifacts: ['/synthetic/bridge.py'], environment: {}, protocol: { kind: 'openai_http' },
    model: { kind: 'flag', flag: '--model' }, port: { kind: 'flag', flag: '--port' }, auth: { kind: 'none' },
    probe: { program: '/synthetic/probe', args: ['{model}'], env: { INSTALLED_LOADER: 'synthetic' }, working_directory: '/synthetic/sdk' },
    health_path: '/health', health_authenticated: false, model_formats: ['unknown'],
    models: [{ path: '/synthetic/deployment.json', name: 'Synthetic deployment' }],
    launch_resources: { version: 1, directory_env: 'SYNTHETIC_LAUNCH_DIRECTORY' },
    options_separator: '--',
  };
  vi.mocked(api.adapterSetupList).mockResolvedValue([recipe]);
  vi.mocked(api.adapterSetupPrepare).mockResolvedValue(prepared);
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'Browse provided adapters' }));
  fireEvent.submit((await screen.findByRole('button', { name: 'Check installation and continue' })).closest('form')!);
  await screen.findByRole('button', { name: 'Discover help' });
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(screen.getByLabelText('Installation folder')).toHaveValue('/synthetic/sdk');
  expect(api.adapterSetupList).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(api.entrypointHelpDiscover).not.toHaveBeenCalled();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
  await screen.findByRole('button', { name: 'Register' });
  expect(vi.mocked(api.entrypointManifestPreview).mock.calls.at(-1)?.[0]).toMatchObject({
    probe: prepared.probe, models: prepared.models, launch_resources: prepared.launch_resources, options_separator: '--',
    command_layout: prepared.command_layout,
    help: { fingerprint: report.identity.fingerprint, request: { scope: ['serve'] } },
  });
});

it('keeps exact entry tokens and requires explicit model, port and probe bindings before registering', async () => {
  const onRegistered = vi.fn();
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={onRegistered} /></I18nProvider>);
  expect(api.entrypointHelpDiscover).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  await enter();
  fireEvent.click(screen.getByRole('combobox', { name: 'Help encoding' }));
  fireEvent.click(screen.getByRole('option', { name: 'Korean (Windows CP949)' }));
  fireEvent.change(screen.getByLabelText('Help locale (optional)'), { target: { value: 'ko_KR.UTF-8' } });
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(api.entrypointHelpDiscover).toHaveBeenCalledWith(expect.objectContaining({
    prefix: ['/synthetic path/한글 engine.py'], artifacts: ['/synthetic path/한글 engine.py'],
  }), { program: null, args: ['/synthetic path/한글 engine.py', '--help'], scope: [], encoding: 'cp949', locale: 'ko_KR.UTF-8' });
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
  expect(await screen.findByText('Fill in the required fields.')).toBeVisible();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  for (const [label, flag] of [['Model binding', '--model'], ['Port binding', '--port']]) {
    fireEvent.click(screen.getByRole('combobox', { name: `${label} Option from help` }));
    fireEvent.click(screen.getByRole('option', { name: flag }));
  }
  fireEvent.change(screen.getByLabelText("Compatibility check program"), { target: { value: '/synthetic/probe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert {model}' }));
  fireEvent.click(screen.getByRole('button', { name: 'Insert {options_json}' }));
  fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
  fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
  await screen.findByRole('button', { name: 'Register' });
  const draft = vi.mocked(api.entrypointManifestPreview).mock.calls[0][0];
  expect(draft).toMatchObject({ model: { kind: 'flag', flag: '--model', equals: false }, port: { kind: 'flag', flag: '--port', equals: false },
    auth: { kind: 'none' }, protocol: { kind: 'openai_http' }, health_path: '/health', model_formats: ['gguf'],
    probe: { program: '/synthetic/probe', args: ['{model}', '{options_json}'] },
    help: { fingerprint: report.identity.fingerprint, request: { encoding: 'cp949', locale: 'ko_KR.UTF-8' } } });
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Register' }));
  await waitFor(() => expect(onRegistered).toHaveBeenCalledWith('custom.synthetic', expect.objectContaining({ runtime_id: 'build-1', display_name: 'Synthetic' })));
  expect(api.runtimeEntrypointRegister).toHaveBeenCalledWith(draft, { reportHelpPending: true });
});

it('keeps failed entrypoint help mentioning cancelled visible and retries the unchanged draft', async () => {
  const diagnostic = 'help output is incomplete; rediscover before building options\n'
    + 'Help capture: success=false, exit_code=17, timed_out=false\n'
    + 'stderr (encoding=utf-8, decoding_loss=false, truncated=false, read_error=none):\n'
    + 'An earlier operation was cancelled; this help command failed.';
  vi.mocked(api.entrypointHelpDiscover).mockRejectedValueOnce(diagnostic);
  const onRegistered = vi.fn();
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={onRegistered} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(api.entrypointHelpDiscover).toHaveBeenCalledOnce());
  const submitted = vi.mocked(api.entrypointHelpDiscover).mock.calls[0];
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('help output is incomplete');
  const disclosure = alert.querySelector('details')!;
  fireEvent.click(disclosure.querySelector('summary')!);
  expect(alert.querySelector('pre')).toBeVisible();
  expect(alert.querySelector('pre')).toHaveTextContent('exit_code=17');
  expect(alert.querySelector('pre')).toHaveTextContent('earlier operation was cancelled');
  expect(getTaskSnapshot()).toEqual([expect.objectContaining({ state: 'failed', detail: diagnostic })]);
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(screen.queryByRole('combobox', { name: 'Model binding Option from help' })).not.toBeInTheDocument();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  expect(onRegistered).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
  expect(screen.getByLabelText('Engine ID (custom.*)')).toHaveValue('custom.synthetic');
  expect(screen.getByLabelText('Runtime ID')).toHaveValue('build-1');
  expect(screen.getByLabelText('Executable or interpreter')).toHaveValue('/synthetic/python');
  expect(screen.getAllByDisplayValue('/synthetic path/한글 engine.py')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(vi.mocked(api.entrypointHelpDiscover).mock.calls[1]).toEqual(submitted);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Next' }));
  expect(screen.getByRole('combobox', { name: 'Model binding Option from help' })).toBeVisible();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
});

it.each(['canonical', 'requested'] as const)('keeps %s entrypoint help cancellation quiet and permits retry', async mode => {
  let reject!: (cause: string) => void;
  vi.mocked(api.entrypointHelpDiscover).mockReturnValueOnce(new Promise((_, failure) => { reject = failure; }));
  render(<I18nProvider initialLocale="en"><EntrypointRegistration locked={false} onRegistered={vi.fn()} /></I18nProvider>);
  await enter();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  const submitted = vi.mocked(api.entrypointHelpDiscover).mock.calls[0];
  if (mode === 'requested') {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(api.entrypointHelpCancel).toHaveBeenCalledWith(submitted[0]);
  }
  await act(async () => { reject(mode === 'canonical' ? 'help discovery cancelled' : 'process stopped before complete help'); });
  expect(getTaskSnapshot()).toEqual([expect.objectContaining({ state: 'cancelled' })]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Discover help' }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'Next' })).toBeEnabled());
  expect(vi.mocked(api.entrypointHelpDiscover).mock.calls[1]).toEqual(submitted);
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
  expect(screen.getByText(/^Saved options missing from the current option list/)).toHaveTextContent('removed_option');
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
  const field = screen.getByLabelText("Additional option information (JSON, optional)");
  fireEvent.change(field, { target: { value: '{"version":' } });
  expect(screen.getByRole('alert')).toHaveTextContent('Enter option information as a JSON object');
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
  fireEvent.change(screen.getByLabelText("Compatibility check program"), { target: { value: '/synthetic/probe' } });
  fireEvent.click(screen.getByRole('button', { name: 'Insert {model}' }));
  fireEvent.change(screen.getByLabelText('Health path'), { target: { value: '/health' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'gguf' }));
  fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
  expect(await screen.findByText(/Host binding \(optional\).*choose its option or select Not used/)).toBeVisible();
  expect(api.entrypointManifestPreview).not.toHaveBeenCalled();
  expect(api.runtimeEntrypointRegister).not.toHaveBeenCalled();
  // The other choices stay as typed; choosing "Not used" registers no host.
  expect(screen.getByLabelText("Compatibility check program")).toHaveValue('/synthetic/probe');
  fireEvent.click(screen.getByRole('combobox', { name: 'Host binding (optional)' }));
  fireEvent.click(screen.getByRole('option', { name: 'Not used' }));
  fireEvent.click(screen.getByRole('button', { name: "Review registration details" }));
  await screen.findByRole('button', { name: 'Register' });
  expect(vi.mocked(api.entrypointManifestPreview).mock.calls[0][0]).toMatchObject({ host: null });
});
