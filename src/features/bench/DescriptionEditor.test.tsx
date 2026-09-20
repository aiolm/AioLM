import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DescriptionEditor, DescriptionPreview } from './DescriptionEditor';

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
