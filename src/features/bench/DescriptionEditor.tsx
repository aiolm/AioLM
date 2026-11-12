import { Suspense, lazy, useId, useMemo } from 'react';
import { DESCRIPTION_MAX_CODEPOINTS, countCodePoints } from '@aiolm/benchmark-contracts';
import { useI18n } from '../../shared/i18n/i18n';

const Markdown = lazy(() => import('react-markdown'));

const ALLOWED_ELEMENTS = ['p', 'ul', 'ol', 'li', 'a', 'code', 'pre', 'strong', 'em', 'blockquote'] as const;
type AllowedElement = (typeof ALLOWED_ELEMENTS)[number];
const allowedSet = new Set<string>(ALLOWED_ELEMENTS);

/** Only http(s) links; executable URLs never render as links. */
function urlTransform(url: string): string {
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) && !/\s/.test(trimmed)) return trimmed;
  return '#blocked';
}

const MARKDOWN_COMPONENTS = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  a: ({ href, children }: any) => {
    const safe = typeof href === 'string' ? urlTransform(href) : '#blocked';
    if (safe === '#blocked') return <span>{children}</span>;
    return <a href={safe} rel="noreferrer noopener" target="_blank">{children}</a>;
  },
};

export function DescriptionPreview({ text }: { text: string }) {
  const { t } = useI18n();
  const allowed = useMemo(() => [...allowedSet] as AllowedElement[], []);
  return (
    <Suspense fallback={<p role="status">{t('benchmark.descriptionLoading')}</p>}>
      <div className="performance-markdown-preview">
        <Markdown
          skipHtml
          allowedElements={allowed}
          unwrapDisallowed
          urlTransform={urlTransform}
          components={MARKDOWN_COMPONENTS}
        >
          {text || t('benchmark.descriptionEmpty')}
        </Markdown>
      </div>
    </Suspense>
  );
}

export function descriptionCodePoints(value: string): number {
  return countCodePoints(value);
}

export function DescriptionEditor({
  value, onChange, disabled, label, hint, countLabel, rows = 5,
}: {
  value: string; onChange: (value: string) => void; disabled?: boolean;
  label: string; hint: string; countLabel: (used: number, max: number) => string;
  rows?: number;
}) {
  const { t } = useI18n();
  const id = useId();
  const used = descriptionCodePoints(value);
  const over = used > DESCRIPTION_MAX_CODEPOINTS;
  return (
    <div className="performance-description">
      <label htmlFor={id}>
        <span>{label}</span>
        <textarea
          id={id}
          className="app-textarea"
          value={value}
          disabled={disabled}
          rows={rows}
          maxLength={12000}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={over}
          aria-describedby={`${id}-hint ${id}-count${over ? ` ${id}-error` : ''}`}
        />
      </label>
      <p id={`${id}-count`}>{countLabel(used, DESCRIPTION_MAX_CODEPOINTS)}</p>
      <p id={`${id}-hint`}>{hint}</p>
      {over && <p id={`${id}-error`} role="alert" className="performance-validation">{t('benchmark.descriptionTooLong', { max: DESCRIPTION_MAX_CODEPOINTS })}</p>}
      {value && !over && <DescriptionPreview text={value} />}
    </div>
  );
}
