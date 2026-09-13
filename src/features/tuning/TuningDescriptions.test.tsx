import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { I18nProvider, translate, useI18n, type Locale } from '../../shared/i18n/i18n';
import { tuningHelp } from '../../shared/i18n/tuningHelp';
import { createTestStore, testConfig } from '../../testing/appStore';
import NumericFieldGrid from './NumericFieldGrid';
import TuningChatOptionField from './TuningChatOptionField';
import TuningSamplerChain from './TuningSamplerChain';
import TuningPanel from './Tuning';
import {
  ADVANCED_SAMPLING_FIELDS, MTP_FIELDS, REASONING_FIELDS, SAMPLING_FIELDS, SERVER_FIELDS,
  TUNING_FIELD_CATALOG, tuningFieldDescription, tuningFieldLabel,
} from './tuningFields';

const locales = ['en', 'ko', 'ja', 'zh'] as const;
const numericFields = [...SERVER_FIELDS, ...MTP_FIELDS, ...REASONING_FIELDS, ...SAMPLING_FIELDS];

function NumericAndRequestFields({ numeric = numericFields, request = ADVANCED_SAMPLING_FIELDS }: {
  numeric?: typeof numericFields; request?: typeof ADVANCED_SAMPLING_FIELDS;
}) {
  const { t, setLocale } = useI18n();
  return <>
    <button onClick={() => setLocale('ko')}>한국어</button>
    <NumericFieldGrid fields={numeric} cfg={testConfig} drafts={{}} disabled={false} onChange={vi.fn()} onCommit={vi.fn()} />
    {request.map(field => <TuningChatOptionField key={field.key} cfg={testConfig} field={field} t={t}
      disabled={false} chatOptionDrafts={{}} setChatOptionDrafts={vi.fn()} chatOptionSelectModes={{}}
      setChatOptionSelectModes={vi.fn()} onCommit={vi.fn()} />)}
  </>;
}

describe('localized tuning explanations', () => {
  const groups = [
    { group: 'server', numeric: SERVER_FIELDS, request: [] },
    { group: 'draft', numeric: MTP_FIELDS, request: [] },
    { group: 'reasoning', numeric: REASONING_FIELDS, request: [] },
    { group: 'sampling', numeric: SAMPLING_FIELDS, request: [] },
    { group: 'request', numeric: [], request: ADVANCED_SAMPLING_FIELDS },
  ];
  it.each(locales.flatMap(locale => groups.map(group => ({ ...group, locale }))))(
    'shows each $group explanation below its control in $locale', ({ locale, numeric, request }) => {
    render(<I18nProvider initialLocale={locale}><NumericAndRequestFields numeric={numeric} request={request} /></I18nProvider>);
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    for (const field of [...numeric, ...request]) {
      const description = tuningFieldDescription(t, field);
      const help = screen.getByText(description);
      const control = within(help.parentElement!).getByRole('options' in field && field.options ? 'combobox' : 'spinbutton', { name: tuningFieldLabel(t, field) });
      expect(help).toBeVisible();
      expect(control).toHaveAccessibleDescription(description);
      expect(control.compareDocumentPosition(help) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it.each(['ko', 'ja', 'zh'] as const)('has local prose for every catalog field in %s', locale => {
    const script = locale === 'ko' ? /[가-힣]/ : locale === 'ja' ? /[ぁ-ヿ]/ : /[一-鿿]/;
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    for (const field of TUNING_FIELD_CATALOG) expect(tuningFieldDescription(t, field), field.key).toMatch(script);
  });

  it('keeps the setting explanation accessible alongside a numeric validation error', () => {
    const field = SERVER_FIELDS[0];
    render(<I18nProvider initialLocale="ko"><NumericFieldGrid fields={[field]} cfg={testConfig}
      drafts={{ ngl: '129' }} disabled={false} onChange={vi.fn()} onCommit={vi.fn()} /></I18nProvider>);
    const description = tuningFieldDescription(key => translate('ko', key), field);
    expect(screen.getByText(description)).toBeVisible();
    expect(screen.getByRole('spinbutton')).toHaveAccessibleDescription(`${description} ${screen.getByRole('alert').textContent}`);
  });

  it('updates visible explanations when the selected language changes without changing input values', () => {
    render(<I18nProvider initialLocale="en"><NumericAndRequestFields /></I18nProvider>);
    expect(screen.getByRole('spinbutton', { name: 'GPU layers (ngl)' })).toHaveValue(testConfig.ngl);
    fireEvent.click(screen.getByRole('button', { name: '한국어' }));
    const input = screen.getByRole('spinbutton', { name: 'GPU 레이어 (ngl)' });
    expect(input).toHaveValue(testConfig.ngl);
    expect(input).toHaveAccessibleDescription(/선택한 GPU/);
    expect(screen.queryByText(/Number of model layers offloaded/)).not.toBeInTheDocument();
  });

  it.each(locales)('keeps runtime, reasoning, and sidecar explanations visible in %s', locale => {
    render(<I18nProvider initialLocale={locale}><TuningPanel store={createTestStore()} /></I18nProvider>);
    expect(document.querySelector('#tuning-flash-attn')).toHaveAccessibleDescription(tuningHelp[locale].flashAttention);
    expect(screen.getByText(tuningHelp[locale].flashAttention)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '--reasoning-format' } });
    const reasoning = document.querySelector('#tuning-reasoning-format')!;
    expect(reasoning).toHaveAccessibleDescription(tuningHelp[locale].reasoningFormat);
    expect(screen.getByText(tuningHelp[locale].reasoningFormat)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '--spec-draft-model' } });
    expect(document.querySelector('#tuning-spec-draft-model')).toHaveAccessibleDescription(tuningHelp[locale].specDraftModel);
    expect(screen.getByText(tuningHelp[locale].specDraftModel)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '--mmproj' } });
    expect(document.querySelector('#tuning-mmproj')).toHaveAccessibleDescription(tuningHelp[locale].projector);
    expect(screen.getByText(tuningHelp[locale].projector)).toBeVisible();
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it.each(locales)('labels sampler actions and describes the chain below its controls in %s', (locale: Locale) => {
    const changed = vi.fn();
    render(<I18nProvider initialLocale={locale}><TuningSamplerChain value={['top_k', 'top_p']} onChange={changed} /></I18nProvider>);
    const description = screen.getByText(tuningHelp[locale].samplerChain);
    expect(description).toBeVisible();
    const list = screen.getByRole('list');
    expect(list).toHaveAccessibleDescription(description.textContent!);
    expect(list.compareDocumentPosition(description) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: tuningHelp[locale].moveSamplerEarlier.replace('{name}', 'top_p') }));
    expect(changed).toHaveBeenCalledWith(['top_p', 'top_k']);
  });
});
