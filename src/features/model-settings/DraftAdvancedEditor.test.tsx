import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { I18nProvider, useI18n, type Locale } from '../../shared/i18n/i18n';
import { describeServerOption } from '../../shared/config/serverOptions';
import { testConfig } from '../../testing/appStore';
import DraftAdvancedEditor from './DraftAdvancedEditor';
import { advancedSettingsHelp } from './advancedSettingsHelp';
import { serverOptionDescription } from '../../shared/i18n/serverOptionDescriptions';

const options = [
  describeServerOption('--repeat-penalty N', 'Penalize repeated tokens.')!,
  describeServerOption('--mlock', 'Keep model weights in RAM.')!,
  describeServerOption('--custom-mode VALUE', 'Use the named processing mode.')!,
  describeServerOption('--custom-pair START END')!,
  // Verbatim shape from llama-server --help: the values live in the body.
  describeServerOption('-lm, --load-mode MODE', 'model loading mode (default: auto)\n- auto: mmap, unless a device does not support it\n- none: no special loading mode\n- mmap: memory-map model\n- mlock: keep the model in RAM\n- mmap+mlock: both of the above\n- dio: use DirectIO if available')!,
];

function mount(locale: Locale = 'en', benchmark = false, server_args: string[] = []) {
  const onChange = vi.fn();
  const onInvalid = vi.fn();
  function LocaleControl() {
    const { setLocale } = useI18n();
    return <button onClick={() => setLocale('ko')}>Switch language</button>;
  }
  render(<I18nProvider initialLocale={locale}><LocaleControl /><DraftAdvancedEditor cfg={{ ...testConfig, server_args, chat_options: {} }} options={options} disabled={false} benchmark={benchmark} onChange={onChange} onInvalid={onInvalid} /></I18nProvider>);
  return { onChange, onInvalid };
}

/** A runtime reports around 255 options; this stands in for that scale. */
const manyOptions = Array.from({ length: 120 }, (_, index) =>
  describeServerOption(`--generated-${index} N`, `Generated option ${index}.`)!);

describe('advanced options list size', () => {
  it('puts a bounded number of rows on screen and says how many matched', () => {
    // Every option rendered at once built a subtree of several thousand nodes
    // that stayed mounted, and the browser re-ran layout over all of it on each
    // keystroke and focus change. The search field is how the rest are reached.
    render(<I18nProvider initialLocale="en"><DraftAdvancedEditor cfg={{ ...testConfig, server_args: [], chat_options: {} }}
      options={manyOptions} disabled={false} benchmark={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    const rows = document.querySelectorAll('.model-settings-option');
    expect(rows.length).toBeLessThan(manyOptions.length);
    expect(screen.getByText(/Showing \d+ of 120 matching options/)).toBeVisible();
  });

  it('shows every match once the search narrows them below the bound', async () => {
    render(<I18nProvider initialLocale="en"><DraftAdvancedEditor cfg={{ ...testConfig, server_args: [], chat_options: {} }}
      options={manyOptions} disabled={false} benchmark={false} onChange={vi.fn()} onInvalid={vi.fn()} /></I18nProvider>);
    fireEvent.change(screen.getByLabelText('Search runtime options'), { target: { value: 'generated-11' } });
    await waitFor(() => expect(screen.queryByText(/Showing \d+ of/)).not.toBeInTheDocument());
    expect(document.querySelectorAll('.model-settings-option').length).toBeGreaterThan(0);
  });
});

describe('advanced settings explanations', () => {
  it.each<Locale>(['en', 'ko', 'ja', 'zh'])('associates raw editors with format and precedence help in %s', locale => {
    mount(locale);
    const [args, chat] = screen.getAllByRole('textbox');
    expect(args).toHaveAccessibleDescription(advancedSettingsHelp[locale].args);
    expect(chat).toHaveAccessibleDescription(advancedSettingsHelp[locale].chat);
    expect(screen.getByText(advancedSettingsHelp[locale].args)).toBeVisible();
    expect(screen.getByText(advancedSettingsHelp[locale].chat)).toBeVisible();
    expect(screen.getByRole('searchbox')).toHaveAccessibleDescription(advancedSettingsHelp[locale].search);
  });

  it('shows option descriptions before expanding controls and explains omitted defaults', () => {
    mount();
    const description = screen.getByText('Keep model weights in RAM.');
    const card = description.closest('.model-settings-option')!;
    expect(description).toBeVisible();
    expect(card.querySelector('details')).not.toHaveAttribute('open');
    fireEvent.click(card.querySelector('summary')!);
    const checkbox = screen.getByRole('checkbox', { name: '--mlock Enabled' });
    expect(checkbox).toHaveAccessibleDescription(`Keep model weights in RAM. ${advancedSettingsHelp.en.toggle}`);
    fireEvent.click(checkbox);
  });

  it('uses localized descriptions in option search without duplicating runtime English prose', () => {
    mount('ko');
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '반복' } });
    const option = screen.getByText('--repeat-penalty');
    const summary = option.closest('summary')!;
    expect(option.closest('.model-settings-option')!.textContent).toMatch(/반복/);
    expect(screen.queryByText('--mlock')).not.toBeInTheDocument();
    fireEvent.click(summary);
    expect(screen.queryByText('Penalize repeated tokens.')).not.toBeInTheDocument();
  });

  it('keeps custom runtime options explained when help text is absent', () => {
    mount();
    const missing = serverOptionDescription(options[3], 'en');
    const description = screen.getByText(missing);
    expect(description).toBeVisible();
    fireEvent.click(description.closest('.model-settings-option')!.querySelector('summary')!);
    expect(screen.getByRole('textbox', { name: '--custom-pair START END' })).toHaveAccessibleDescription(`${missing} ${advancedSettingsHelp.en.multiple}`);
  });

  it.each<Locale>(['ko', 'ja', 'zh'])('localizes known and unregistered option help in %s', locale => {
    mount(locale);
    expect(screen.getByText(serverOptionDescription(options[1], locale))).toBeVisible();
    expect(screen.queryByText('Keep model weights in RAM.')).not.toBeInTheDocument();
    expect(screen.queryByText('Use the named processing mode.')).not.toBeInTheDocument();
    const custom = screen.getByText('--custom-mode').closest('.model-settings-option')!;
    expect(custom.textContent).toContain(serverOptionDescription(options[2], locale));
  });

  it('updates explanation language immediately without resetting edited values', () => {
    mount();
    const description = screen.getByText('Keep model weights in RAM.');
    fireEvent.click(description.closest('.model-settings-option')!.querySelector('summary')!);
    fireEvent.change(screen.getByLabelText('Extra request JSON'), { target: { value: '{"min_p":0.15}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }));
    expect(screen.queryByText('Keep model weights in RAM.')).not.toBeInTheDocument();
    expect(screen.getByText(serverOptionDescription(options[1], 'ko'))).toBeVisible();
    expect(screen.getByLabelText('추가 요청 JSON')).toHaveValue('{"min_p":0.15}');
  });

  it('prompts for the value alone and suggests the modes --load-mode documents in prose', () => {
    const { onChange } = mount('ko');
    const card = screen.getByText('--load-mode').closest('.model-settings-option')!;
    fireEvent.click(card.querySelector('summary')!);
    const input = screen.getByRole('combobox', { name: '-lm, --load-mode MODE' });
    // The flag belongs to the app, so the box asks for MODE and never for "--load-mode none".
    expect(input).toHaveAttribute('placeholder', 'MODE');
    expect(Array.from(card.querySelectorAll('datalist option'), item => item.getAttribute('value')))
      .toEqual(['auto', 'none', 'mmap', 'mlock', 'mmap+mlock', 'dio']);
    expect(input).toHaveAccessibleDescription(expect.stringContaining(advancedSettingsHelp.ko.single));
    fireEvent.change(input, { target: { value: 'none' } });
    expect(onChange).toHaveBeenLastCalledWith({ server_args: ['--load-mode', 'none'] });
  });

  it('shows a saved flag and its value on one raw line and splits an edited line back into argv', () => {
    const { onChange, onInvalid } = mount('en', false, ['--jinja', '--load-mode', 'none']);
    const [args] = screen.getAllByRole('textbox');
    expect(args).toHaveValue('--jinja\n--load-mode none');
    // Everything after the flag is one value, so a path keeps its spaces.
    fireEvent.change(args, { target: { value: String.raw`--load-mode mmap` + '\n--custom-mode C:\\My Models\\x' } });
    expect(onChange).toHaveBeenLastCalledWith({ server_args: ['--load-mode', 'mmap', '--custom-mode', String.raw`C:\My Models\x`] });
    fireEvent.change(args, { target: { value: '--load-mode' } });
    expect(onInvalid).toHaveBeenLastCalledWith('server_args', true);
  });

  it('keeps request JSON hidden in benchmark settings', () => {
    mount('en', true);
    expect(document.querySelectorAll('textarea')).toHaveLength(1);
    expect(screen.queryByText(advancedSettingsHelp.en.chat)).not.toBeInTheDocument();
    expect(screen.getByText(advancedSettingsHelp.en.args)).toBeVisible();
  });
});
