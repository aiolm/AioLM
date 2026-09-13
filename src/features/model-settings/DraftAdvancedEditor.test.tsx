import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
];

function mount(locale: Locale = 'en', benchmark = false) {
  const onChange = vi.fn();
  function LocaleControl() {
    const { setLocale } = useI18n();
    return <button onClick={() => setLocale('ko')}>Switch language</button>;
  }
  render(<I18nProvider initialLocale={locale}><LocaleControl /><DraftAdvancedEditor cfg={{ ...testConfig, server_args: [], chat_options: {} }} options={options} disabled={false} benchmark={benchmark} onChange={onChange} onInvalid={vi.fn()} /></I18nProvider>);
  return { onChange };
}

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

  it('keeps request JSON hidden in benchmark settings', () => {
    mount('en', true);
    expect(document.querySelectorAll('textarea')).toHaveLength(1);
    expect(screen.queryByText(advancedSettingsHelp.en.chat)).not.toBeInTheDocument();
    expect(screen.getByText(advancedSettingsHelp.en.args)).toBeVisible();
  });
});
