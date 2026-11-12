import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanup, render as renderView, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { I18nProvider, loadLocale } from '../../shared/i18n/i18n';
import { DescriptionEditor, DescriptionPreview } from './DescriptionEditor';
import { defined } from '../../testing/assertDefined';

const English = ({ children }: { children: ReactNode }) => <I18nProvider initialLocale="en">{children}</I18nProvider>;
const render = (ui: ReactElement) => renderView(ui, { wrapper: English });

// These checks cover rendered content policy. Load the lazy renderer before
// assertions so coverage instrumentation does not consume their DOM wait budget.
beforeAll(async () => { await import('react-markdown'); });

afterEach(() => { cleanup(); });

describe('description renderer policy', () => {
  it('renders code fences as literal code without script elements', async () => {
    const fence = '```';
    render(<DescriptionPreview text={`${fence}html\n<script>alert(1)</script>\n${fence}`} />);
    const code = await screen.findByText(/alert\(1\)/);
    expect(code.closest('pre')).not.toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('links https autolinks and suppresses executable URLs', async () => {
    render(<DescriptionPreview text={'See <https://example.test/run/1> and [x](javascript:alert(1)).'} />);
    const link = await screen.findByRole('link', { name: 'https://example.test/run/1' });
    expect(link.getAttribute('href')).toBe('https://example.test/run/1');
    expect(link.getAttribute('rel')).toContain('noopener');
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('suppresses inline, reference, and code-shown images without an img element', async () => {
    render(
      <DescriptionPreview
        text={'![alt](https://example.test/x.png)\n\n![ref][1]\n\n[1]: https://example.test/y.png\n\n`![code](https://example.test/z.png)`'}
      />,
    );
    await screen.findByText(/z\.png/);
    expect(document.querySelector('img')).toBeNull();
  });

  it('skips raw HTML while keeping surrounding text', async () => {
    render(<DescriptionPreview text={'<b>bold</b> and <script>alert(1)</script> plain.'} />);
    await screen.findByText(/plain\./);
    expect(document.querySelector('b')).toBeNull();
    expect(document.querySelector('script')).toBeNull();
  });

  it('counts codepoints and blocks preview when over 4000 characters', () => {
    render(
      <DescriptionEditor
        value={'x'.repeat(4001)}
        onChange={() => undefined}
        label="Description"
        hint="Hint"
        countLabel={(used, max) => `${used} / ${max}`}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('exceeds 4000');
    expect(screen.getByText('4001 / 4000')).toBeInTheDocument();
  });
});

describe('description field guidance', () => {
  it('connects visible labels, hints and errors without announcing every character count', () => {
    render(<DescriptionEditor value={'x'.repeat(4001)} onChange={() => undefined} label="Description" hint="Explain the setup" countLabel={(used, max) => `${used} / ${max}`} />);
    const field = screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Description' });
    expect(field.labels?.[0]?.textContent).toContain('Description');
    const ids = field.getAttribute('aria-describedby')!.split(' ');
    expect(ids.map(id => document.getElementById(id)?.textContent)).toEqual(['Explain the setup', '4001 / 4000', 'Description exceeds 4000 characters.']);
    expect(document.getElementById(defined(ids[1]))?.getAttribute('role')).toBeNull();
  });
  it('keeps descriptions separate when two result editors are displayed', () => {
    render(<><DescriptionEditor value="" onChange={() => undefined} label="First" hint="First setup" countLabel={() => 'First count'} /><DescriptionEditor value="" onChange={() => undefined} label="Second" hint="Second setup" countLabel={() => 'Second count'} /></>);
    const fields = screen.getAllByRole('textbox');
    const first = defined(fields[0]);
    const second = defined(fields[1]);
    expect(first.id).not.toBe(second.id);
    expect(document.getElementById(defined(defined(first.getAttribute('aria-describedby')).split(' ')[0]))?.textContent).toBe('First setup');
    expect(document.getElementById(defined(defined(second.getAttribute('aria-describedby')).split(' ')[0]))?.textContent).toBe('Second setup');
  });
});

describe('localized description guidance', () => {
  it('renders the Korean empty preview without changing Markdown policy', async () => {
    await loadLocale('ko');
    renderView(<I18nProvider initialLocale="ko"><DescriptionPreview text="" /></I18nProvider>);
    expect(await screen.findByText('설명이 없습니다.')).toBeInTheDocument();
  });

  it('localizes the limit error while keeping it associated with the field', async () => {
    await loadLocale('ko');
    renderView(<I18nProvider initialLocale="ko"><DescriptionEditor value={'x'.repeat(4001)} onChange={() => undefined} label="설명" hint="설정 안내" countLabel={(used, max) => `${used} / ${max}`} /></I18nProvider>);
    const field = screen.getByRole('textbox', { name: '설명' });
    const error = screen.getByRole('alert');
    expect(error).toHaveTextContent('설명이 4000자를 초과했습니다.');
    expect(field.getAttribute('aria-describedby')?.split(' ')).toContain(error.id);
  });
});