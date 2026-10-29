// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { chatTitlePreview, displayChatTitle } from './chatThreadTitle';

afterEach(() => vi.unstubAllGlobals());

it('keeps ordinary and localized generated title previews unchanged', () => {
  const title = 'A complete conversation title that remains intact. '.repeat(10);
  expect(chatTitlePreview(title)).toBe(title);
  expect(chatTitlePreview('a'.repeat(1024))).toBe('a'.repeat(1024));
  expect(chatTitlePreview(displayChatTitle('New conversation', '새 대화'))).toBe('새 대화');
});

it.each(['😀', 'e\u0301', '👨‍👩‍👧‍👦', '🇰🇷', '\r\n'])('cuts before a %s grapheme that crosses the preview boundary', cluster => {
  const prefix = 'a'.repeat(1023);
  const title = `${prefix}${cluster}remaining title`;
  expect(chatTitlePreview(title)).toBe(`${prefix}…`);
});

it('retains a complete grapheme that fits exactly at the preview boundary', () => {
  const prefix = 'a'.repeat(1022);
  expect(chatTitlePreview(`${prefix}e\u0301remaining title`)).toBe(`${prefix}e\u0301…`);
});

it('does not split an oversized first grapheme to satisfy the display bound', () => {
  expect(chatTitlePreview(`a${'\u0301'.repeat(1500)}remaining title`)).toBe('…');
});

it('preserves the previous full display on a webview without grapheme segmentation', () => {
  vi.stubGlobal('Intl', Object.assign(Object.create(Intl), { Segmenter: undefined }));
  const title = `Full title ${'long '.repeat(300)}👨‍👩‍👧‍👦`;
  expect(chatTitlePreview(title)).toBe(title);
});
