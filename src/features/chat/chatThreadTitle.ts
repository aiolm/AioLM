// Keep the stored generated title stable so draft reuse and first-message
// naming continue to work when the interface language changes.
export function isGeneratedChatTitle(title: string | undefined): boolean {
  return !title || title === 'New conversation';
}

export function displayChatTitle(title: string | undefined, fallback: string): string {
  return isGeneratedChatTitle(title) ? fallback : title ?? fallback;
}

const PREVIEW_CODE_UNITS = 1024;
type GraphemeSegmenter = new (locale?: string, options?: { granularity: 'grapheme' }) => {
  segment: (text: string) => Iterable<{ index: number; segment: string }>;
};

/** Limit shaping work for pathological titles; storage, editing and search retain the full text. */
export function chatTitlePreview(title: string): string {
  if (title.length <= PREVIEW_CODE_UNITS) return title;
  const Segmenter = (Intl as typeof Intl & { Segmenter?: GraphemeSegmenter }).Segmenter;
  // Older webviews keep their existing display rather than splitting a Unicode cluster.
  if (typeof Segmenter !== 'function') return title;
  let end = 0;
  for (const { index, segment } of new Segmenter(undefined, { granularity: 'grapheme' }).segment(title)) {
    const next = index + segment.length;
    if (next > PREVIEW_CODE_UNITS) return `${title.slice(0, end)}…`;
    end = next;
  }
  return title;
}
