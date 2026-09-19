import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider } from '../../shared/i18n/i18n';
import { parseRuntimeHelp } from '../../shared/config/serverOptions';
import { testConfig } from '../../testing/appStore';
import TuningDefaultField, { TuningDefaultsContext } from './TuningDefaultField';
import TuningOptionMetadata, { TuningOptionsContext, ServerOptionDefault } from './TuningOptionMetadata';

describe('visible setting defaults', () => {
  it('explains genuine automatic defaults while preserving the llama.cpp option value', () => {
    const options = parseRuntimeHelp("--flash-attn [on|off|auto]          attention (default: 'auto')");
    render(<I18nProvider initialLocale="ko"><ServerOptionDefault option={options[0]} options={options} verified /></I18nProvider>);
    expect(screen.getByText("'auto'")).toBeVisible();
    expect(screen.getByText('자동 선택 · 실제 값은 실행 환경에 따라 결정됩니다.')).toBeVisible();
  });
  it('keeps inherited controls editable alongside their default and CLI/JSON names', () => {
    const runtime = { options: parseRuntimeHelp('--min-p N           minimum (default: 0.12)'), verified: true };
    render(<I18nProvider initialLocale="ko"><TuningOptionsContext.Provider value={runtime}>
      <TuningDefaultsContext.Provider value={{ cfg: { ...testConfig, chat_options: {}, server_args: [] }, disabled: false, reset: vi.fn() }}>
        <TuningDefaultField fieldKey="min_p" label="Min-p" request><input aria-label="Min-p" defaultValue="0.12" /></TuningDefaultField>
      </TuningDefaultsContext.Provider>
    </TuningOptionsContext.Provider></I18nProvider>);
    // Everything a setting is described by is on one line: the command-line form,
    // the request key, the default and where it came from. Nothing is behind a
    // disclosure, because a panel that has to be opened may as well not be read.
    expect(screen.getByText('--min-p N')).toBeVisible();
    expect(screen.getByText('min_p')).toBeVisible();
    expect(screen.getByText('0.12')).toBeVisible();
    expect(screen.queryByText('기술 정보')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /직접 설정/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Min-p.*기본값/ })).toBeEnabled();
    expect(screen.getByRole('textbox')).toHaveValue('0.12');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '0.2' } });
    expect(screen.getByRole('textbox')).toHaveValue('0.2');
    expect(screen.getByText('0.12')).toBeVisible();
  });
  it('updates defaults after switching runtime and labels fallback reference values', () => {
    const view = (help: string, verified = true) => <I18nProvider initialLocale="en"><TuningOptionsContext.Provider value={{ options: parseRuntimeHelp(help), verified }}><TuningOptionMetadata fieldKey="top_p" /></TuningOptionsContext.Provider></I18nProvider>;
    const { rerender } = render(view('--top-p N         probability (default: 0.7)'));
    expect(screen.getByText('0.7')).toBeVisible();
    rerender(view('--top-p N         probability (default: 0.9)'));
    expect(screen.getByText('0.9')).toBeVisible();
    expect(screen.queryByText('0.7')).not.toBeInTheDocument();
    rerender(view('', false));
    // Where a default came from is one word beside it, and a linked one at that:
    // it took opening a panel to learn whose number was on screen.
    expect(screen.getByRole('link', { name: 'Reference value' })).toBeVisible();
  });

  it('shows the whole documented default rather than a scalar with its conditions hidden', () => {
    const options = parseRuntimeHelp('--min-p N          minimum (default: 0.05, 0.0 = disabled)');
    const reset = vi.fn();
    render(<I18nProvider initialLocale="ko"><TuningOptionsContext.Provider value={{ options, verified: true }}>
      <TuningDefaultsContext.Provider value={{ cfg: { ...testConfig, chat_options: {}, server_args: [] }, disabled: false, reset }}>
        <TuningDefaultField fieldKey="min_p" label="Min-p" request><input aria-label="Min-p" defaultValue="0.05" /></TuningDefaultField>
      </TuningDefaultsContext.Provider>
    </TuningOptionsContext.Provider></I18nProvider>);
    // The scalar and the rule that qualifies it were shown twice, once compact
    // outside and once in full inside; the full form says both at once.
    expect(screen.getByText('0.05, 0.0 = 사용 안 함')).toBeVisible();
    expect(screen.queryByText('0.05')).not.toBeInTheDocument();
    expect(screen.getByText('사용 중')).toBeVisible();
    expect(screen.getByText('런타임')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: /Min-p.*기본값/ }));
    expect(reset).toHaveBeenCalledWith('min_p');
  });
  it('shows the default even when a full-catalog entry is collapsed', () => {
    const options = parseRuntimeHelp('--cache-ram N          cache (default: 8192, -1 = unlimited)');
    render(<I18nProvider initialLocale="ko"><details><summary>{options[0].signature}<ServerOptionDefault option={options[0]} options={options} verified /></summary><input /></details></I18nProvider>);
    expect(within(document.querySelector('summary')!).getByText('8192, -1 = 제한 없음')).toBeVisible();
    expect(screen.getByText('선택한 런타임 기준')).toBeVisible();
  });
  it('offers no disclosure when everything it would hold is already on screen', () => {
    // With the command-line form and the source moved out, most settings have
    // nothing left inside, and a panel that opens onto nothing is worse than none.
    const options = parseRuntimeHelp('--threads N          threads (default: 8)');
    render(<I18nProvider initialLocale="en"><TuningOptionsContext.Provider value={{ options, verified: true }}>
      <TuningOptionMetadata fieldKey="threads" />
    </TuningOptionsContext.Provider></I18nProvider>);
    expect(screen.getByText('--threads N')).toBeVisible();
    expect(screen.getByText('Runtime')).toBeVisible();
    expect(screen.queryByText('Technical details')).not.toBeInTheDocument();
  });
});
