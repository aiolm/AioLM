import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import * as api from '../../shared/api/index';
import { I18nProvider } from '../../shared/i18n/i18n';
import { createTestStore, testConfig } from '../../testing/appStore';
import { withManualOverrides } from '../../shared/config/tuningDefaults';
import TuningPanel from './Tuning';
import { ADVANCED_SAMPLING_FIELDS, chatOptionValue } from './tuningFields';
import TuningServerOptions from './TuningServerOptions';
import { parseRuntimeHelp } from '../../shared/config/serverOptions';

const help = '--mmap, --no-mmap                       memory mapping\n--cache-ram N                          cache memory\n--min-p N                              minimum probability\n--top-p N                              probability\n--port PORT                            HTTP port\n--future-pr-option N                   custom build option';
beforeEach(() => {
  vi.spyOn(api, 'rtProbe').mockResolvedValue({ backend: 'cpu', build: 'b123', executable: 'llama-server', state: 'available', version: 'test', flags: [], devices: [], diagnostics: [], server_help: help });
});

function mount() {
  let saved = { ...structuredClone(testConfig), runtime_defaults: ['top_p'], server_args: ['--cache-ram', '-1'] };
  function Live() {
    const [cfg, setCfg] = useState(saved);
    return <I18nProvider initialLocale="en"><TuningPanel store={{ ...createTestStore(), cfg, updateConfig: async patch => {
      saved = { ...saved, ...withManualOverrides(saved, typeof patch === 'function' ? patch(saved) : patch) };
      setCfg(saved);
      return saved;
    } }} /></I18nProvider>;
  }
  render(<Live />);
  return () => saved;
}

function openOption(flag: string) {
  const element = document.querySelector<HTMLDetailsElement>(`[data-server-option="${flag}"]`)!;
  element.open = true;
  return within(element);
}

describe('server option editing', () => {
  it('shows an editable runtime default without creating an override on focus', async () => {
    const options = parseRuntimeHelp('--custom-limit N             custom limit (default: 32)');
    const save = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: [] }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--custom-limit');
    const input = option.getByRole('textbox');
    expect(input).toHaveValue('32');
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(save).not.toHaveBeenCalled();
    expect(option.queryByRole('button', { name: 'Save option' })).not.toBeInTheDocument();
    expect(option.queryByRole('button', { name: 'Set custom value' })).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: '64' } });
    fireEvent.click(option.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(options[0], [{ flag: '--custom-limit', values: ['64'] }]));
  });

  it('allows a flag without arguments to be selected directly from its inherited state', async () => {
    const options = parseRuntimeHelp('--custom-flag                 custom flag');
    const save = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: [] }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--custom-flag');
    const flag = option.getByRole('combobox', { name: '--custom-flag Flag 1' });
    expect(flag).not.toHaveTextContent('--custom-flag');
    fireEvent.click(flag);
    // The inherited entry and the flag are each offered once.
    expect(screen.getAllByRole('option').map(item => item.textContent)).toEqual([flag.textContent, '--custom-flag']);
    expect(screen.getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('option', { name: '--custom-flag' }));
    expect(flag).toHaveTextContent('--custom-flag');
    fireEvent.click(option.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(options[0], [{ flag: '--custom-flag', values: [] }]));
  });

  it('keeps a stored short flag selectable once alongside the long spellings', () => {
    const options = parseRuntimeHelp('-cb, --cont-batching, --no-cont-batching, -nocb             toggle');
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: ['-nocb'] }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={vi.fn()} onCategory={vi.fn()} /></I18nProvider>);
    const flag = openOption('--cont-batching').getByRole('combobox', { name: '--cont-batching Flag 1' });
    expect(flag).toHaveTextContent('-nocb');
    fireEvent.click(flag);
    const labels = screen.getAllByRole('option').map(item => item.textContent);
    expect(labels.filter(label => label === '-nocb')).toHaveLength(1);
    expect(labels).toEqual(expect.arrayContaining(['--cont-batching', '--no-cont-batching']));
    expect(labels).not.toContain('-cb');
    expect(screen.getByRole('option', { name: '-nocb' })).toHaveAttribute('aria-selected', 'true');
  });

  it('disables flag and suggestion comboboxes while editing is locked', () => {
    const [base] = parseRuntimeHelp('--cache-path FILE             cache file');
    const option = { ...base, choices: ['a.bin', 'b.bin'] };
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: ['--cache-path', 'a.bin'] }}
      runtime={{ options: [option], verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled rawDirty={false} onSave={vi.fn()} onCategory={vi.fn()} /></I18nProvider>);
    const editor = openOption('--cache-path');
    for (const combobox of editor.getAllByRole('combobox')) {
      expect(combobox).toBeDisabled();
      fireEvent.click(combobox);
    }
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('keeps a default input after removing the last occurrence and saves an empty override list', async () => {
    const options = parseRuntimeHelp('--custom-limit N             custom limit (default: 32)');
    const save = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: ['--custom-limit', '64'] }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--custom-limit');
    fireEvent.click(option.getByRole('button', { name: 'Add occurrence' }));
    expect(option.getAllByRole('textbox')).toHaveLength(2);
    fireEvent.change(option.getByRole('textbox', { name: '--custom-limit Argument 2.1' }), { target: { value: '128' } });
    fireEvent.click(option.getByRole('button', { name: '--custom-limit Remove occurrence 2' }));
    expect(option.getByRole('textbox')).toHaveValue('64');
    fireEvent.click(option.getByRole('button', { name: '--custom-limit Remove occurrence 1' }));
    expect(option.getByRole('textbox')).toHaveValue('32');
    expect(option.getByRole('textbox')).toBeEnabled();
    fireEvent.click(option.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(options[0], []));
  });

  it('formats runtime path suggestions and signatures while saving the original selected path', async () => {
    const raw = String.raw`\\?\UNC\server\models\cache.bin`;
    const display = String.raw`\\server\models\cache.bin`;
    const [base] = parseRuntimeHelp('--cache-path FILE             cache file');
    const option = { ...base, signature: `--cache-path FILE (default: ${raw})`, choices: [raw] };
    const save = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: ['--cache-path', 'old.bin'] }}
      runtime={{ options: [option], verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const editor = openOption('--cache-path');
    expect(container.textContent).toContain(`--cache-path FILE (default: ${display})`);
    expect(container.querySelector('select, datalist')).not.toBeInTheDocument();
    const input = editor.getByRole('combobox', { name: '--cache-path Argument 1.1' });
    expect(input).toHaveValue('old.bin');
    fireEvent.click(input);
    fireEvent.click(screen.getByRole('option', { name: display }));
    expect(input).toHaveValue(display);
    fireEvent.click(editor.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(option, [{ flag: '--cache-path', values: [raw] }]));
    expect(container.textContent).not.toContain('\\\\?\\');
    expect(document.body.textContent).not.toContain('\\\\?\\');
  });

  it('keeps typed text beyond suggested paths and maps a typed display path back to its raw value', async () => {
    const raw = String.raw`\\?\C:\models\cache.bin`;
    const display = String.raw`C:\models\cache.bin`;
    const [base] = parseRuntimeHelp('--cache-path FILE             cache file');
    const option = { ...base, choices: [raw] };
    const save = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: ['--cache-path', 'old.bin'] }}
      runtime={{ options: [option], verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const editor = openOption('--cache-path');
    const input = editor.getByRole('combobox', { name: '--cache-path Argument 1.1' });
    expect(input).toHaveAttribute('placeholder', 'FILE');
    expect(input).toHaveAttribute('spellcheck', 'false');
    fireEvent.change(input, { target: { value: String.raw`D:\My Models\other cache.bin` } });
    expect(input).toHaveValue(String.raw`D:\My Models\other cache.bin`);
    fireEvent.click(editor.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(option, [{ flag: '--cache-path', values: [String.raw`D:\My Models\other cache.bin`] }]));
    fireEvent.change(input, { target: { value: display } });
    fireEvent.click(editor.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenLastCalledWith(option, [{ flag: '--cache-path', values: [raw] }]));
    fireEvent.change(input, { target: { value: '' } });
    expect(editor.getByRole('button', { name: 'Save option' })).toBeDisabled();
    expect(editor.getByText('Enter every argument before saving.')).toBeInTheDocument();
  });

  it.each([
    [String.raw`\\?\C:\models\cache.bin`, String.raw`C:\models\cache.bin`],
    [String.raw`\\?\UNC\server\share\cache.bin`, String.raw`\\server\share\cache.bin`],
  ])('hides path prefixes in values, help and defaults while preserving untouched arguments: %s', async (raw, display) => {
    const options = parseRuntimeHelp(`--cache-path FILE             cache file (default: ${raw})`);
    const cfg = { ...testConfig, server_args: ['--cache-path', raw, '--cache-path', 'old.bin'] };
    const save = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={cfg}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--cache-path');
    const inputs = option.getAllByRole('textbox');
    expect(inputs[0]).toHaveValue(display);
    expect(container.textContent).toContain(display);
    expect(container.textContent).not.toContain("\\\\?\\");
    expect(save).not.toHaveBeenCalled();
    fireEvent.change(inputs[1], { target: { value: 'new.bin' } });
    fireEvent.click(option.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith(options[0], [
      { flag: '--cache-path', values: [raw] }, { flag: '--cache-path', values: ['new.bin'] },
    ]));
    expect(cfg.server_args[1]).toBe(raw);
  });

  it('hides raw and JSON-escaped paths in runtime diagnostics and save failures', async () => {
    const raw = String.raw`\\?\C:\runtime\server.exe`;
    const diagnostic = `Cannot load ${raw}`;
    const options = parseRuntimeHelp('--cache-path FILE             cache file');
    const { container } = render(<I18nProvider initialLocale="en"><TuningServerOptions
      cfg={{ ...testConfig, server_args: ['--cache-path', 'cache.bin'] }}
      runtime={{ options, verified: false, loading: false, refresh: vi.fn(), error: diagnostic, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={vi.fn().mockRejectedValue(new Error(JSON.stringify({ path: raw })))} onCategory={vi.fn()} /></I18nProvider>);
    expect(container.textContent).toContain(String.raw`Cannot load C:\runtime\server.exe`);
    const option = openOption('--cache-path');
    fireEvent.change(option.getByRole('textbox'), { target: { value: 'new.bin' } });
    fireEvent.click(option.getByRole('button', { name: 'Save option' }));
    const error = await option.findByRole('alert');
    expect(error.textContent).toContain(JSON.stringify({ path: String.raw`C:\runtime\server.exe` }));
    expect(container.textContent).not.toContain("\\\\?\\");
  });

  it('discovers a custom build option, saves mmap, and resets it without removing other settings', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--future-pr-option"]')).toBeInTheDocument());
    expect(document.querySelector('[data-server-option="--load-mode"]')).not.toBeInTheDocument();
    const mmap = openOption('--mmap');
    const inheritedLabel = mmap.getByRole('combobox').textContent;
    fireEvent.click(mmap.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: '--no-mmap' }));
    fireEvent.click(mmap.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1', '--no-mmap']));
    expect(mmap.getByRole('combobox')).toHaveTextContent('--no-mmap');
    fireEvent.click(mmap.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1']));
    expect(mmap.getByRole('combobox')).toHaveTextContent(inheritedLabel!);
    expect(mmap.queryByRole('button', { name: 'Set custom value' })).not.toBeInTheDocument();
  });
  it('starts overridden options expanded and keeps the reader\'s collapse across saves and resets', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--future-pr-option"]')).toBeInTheDocument());
    const details = (flag: string) => document.querySelector<HTMLDetailsElement>(`[data-server-option="${flag}"]`)!;
    expect(details('--cache-ram').open).toBe(true);
    expect(details('--mmap').open).toBe(false);
    details('--cache-ram').open = false;
    const mmap = openOption('--mmap');
    fireEvent.click(mmap.getByRole('combobox'));
    fireEvent.click(screen.getByRole('option', { name: '--no-mmap' }));
    fireEvent.click(mmap.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1', '--no-mmap']));
    fireEvent.click(mmap.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(cfg().server_args).toEqual(['--cache-ram', '-1']));
    expect(details('--cache-ram').open).toBe(false);
    expect(details('--mmap').open).toBe(true);
  });
  it('directs port changes to the API instead of editing a model worker port', () => {
    const navigate = vi.fn();
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={testConfig}
      runtime={{ options: parseRuntimeHelp(help), verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={vi.fn()} onCategory={vi.fn()} onNavigate={navigate} /></I18nProvider>);
    const port = openOption('--port');
    expect(port.queryByRole('textbox')).not.toBeInTheDocument();
    expect(port.getByText(/assigns a private port to each model/)).toBeInTheDocument();
    fireEvent.click(port.getByRole('button', { name: 'Open setting' }));
    expect(navigate).toHaveBeenCalledWith('api');
  });
  it('restores request inheritance when resetting a raw sampling override', async () => {
    const cfg = mount();
    fireEvent.click(screen.getByRole('button', { name: 'All server options' }));
    await waitFor(() => expect(document.querySelector('[data-server-option="--top-p"]')).toBeInTheDocument());
    const topP = openOption('--top-p');
    fireEvent.change(topP.getByRole('textbox'), { target: { value: '0.6' } });
    fireEvent.click(topP.getByRole('button', { name: 'Save option' }));
    await waitFor(() => expect(cfg().top_p).toBe(0.6));
    expect(cfg().runtime_defaults).not.toContain('top_p');
    fireEvent.click(topP.getByRole('button', { name: 'Reset to default' }));
    await waitFor(() => expect(cfg().runtime_defaults).toContain('top_p'));
    expect(cfg().server_args).toEqual(['--cache-ram', '-1']);
    expect(topP.getByRole('textbox')).toBeEnabled();
    expect(topP.queryByRole('button', { name: 'Save option' })).not.toBeInTheDocument();
  });
  it('displays server sampling overrides and prioritizes explicit request values', () => {
    const field = ADVANCED_SAMPLING_FIELDS.find(item => item.key === 'min_p')!;
    expect(chatOptionValue({ server_args: ['--min-p', '0.17'] }, field)).toBe(0.17);
    expect(chatOptionValue({ server_args: ['--min-p=0.17'], chat_options: { min_p: 0.1 } }, field)).toBe(0.1);
  });
  it('shows concrete documented defaults instead of bare inherited labels', () => {
    const options = parseRuntimeHelp('--custom-limit N             custom limit (default: 32)');
    const save = vi.fn().mockResolvedValue(undefined);
    const { container } = render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: [] }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--custom-limit');
    // Summary state and editor both name the source and the documented value.
    expect(container.textContent).toContain('32 (using runtime default)');
    expect(option.getAllByText('32 (using runtime default)')).toHaveLength(2);
    expect(container.textContent).not.toContain('Runtime default:');
  });
  it('qualifies reference defaults when the runtime is unverified', () => {
    const options = parseRuntimeHelp('--custom-limit N             custom limit (default: 32)');
    const save = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: [] }}
      runtime={{ options, verified: false, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={save} onCategory={vi.fn()} /></I18nProvider>);
    const option = openOption('--custom-limit');
    expect(option.getAllByText('using runtime default (Reference value: 32)')).toHaveLength(2);
    expect(option.queryByText('32 (using runtime default)')).not.toBeInTheDocument();
  });
  it.each([
    ['--ui, --webui, --no-webui, --no-ui', 'enabled', 'disabled', '--webui'],
    ['-cb, --cont-batching, --no-cont-batching, -nocb', 'disabled', 'enabled', '--no-cont-batching'],
  ])('shows the app-injected %s default only until a raw override is selected', (signature, runtimeValue, appValue, flag) => {
    const options = parseRuntimeHelp(`${signature}             toggle (default: ${runtimeValue})`);
    const view = (args: string[]) => <I18nProvider initialLocale="en"><TuningServerOptions cfg={{ ...testConfig, server_args: args }}
      runtime={{ options, verified: true, loading: false, refresh: vi.fn(), error: undefined, capabilities: undefined }}
      disabled={false} rawDirty={false} onSave={vi.fn()} onCategory={vi.fn()} /></I18nProvider>;
    const { container, rerender } = render(view([]));
    const state = () => container.querySelector('.server-option-state');
    expect(state()).toHaveTextContent(`${appValue} (using app default)`);
    rerender(view([flag]));
    expect(state()).not.toHaveTextContent('using app default');
    expect(state()).toHaveTextContent('Configured · 1');
  });
});
