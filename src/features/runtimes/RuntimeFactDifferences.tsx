import { useId } from 'react';
import type { FactConflict, MetadataView } from '../../shared/api/runtimeHelp';
import { useI18n } from '../../shared/i18n/i18n';
import { runtimeOptionsCopy } from '../../shared/i18n/runtimeOptionsCopy';
import FeedbackBanner from '../../shared/ui/FeedbackBanner';

type Copy = (typeof runtimeOptionsCopy)['en'];

function shown(value: unknown): string {
  if (value === null || value === undefined) return '—';
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function fieldLabel(field: string, copy: Copy): string {
  const label = (copy as Record<string, string>)[`field_${field}`];
  return label ?? field;
}

/** Declared option facts that differ from the reviewed help, with the
 * declaration's provenance, which side the schema uses and whether a saved
 * value is refused. Shown at help review, registration and in settings. */
export default function RuntimeFactDifferences({ conflicts = [], metadata }: {
  conflicts?: FactConflict[];
  metadata?: MetadataView | null;
}) {
  const { locale } = useI18n();
  const copy = runtimeOptionsCopy[locale];
  const id = useId();
  const all = [...conflicts, ...(metadata?.conflicts ?? [])];
  const describe = metadata && (!metadata.builtin || metadata.error);
  if (!describe && all.length === 0) return null;
  return (
    <section className="mt-3" aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{copy.differencesTitle}</h4>
      {describe && (
        <p>
          {copy.metadataFrom}: {copy.sourceAdapter} {metadata.adapter} ({metadata.revision})
          {metadata.builtin ? ` · ${copy.builtinMetadata}` : ''} · {metadata.applied.length} {copy.metadataApplied}
        </p>
      )}
      {metadata?.error && <FeedbackBanner tone="warning">{metadata.error}</FeedbackBanner>}
      {all.length > 0 && <p className="app-section-hint">{copy.differencesHint}</p>}
      {all.length > 0 && (
        <ul>
          {all.map((conflict, index) => (
            <li key={`${conflict.flag}:${conflict.field}:${index}`}>
              <code>{conflict.flag || conflict.key}</code>
              {` · ${fieldLabel(conflict.field, copy)} · ${copy.sourceHelp}: ${shown(conflict.observed)} · ${conflict.declared_by}: ${shown(conflict.declared)} · `}
              {conflict.applies === 'observed' ? copy.appliesObserved : copy.appliesDeclared}
              {conflict.blocking && ` · ${copy.blocksLaunch}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
